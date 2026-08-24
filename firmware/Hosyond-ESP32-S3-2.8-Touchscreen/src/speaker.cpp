#include "speaker.h"

#if __has_include("controller_config.h")
#include "controller_config.h"
#else
#include "controller_config.example.h"
#endif

// ---------------------------------------------------------------------------------------------
// Tunables, defaulted here as well as documented in include/controller_config.example.h.
//
// They are #ifndef'd rather than simply read, because controller_config.h is a per-unit file that
// is copied from the example ONCE and then kept out of git. Somebody who copied it before the
// speaker existed still has to be able to build this, and finding out otherwise via a wall of
// "undeclared identifier" is a bad way to learn that a header gained a section.
// ---------------------------------------------------------------------------------------------

#ifndef ENABLE_SPEAKER
#define ENABLE_SPEAKER 0
#endif

// How many requests can be outstanding. Small on purpose: the queue is a smoothing buffer for two
// taps landing in the same frame, not a playlist. A deep queue would let a flurry of taps turn
// into ten seconds of beeping long after the flurry ended.
#ifndef SPEAKER_QUEUE_DEPTH
#define SPEAKER_QUEUE_DEPTH 3
#endif

#ifndef SPEAKER_TASK_STACK
#define SPEAKER_TASK_STACK 4096
#endif

// Above the Arduino loop task (1) so a cue is not starved by the UI, far below the Wi-Fi tasks
// (~22) so it never delays the radio.
#ifndef SPEAKER_TASK_PRIORITY
#define SPEAKER_TASK_PRIORITY 4
#endif

// Silence written after the amplifier is enabled and before the first tone. Covers the FM8002E
// coming out of shutdown with a settled, zero-valued DAC in front of it. The datasheet
// (docs/…/4-数据手册_DataSheet/FM8002E.pdf) is the place to tighten this if the leading click
// turns out to need more or less; 12 ms is a guess biased towards "no pop".
#ifndef SPEAKER_PA_SETTLE_MS
#define SPEAKER_PA_SETTLE_MS 12
#endif

// Silence written after the last tone and before the amplifier is cut. Skipped on an abort.
#ifndef SPEAKER_PA_TAIL_MS
#define SPEAKER_PA_TAIL_MS 8
#endif

// Ceiling on one i2s_channel_write. Blocks the playback task only, never a caller. If the DMA ring
// has not drained in this long something is wrong with the clock, and giving up beats hanging the
// task forever with the amplifier powered.
#ifndef SPEAKER_WRITE_TIMEOUT_MS
#define SPEAKER_WRITE_TIMEOUT_MS 250
#endif

// The private copy speakerPlayPcm() takes of a caller's clip, in mono samples. 16000 = 1 s at
// 16 kHz = 32 KB, from PSRAM. Cues need none of this; it exists so a future gateway-supplied TTS
// reply has somewhere to land, and so the bench can play a recording back.
#ifndef SPEAKER_PCM_STAGE_SAMPLES
#define SPEAKER_PCM_STAGE_SAMPLES 16000
#endif

// The speaker rides on the capture path's I2S channels and the capture path's ES8311, so it cannot
// exist without them. Asking for ENABLE_SPEAKER=1 in a build with no audio is a configuration
// mistake rather than a half-working feature, and it is caught here rather than at link time.
#if ENABLE_SPEAKER && !ENABLE_AUDIO_CAPTURE
#error "ENABLE_SPEAKER=1 requires ENABLE_AUDIO_CAPTURE=1: the I2S channels and the ES8311 are brought up by src/audio.cpp."
#endif

#if ENABLE_SPEAKER

#include <atomic>
#include <math.h>

#include "freertos/FreeRTOS.h"
#include "freertos/queue.h"
#include "freertos/task.h"

#include "audio_bus.h"
#include "es8311.h"

namespace {

// ---------------------------------------------------------------------------------------------
// The cue vocabulary.
//
// Each cue is a short sequence of segments. A segment is one sine tone, or silence when freqHz is
// 0. Everything is synthesised on the fly rather than stored: the whole table below is 120 bytes,
// where the same sounds as PCM would be about 60 KB, and PSRAM on this board has a better use.
//
// The frequencies are not arbitrary. They sit on a pentatonic-ish set (523/659/784/831/988 Hz —
// C5, E5, G5, G#5, B5) so that two cues landing near each other do not beat against one another,
// and they are all above 500 Hz because a 40 mm speaker in a plastic module reproduces nothing
// useful below that; a "low" cue built at 150 Hz would simply be inaudible and read as a fault.
// ---------------------------------------------------------------------------------------------

struct Segment {
  uint16_t freqHz;        // 0 = silence
  uint16_t ms;
  uint8_t amplitudePct;   // of full scale, before the codec's own volume control
};

constexpr size_t kMaxSegments = 4;

struct CueDef {
  const char* name;
  Segment segments[kMaxSegments];
};

// Indexed by SpeakerCue. Order must match the enum; the static_assert below is what keeps it that
// way when somebody inserts a cue in the middle.
const CueDef kCues[] = {
    // Tap — one click-length note. Deliberately the quietest thing here: it fires on every touch,
    // and a loud tap cue is the fastest way to make somebody turn all the sounds off.
    {"tap", {{880, 45, 40}}},
    // Confirm — up a fourth. "That went through."
    {"confirm", {{659, 55, 55}, {988, 75, 55}}},
    // Error — low and doubled, with a gap. The gap is what makes it read as a refusal rather than
    // as a note; a single low tone is too easily heard as a normal cue on a small speaker.
    {"error", {{392, 90, 65}, {0, 55, 0}, {294, 130, 65}}},
    // Turn complete — a rising triad, the only cue with three notes going up. This is the one that
    // fires when nobody is looking at the screen, so it has to carry across a room.
    {"turn-complete", {{659, 70, 50}, {831, 70, 50}, {988, 120, 55}}},
    // Approval needed — up, down, back up. An unresolved shape, on purpose: it should sound like a
    // question, because it is one and it will keep being one until somebody answers it.
    {"approval-needed", {{988, 80, 55}, {740, 80, 50}, {988, 140, 60}}},
    // Recording start — rising pair. Played BEFORE the ADC opens, see startCaptureCue below.
    {"recording-start", {{523, 45, 50}, {784, 75, 55}}},
    // Recording stop — the same pair falling. Same interval, opposite direction, so the two are a
    // matched bracket rather than two unrelated noises.
    {"recording-stop", {{784, 45, 50}, {523, 75, 55}}},
};

static_assert(sizeof(kCues) / sizeof(kCues[0]) == (size_t)SpeakerCue::CueCount,
              "kCues is out of step with the SpeakerCue enum");

// ---------------------------------------------------------------------------------------------
// Task plumbing.
// ---------------------------------------------------------------------------------------------

enum class RequestKind : uint8_t { Cue, Pcm, Demo };

struct Request {
  RequestKind kind;
  SpeakerCue cue;
  uint32_t pcmCount;   // samples staged in pcmStage, for RequestKind::Pcm
  uint32_t stopGen;    // value of stopGeneration when this request was accepted
};

QueueHandle_t queue = nullptr;
TaskHandle_t task = nullptr;

std::atomic<bool> ready{false};

// A COUNTER, NOT A FLAG, for the same reason captureGeneration() is one — see audio_bus.h.
// The first version of this was a bool that the task cleared as it picked up each request, which
// meant speakerStop() cancelled the sound that was playing and then let the very next queued cue
// straight through: exactly the beep the caller was trying to suppress. A flag also cannot tell
// "a stop is pending" from "a stop happened while nothing was playing", so a stop issued while
// idle would swallow the next legitimate cue minutes later. Every request is stamped with the
// value it saw at enqueue; a request whose stamp is stale was issued before a stop and is dropped,
// and one stamped after it plays normally.
std::atomic<uint32_t> stopGeneration{0};
std::atomic<int32_t> inFlight{0};      // accepted-but-not-finished requests; drives speakerBusy()
std::atomic<bool> pcmStageBusy{false}; // the lock on pcmStage, taken by the caller, freed by the task

int16_t* pcmStage = nullptr;           // PSRAM, SPEAKER_PCM_STAGE_SAMPLES mono samples
size_t pcmStageCapacity = 0;

uint8_t volumePct = (uint8_t)AUDIO_PLAYBACK_VOLUME;

// One chunk of stereo frames, handed to the DAC at a time. 256 frames is 16 ms at 16 kHz, which is
// also the abort granularity: a recording that starts mid-cue silences the speaker within one
// chunk. Smaller would abort faster and spend more time in i2s_channel_write; larger would let a
// beep run further into a voice note. 16 ms is under the two frames audio.cpp already discards at
// the top of a recording, which is what makes the overlap harmless.
constexpr size_t kRenderFrames = 256;

// OWNERSHIP: written ONLY by speakerTask(), from the moment the task starts until reboot. It is
// file-static rather than a task local because a 1 KB buffer on a 4 KB stack is asking for an
// overflow the day somebody adds a float array to a cue. Nothing else may touch it; there is no
// second instance of this module and no second task, which is why no lock is needed here.
int16_t renderFrame[kRenderFrames * 2];

// True when whatever is playing should stop right now. Checked before every single chunk.
// `gen` is the capture generation captured before playback began — see audio_bus.h for why a
// bare captureActive() check is not enough.
bool shouldAbort(const Request& req, uint32_t gen) {
  if (stopGeneration.load(std::memory_order_acquire) != req.stopGen) return true;
  if (audio::bus::captureActive()) return true;
  if (audio::bus::captureGeneration() != gen) return true;
  return false;
}

// Hands one chunk to the DAC. Returns false on abort or a DMA timeout, which the callers treat
// identically: stop, drop the rest, get off the bus.
bool writeChunk(size_t frames, const Request& req, uint32_t gen) {
  if (frames == 0) return true;
  if (frames > kRenderFrames) frames = kRenderFrames;   // never write past renderFrame
  if (shouldAbort(req, gen)) return false;

  size_t written = 0;
  const size_t bytes = frames * 2 * sizeof(int16_t);
  const esp_err_t err = i2s_channel_write(audio::bus::txChannel(), renderFrame, bytes, &written,
                                          pdMS_TO_TICKS(SPEAKER_WRITE_TIMEOUT_MS));
  if (err != ESP_OK) {
    Serial.printf("[speaker] I2S write failed (%d); dropping the rest of this sound.\n", (int)err);
    return false;
  }
  return true;
}

// Writes `ms` of digital silence. Used at both ends of every sound: at the start it gives the
// FM8002E amplifier time to come out of shutdown with a zero-valued DAC in front of it, and at the
// end it settles the DAC back at zero before the amplifier is cut. Both are pop suppression —
// switching a class-D amp while the DAC sits at a non-zero level is an audible click, and on a cue
// that is 45 ms long the click is most of what you hear.
bool writeSilence(uint32_t ms, const Request& req, uint32_t gen) {
  const size_t total = (size_t)((uint64_t)ms * AUDIO_SAMPLE_RATE_HZ / 1000ULL);
  memset(renderFrame, 0, sizeof(renderFrame));
  size_t done = 0;
  while (done < total) {
    const size_t chunk = (total - done) < kRenderFrames ? (total - done) : kRenderFrames;
    if (!writeChunk(chunk, req, gen)) return false;
    done += chunk;
  }
  return true;
}

// Renders one segment. The envelope is a raised cosine over the first and last kEdgeMs, clamped so
// a segment shorter than two edges still fades symmetrically instead of producing a negative
// sustain. Without it every tone begins and ends on a step discontinuity, and a step into a
// speaker is a click — which on a 45 ms cue is louder than the cue.
bool renderSegment(const Segment& seg, const Request& req, uint32_t gen) {
  const uint32_t rate = (uint32_t)AUDIO_SAMPLE_RATE_HZ;
  const size_t total = (size_t)((uint64_t)seg.ms * rate / 1000ULL);
  if (total == 0) return true;
  if (seg.freqHz == 0 || seg.amplitudePct == 0) return writeSilence(seg.ms, req, gen);

  constexpr uint32_t kEdgeMs = 8;
  size_t edge = (size_t)((uint64_t)kEdgeMs * rate / 1000ULL);
  if (edge > total / 2) edge = total / 2;

  const float amp = 32767.0f * (float)seg.amplitudePct / 100.0f;
  const float step = 2.0f * (float)M_PI * (float)seg.freqHz / (float)rate;
  float phase = 0.0f;   // every segment starts at zero phase; the envelope makes that inaudible

  size_t done = 0;
  while (done < total) {
    const size_t chunk = (total - done) < kRenderFrames ? (total - done) : kRenderFrames;
    for (size_t i = 0; i < chunk; ++i) {
      const size_t n = done + i;
      float env = 1.0f;
      if (edge > 0) {
        if (n < edge) {
          env = 0.5f * (1.0f - cosf((float)M_PI * (float)n / (float)edge));
        } else if (n >= total - edge) {
          const size_t back = total - 1 - n;
          env = 0.5f * (1.0f - cosf((float)M_PI * (float)back / (float)edge));
        }
      }
      float v = sinf(phase) * amp * env;
      phase += step;
      if (phase > 2.0f * (float)M_PI) phase -= 2.0f * (float)M_PI;
      if (v > 32767.0f) v = 32767.0f;
      if (v < -32768.0f) v = -32768.0f;
      const int16_t s = (int16_t)v;
      // The codec is mono but the bus runs stereo slots, so each sample goes to both. `i` is
      // bounded by `chunk <= kRenderFrames`, so i*2+1 <= kRenderFrames*2-1 — in range by
      // construction, and the bound is restated here rather than trusted.
      if (i * 2 + 1 >= kRenderFrames * 2) break;
      renderFrame[i * 2] = s;
      renderFrame[i * 2 + 1] = s;
    }
    if (!writeChunk(chunk, req, gen)) return false;
    done += chunk;
  }
  return true;
}

bool renderCue(SpeakerCue cue, const Request& req, uint32_t gen) {
  const size_t index = (size_t)cue;
  if (index >= (size_t)SpeakerCue::CueCount) return false;
  const CueDef& def = kCues[index];
  for (size_t i = 0; i < kMaxSegments; ++i) {
    if (def.segments[i].ms == 0) break;          // a zero-length segment terminates the list
    if (!renderSegment(def.segments[i], req, gen)) return false;
  }
  return true;
}

bool renderPcm(uint32_t count, const Request& req, uint32_t gen) {
  if (!pcmStage) return false;
  if (count > pcmStageCapacity) count = (uint32_t)pcmStageCapacity;   // never read past the stage
  size_t done = 0;
  while (done < count) {
    const size_t chunk = (count - done) < kRenderFrames ? (count - done) : kRenderFrames;
    for (size_t i = 0; i < chunk; ++i) {
      if (i * 2 + 1 >= kRenderFrames * 2) break;
      const int16_t s = pcmStage[done + i];
      renderFrame[i * 2] = s;
      renderFrame[i * 2 + 1] = s;
    }
    if (!writeChunk(chunk, req, gen)) return false;
    done += chunk;
  }
  return true;
}

void finishRequest(const Request& req) {
  if (req.kind == RequestKind::Pcm) pcmStageBusy.store(false, std::memory_order_release);
  inFlight.fetch_sub(1, std::memory_order_acq_rel);
}

void speakerTask(void*) {
  for (;;) {
    Request req;
    // Blocks THIS task, never a caller. The whole point of the module is that the waiting happens
    // over here.
    if (xQueueReceive(queue, &req, portMAX_DELAY) != pdTRUE) continue;

    // Cancelled before it ever started: speakerStop() ran between this request being accepted and
    // this task reaching it.
    if (stopGeneration.load(std::memory_order_acquire) != req.stopGen) {
      finishRequest(req);
      continue;
    }

    // Rule 2 in audio_bus.h: a cue that arrives during a capture is dropped here, not held. By the
    // time the microphone closes, the moment this beep was feedback about is long gone.
    if (audio::bus::captureActive() || !audio::bus::codecReady()) {
      finishRequest(req);
      continue;
    }

    const uint32_t gen = audio::bus::captureGeneration();
    audio::bus::setPaEnabled(true);

    bool ok = writeSilence(SPEAKER_PA_SETTLE_MS, req, gen);
    if (ok) {
      switch (req.kind) {
        case RequestKind::Cue:
          ok = renderCue(req.cue, req, gen);
          break;
        case RequestKind::Pcm:
          ok = renderPcm(req.pcmCount, req, gen);
          break;
        case RequestKind::Demo:
          for (uint8_t i = 0; ok && i < (uint8_t)SpeakerCue::CueCount; ++i) {
            Serial.printf("[speaker] cue: %s\n", kCues[i].name);
            ok = renderCue((SpeakerCue)i, req, gen);
            if (ok) ok = writeSilence(350, req, gen);
          }
          break;
      }
    }

    // On a clean finish, settle the DAC before cutting the amplifier. On an abort, do not: the
    // reason we are aborting is that a microphone just opened, and eight more milliseconds of
    // anything — even silence being clocked out — is eight milliseconds the amplifier is still
    // powered next to it. A small click is the right trade there.
    if (ok) writeSilence(SPEAKER_PA_TAIL_MS, req, gen);
    audio::bus::setPaEnabled(false);

    finishRequest(req);
  }
}

bool enqueue(Request& req) {
  if (!ready.load(std::memory_order_acquire)) return false;
  req.stopGen = stopGeneration.load(std::memory_order_acquire);
  inFlight.fetch_add(1, std::memory_order_acq_rel);
  // Zero tick timeout: this is called from a render loop and must not wait for the queue to drain.
  if (xQueueSend(queue, &req, 0) != pdTRUE) {
    inFlight.fetch_sub(1, std::memory_order_acq_rel);
    return false;
  }
  return true;
}

}  // namespace

const char* speakerCueName(SpeakerCue cue) {
  const size_t index = (size_t)cue;
  if (index >= (size_t)SpeakerCue::CueCount) return "unknown";
  return kCues[index].name;
}

bool speakerAvailable() { return ready.load(std::memory_order_acquire); }

bool speakerBegin() {
  if (ready.load(std::memory_order_acquire)) return true;

  if (!audio::bus::codecReady()) {
    Serial.println("[speaker] audio::begin() has not succeeded; no speaker.");
    return false;
  }

  pcmStageCapacity = (size_t)SPEAKER_PCM_STAGE_SAMPLES;
  pcmStage = (int16_t*)ps_malloc(pcmStageCapacity * sizeof(int16_t));
  if (!pcmStage) {
    // Not fatal. Cues are synthesised and need no staging buffer, and they are the whole product
    // use of the speaker; speakerPlayPcm() is a bench and future-TTS affordance. Losing it should
    // not cost the UI its feedback tones.
    Serial.println("[speaker] No PSRAM for the PCM staging buffer; cues only.");
    pcmStageCapacity = 0;
  }

  queue = xQueueCreate(SPEAKER_QUEUE_DEPTH, sizeof(Request));
  if (!queue) {
    Serial.println("[speaker] Could not create the request queue.");
    return false;
  }

  // Core 0. The Arduino loop, the panel, touch, and every blocking gateway call live on core 1 and
  // routinely stall for seconds at a time; a sound that stops halfway through because an HTTP POST
  // is waiting on a socket is worse than no sound. Core 0 also hosts Wi-Fi, but those tasks are
  // short and much higher priority, and the I2S DMA ring absorbs the jitter.
  const BaseType_t created = xTaskCreatePinnedToCore(speakerTask, "spkr", SPEAKER_TASK_STACK, nullptr,
                                                     SPEAKER_TASK_PRIORITY, &task, 0);
  if (created != pdPASS) {
    Serial.println("[speaker] Could not start the playback task.");
    vQueueDelete(queue);
    queue = nullptr;
    return false;
  }

  ready.store(true, std::memory_order_release);
  speakerSetVolume(volumePct);
  Serial.printf("[speaker] Ready. volume %u%%, %u cue slots, %u ms of PCM staging.\n",
                (unsigned)volumePct, (unsigned)SPEAKER_QUEUE_DEPTH,
                (unsigned)((uint64_t)pcmStageCapacity * 1000ULL / (uint64_t)AUDIO_SAMPLE_RATE_HZ));
  return true;
}

void speakerSetVolume(uint8_t pct) {
  if (pct > 100) pct = 100;
  volumePct = pct;
  if (!audio::bus::codecReady()) return;

  // Deliberately on the CALLER's thread, not the playback task: I2C is shared with the touch
  // controller, which is polled from the render loop, and keeping every transaction on one core
  // means the Wire bus is never a cross-core question at all. The HAL does hold a mutex, so this
  // is belt and braces rather than a fix for a known bug — but a codec register write that
  // collides with a touch read is a hard failure to reproduce, and not creating the collision is
  // cheaper than debugging it.
  es8311_handle_t h = es8311_create((i2c_port_t)I2C_PORT_NUM, ES8311_I2C_ADDR);
  if (!h) {
    Serial.println("[speaker] Could not open the codec to set volume.");
    return;
  }
  if (es8311_voice_volume_set(h, (int)pct, nullptr) != ESP_OK) {
    Serial.println("[speaker] Volume write failed.");
  }
  es8311_delete(h);
}

uint8_t speakerVolume() { return volumePct; }

void speakerPlayCue(SpeakerCue cue) {
  if ((size_t)cue >= (size_t)SpeakerCue::CueCount) return;
  // Checked here as well as in the task. Checking early keeps a burst of taps during a recording
  // from filling the queue with things that will only be thrown away at the far end.
  if (audio::bus::captureActive()) return;
  Request req{RequestKind::Cue, cue, 0, 0};
  enqueue(req);
}

bool speakerPlayPcm(const int16_t* samples, size_t count, uint32_t rateHz) {
  if (!ready.load(std::memory_order_acquire)) return false;
  if (!samples || count == 0) return false;
  if (rateHz != (uint32_t)AUDIO_SAMPLE_RATE_HZ) return false;   // no resampler on this device
  if (audio::bus::captureActive()) return false;
  if (pcmStageCapacity == 0 || count > pcmStageCapacity) return false;

  // Atomic test-and-set, so two callers in the same frame cannot both decide the stage is theirs
  // and interleave their memcpys into it. The task clears it in finishRequest().
  if (pcmStageBusy.exchange(true, std::memory_order_acq_rel)) return false;

  memcpy(pcmStage, samples, count * sizeof(int16_t));

  Request req{RequestKind::Pcm, SpeakerCue::Tap, (uint32_t)count, 0};
  if (!enqueue(req)) {
    pcmStageBusy.store(false, std::memory_order_release);
    return false;
  }
  return true;
}

bool speakerBusy() { return inFlight.load(std::memory_order_acquire) > 0; }

void speakerStop() {
  if (!ready.load(std::memory_order_acquire)) return;
  // One increment cancels the sound in flight and everything queued behind it, and nothing else:
  // any request accepted after this line carries the new value and plays normally.
  //
  // The queue is NOT drained here. Doing it from this side would leak inFlight and strand
  // pcmStageBusy, because both are unwound in finishRequest() and only the playback task calls it
  // — the speaker would then read as permanently busy and speakerPlayPcm() would refuse forever.
  stopGeneration.fetch_add(1, std::memory_order_acq_rel);
}

void speakerDemoCues() {
  Request req{RequestKind::Demo, SpeakerCue::Tap, 0, 0};
  enqueue(req);
}

#else  // ENABLE_SPEAKER

// No speaker in this build. Every entry point still answers, so the UI carries no #if and can say
// honestly that this image has no output rather than offering a control that does nothing.

const char* speakerCueName(SpeakerCue) { return "disabled"; }
bool speakerAvailable() { return false; }
bool speakerBegin() {
  Serial.println("[speaker] Disabled. Build -e hosyond-es3c28p-controller to enable it.");
  return false;
}
void speakerSetVolume(uint8_t) {}
uint8_t speakerVolume() { return 0; }
void speakerPlayCue(SpeakerCue) {}
bool speakerPlayPcm(const int16_t*, size_t, uint32_t) { return false; }
bool speakerBusy() { return false; }
void speakerStop() {}
void speakerDemoCues() {}

#endif  // ENABLE_SPEAKER
