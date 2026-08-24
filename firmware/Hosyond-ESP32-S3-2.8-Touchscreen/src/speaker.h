#pragma once

// The speaker half of the ES8311: short UI feedback tones, and a way to play a PCM clip.
//
// Everything here is safe to call from the render loop. Nothing here waits for a sound to finish —
// a cue is handed to a FreeRTOS task on the other core and the caller returns in microseconds. The
// loop in ui.cpp has a 33 ms frame budget and the shortest cue is 40 ms, so an API that played
// synchronously could not be called from the place that knows a button was tapped.
//
// It is also safe to call before speakerBegin(), on a build with the audio path compiled out, and
// while the microphone is recording. In each of those cases the request is dropped and the caller
// is told so by the return value, or in the case of a cue simply not told at all — a UI should not
// have to ask permission to make a noise.
//
// WHAT IT WILL NOT DO, AND WHY: a cue requested while the microphone is live is discarded, and a
// cue already sounding is aborted mid-tone when a recording starts. The microphone and the speaker
// are centimetres apart with no echo canceller between them, so anything this plays during a
// capture is transcribed as part of the user's instruction. The full rule, including why this is
// stricter than the hardware requires, is in src/audio_bus.h.
//
// Every entry point is declared unconditionally and compiles to a stub when the speaker is not in
// the build, so the UI carries no #if.

#include <Arduino.h>

// Short feedback tones. These are a vocabulary, not a palette: each one means one thing, and the
// shapes are chosen so they can be told apart with the board in a pocket. Rising means something
// opened or started, falling means it closed or stopped, low and repeated means it went wrong.
enum class SpeakerCue : uint8_t {
  Tap,              // a control was hit — the shortest possible acknowledgement
  Confirm,          // a two-step action was accepted (an approval confirm, a thread selection)
  Error,            // low, doubled: a call failed, a policy refused, a tap did nothing
  TurnComplete,     // rising triad: the agent finished and there is something to read
  ApprovalNeeded,   // an unresolved question shape: a command is parked waiting for the owner
  RecordingStart,   // rising pair, played BEFORE the ADC opens
  RecordingStop,    // falling pair, played after the clip is closed
  CueCount
};

// Human-readable name, for logs and the bench self-test.
const char* speakerCueName(SpeakerCue cue);

// True only in a build with the speaker compiled in AND a codec that answered at boot AND a task
// that started. The UI can use this to decide whether to offer a "sounds" setting at all, the same
// way audio::available() gates the record button.
bool speakerAvailable();

// Brings up the playback task. Call once from setup(), AFTER audio::begin() — the I2S channels and
// the ES8311 belong to audio.cpp and this borrows them. Returns false if audio never came up.
bool speakerBegin();

// Output volume as a percentage, 0..100, applied in the ES8311's own DAC rather than by scaling
// samples: attenuating 16-bit PCM in software throws away bits that the analogue stage would still
// have had. 0 mutes.
//
// This one call touches I2C, from the CALLER's context — never from the playback task, so the
// shared Wire bus is only ever driven from the core that already drives the touch controller. Two
// register writes at 400 kHz, a few hundred microseconds; safe in a frame, but not free, so set it
// when it changes rather than every frame.
void speakerSetVolume(uint8_t pct);
uint8_t speakerVolume();

// Queue a cue. Returns immediately, always. Silently does nothing when the speaker is unavailable,
// when the microphone is recording, or when the (very short) queue is already full — a dropped
// beep is not an error worth propagating into UI code.
void speakerPlayCue(SpeakerCue cue);

// Play a mono 16-bit PCM clip. The samples are COPIED into the speaker's own staging buffer before
// this returns, so the caller may reuse or free its buffer immediately; nothing is shared with the
// playback task.
//
// Returns false, having played nothing, when: the speaker is unavailable; the microphone is
// recording; another clip is still playing; `samples` is null or `count` is 0; `count` exceeds
// SPEAKER_PCM_STAGE_SAMPLES; or `rateHz` is not the codec's configured rate. That last one is a
// refusal rather than a resample: there is no sample-rate converter on this device, and playing
// 44.1 kHz material through a 16 kHz clock produces something slow and wrong rather than something
// slightly off, which is worse than silence because it sounds like a hardware fault.
bool speakerPlayPcm(const int16_t* samples, size_t count, uint32_t rateHz);

// True from the moment a request is accepted until the last sample has been handed to the DAC.
// Cheap — one atomic load — so it is fine to poll every frame.
bool speakerBusy();

// Drop anything queued and abort anything sounding, at the next DMA chunk boundary. Called for you
// when a recording starts; exposed because a screen change may also want to stop a stale cue.
void speakerStop();

// Bench helper: plays every cue in order with a gap between them, so the vocabulary can be learned
// and the amplifier proven in one press. Returns immediately; the task does the waiting.
void speakerDemoCues();
