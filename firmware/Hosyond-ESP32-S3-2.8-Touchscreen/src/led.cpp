#include "led.h"

#if __has_include("controller_config.h")
#include "controller_config.h"
#else
#include "controller_config.example.h"
#endif

// Tunables, defaulted here as well as documented in include/controller_config.example.h — see the
// same note in speaker.cpp about why a per-unit controller_config.h cannot be relied on to have
// gained a section it was copied before.

// OFF by default. The pin is vendor-documented (see led.h) but no LED on this board has ever been
// lit by this firmware, and the file's own convention — set by ENABLE_LCD — is that unproven
// hardware does not ship enabled in the default environment.
#ifndef ENABLE_NOTIFICATION_LED
#define ENABLE_NOTIFICATION_LED 0
#endif

#ifndef RGB_LED_PIN
#define RGB_LED_PIN 42
#endif

// 40 Hz. Fast enough that a 300 ms crossfade has a dozen steps and no visible staircase, slow
// enough that the RMT frame cost is noise inside a 33 ms render budget.
#ifndef LED_TICK_INTERVAL_MS
#define LED_TICK_INTERVAL_MS 25
#endif

// Crossfade between two states. Long enough to read as a fade rather than a cut, short enough that
// "recording started" is unambiguous by the time a finger has finished pressing.
#ifndef LED_TRANSITION_MS
#define LED_TRANSITION_MS 300
#endif

// A WS2812B at full white is roughly 60 mA. On a 3.7 V cell that is a meaningful fraction of idle
// draw for a light nobody asked to be a torch.
#ifndef LED_DEFAULT_BRIGHTNESS_PCT
#define LED_DEFAULT_BRIGHTNESS_PCT 55
#endif

// WS2812B wire order is green, red, blue. Set to 0 if a real board shows red and green swapped —
// that is the one thing about this part the vendor examples contradict each other on.
#ifndef LED_COLOR_ORDER_GRB
#define LED_COLOR_ORDER_GRB 1
#endif

#if ENABLE_NOTIFICATION_LED

#include <atomic>
#include <math.h>

#include "esp32-hal-rmt.h"

namespace {

struct Rgb {
  uint8_t r, g, b;
};

// ---------------------------------------------------------------------------------------------
// The palette.
//
// The rule the board's visual language already follows is that nothing snaps. The Thinking Orb
// morphs; it does not cut between modes. So every effect here is a continuous function of time —
// a raised cosine, or a sum of them — and there is not a single hard on/off blink in the file. A
// blinking LED reads as a fault indicator on consumer hardware, which is precisely the wrong thing
// to say about an agent that is merely thinking.
//
// Hue choices, where they are not obvious:
//   Listening is red because a live microphone is red on every device anybody owns, and this is
//   the one state where being understood from across the room matters more than being pretty.
//   Error is crimson-pink rather than the same red, and is told apart by RHYTHM rather than by
//   hue — three grouped pulses against a continuous breath — because "is that reddish or that
//   other reddish" is not a distinction a person makes at a glance, and colour-blind users make it
//   never.
// ---------------------------------------------------------------------------------------------

constexpr Rgb kIdleColor{40, 110, 140};        // cool pilot light
constexpr Rgb kConnectingColor{255, 150, 20};  // amber
constexpr Rgb kListeningColor{255, 30, 20};    // record red
constexpr Rgb kThinkingColor{90, 110, 255};    // indigo, the orb's working colour
constexpr Rgb kApprovalColor{255, 190, 0};     // yellow
constexpr Rgb kErrorColor{255, 0, 70};         // crimson-pink
constexpr Rgb kOfflineColor{70, 70, 90};       // grey-blue

// WS2812B bit timings at a 100 ns RMT tick. The classic numbers, comfortably inside the V5 part's
// windows (T0H 0.22–0.38 µs, T1H 0.58–1.0 µs, both halves summing to ~1.25 µs).
constexpr uint32_t kT0H = 4;   // 400 ns
constexpr uint32_t kT0L = 8;   // 800 ns
constexpr uint32_t kT1H = 8;   // 800 ns
constexpr uint32_t kT1L = 4;   // 400 ns
constexpr uint32_t kRmtHz = 10000000;   // 10 MHz => 100 ns per tick

constexpr size_t kBits = 24;

// OWNERSHIP: written only inside ledTick()/ledBegin(), both of which run on the caller's thread,
// and read by the RMT DMA engine while a transmission is in flight. That overlap is exactly why
// transmit() refuses to touch it until rmtTransmitCompleted() says the previous frame is done —
// rewriting a buffer the DMA is still reading is how an addressable LED ends up latching a colour
// nobody asked for. There is one LED and one instance; no second writer exists.
rmt_data_t symbols[kBits];

std::atomic<bool> ready{false};

// THE ONLY THING ledSetState() WRITES, and it writes it with one atomic store. Everything else
// below is transition bookkeeping owned exclusively by ledTick().
//
// The first cut had ledSetState() assign `current`, `previous`, `transitionStartedAt` and
// `transitioning` directly, and the header claimed it was safe to call from any task. Those two
// statements cannot both be true: four unsynchronised writes racing a reader mid-crossfade is a
// data race, and an inaccurate safety claim in a header is worse than an honest limitation because
// somebody will build on it. Splitting the request from the bookkeeping makes the claim true
// instead of retracting it — a caller on any core does one relaxed store, and the render loop
// notices on its next tick.
std::atomic<uint8_t> requestedState{(uint8_t)LedState::Idle};
std::atomic<uint8_t> brightnessPct{(uint8_t)LED_DEFAULT_BRIGHTNESS_PCT};

// ledTick() only, from here down.
LedState current = LedState::Idle;
LedState previous = LedState::Idle;
uint32_t transitionStartedAt = 0;
bool transitioning = false;
uint32_t lastTickAt = 0;
Rgb lastSent{1, 1, 1};   // deliberately not {0,0,0}, so the first blank actually transmits

const Rgb& baseColor(LedState state) {
  switch (state) {
    case LedState::Idle:          return kIdleColor;
    case LedState::Connecting:    return kConnectingColor;
    case LedState::Listening:     return kListeningColor;
    case LedState::Thinking:      return kThinkingColor;
    case LedState::NeedsApproval: return kApprovalColor;
    case LedState::Error:         return kErrorColor;
    case LedState::Offline:       return kOfflineColor;
    default:                      return kIdleColor;
  }
}

// A raised cosine over `periodMs`, returning 0..1. This is the breath.
float breathe(uint32_t now, uint32_t periodMs) {
  if (periodMs == 0) return 1.0f;
  const float phase = (float)(now % periodMs) / (float)periodMs;
  return 0.5f * (1.0f - cosf(2.0f * (float)M_PI * phase));
}

// Envelope for one state, 0..1. Only NeedsApproval and Error depart from a plain breath, and both
// depart into a shaped pulse group rather than a blink — the level never leaves a continuous curve.
float envelope(LedState state, uint32_t now) {
  switch (state) {
    case LedState::Idle:
      // Barely there, and slow enough that it reads as "alive" rather than as an animation.
      return 0.03f + 0.09f * breathe(now, 6000);
    case LedState::Connecting:
      return 0.06f + 0.50f * breathe(now, 1800);
    case LedState::Listening:
      // The brightest floor of any state: even at the bottom of the breath the LED is clearly on,
      // because "the microphone might be live" is not a thing to be subtle about.
      return 0.35f + 0.65f * breathe(now, 1100);
    case LedState::Thinking:
      return 0.10f + 0.55f * breathe(now, 2600);
    case LedState::NeedsApproval: {
      // A heartbeat: two close pulses, then a rest. It repeats forever on purpose — this is the
      // only state where the device is blocked on a person, and a light that settles down after a
      // while would let a parked command sit unnoticed.
      const uint32_t period = 2000;
      const uint32_t t = now % period;
      if (t < 320) return 0.08f + 0.85f * breathe(t, 320);
      if (t >= 420 && t < 740) return 0.08f + 0.85f * breathe(t - 420, 320);
      return 0.08f;
    }
    case LedState::Error: {
      // Three grouped pulses, then a long dim hold, then again. Slower and heavier than the
      // approval heartbeat so the two are told apart by cadence in the dark.
      const uint32_t period = 3200;
      const uint32_t t = now % period;
      for (uint32_t i = 0; i < 3; ++i) {
        const uint32_t start = i * 380;
        if (t >= start && t < start + 300) return 0.10f + 0.85f * breathe(t - start, 300);
      }
      return 0.10f;
    }
    case LedState::Offline:
      // Very slow, very dim. Powered but pointless.
      return 0.02f + 0.05f * breathe(now, 8000);
    default:
      return 0.05f;
  }
}

// Perceptual correction. An LED driven linearly spends most of its range looking "on", so a linear
// breath looks like a blink with a slow tail. Squaring is a gamma of about 2.0 — not the textbook
// 2.2, but a multiply instead of a powf, and the difference is invisible on a 5050 through a
// diffuser.
uint8_t gamma8(float linear) {
  if (linear <= 0.0f) return 0;
  if (linear > 1.0f) linear = 1.0f;
  const float corrected = linear * linear;
  const int v = (int)(corrected * 255.0f + 0.5f);
  return (uint8_t)(v < 0 ? 0 : (v > 255 ? 255 : v));
}

Rgb effectColor(LedState state, uint32_t now) {
  const Rgb& c = baseColor(state);
  const float env =
      envelope(state, now) * ((float)brightnessPct.load(std::memory_order_relaxed) / 100.0f);
  return Rgb{gamma8(env * (float)c.r / 255.0f), gamma8(env * (float)c.g / 255.0f),
             gamma8(env * (float)c.b / 255.0f)};
}

uint8_t mix8(uint8_t a, uint8_t b, float t) {
  const float v = (float)a + ((float)b - (float)a) * t;
  const int i = (int)(v + 0.5f);
  return (uint8_t)(i < 0 ? 0 : (i > 255 ? 255 : i));
}

void encodeByte(uint8_t value, size_t bitOffset) {
  for (size_t i = 0; i < 8; ++i) {
    const size_t index = bitOffset + i;
    if (index >= kBits) return;                    // never write past `symbols`
    const bool one = (value & (0x80u >> i)) != 0;
    symbols[index].level0 = 1;
    symbols[index].duration0 = one ? kT1H : kT0H;
    symbols[index].level1 = 0;
    symbols[index].duration1 = one ? kT1L : kT0L;
  }
}

void transmit(const Rgb& c) {
  // If the previous frame is still going out, skip this update rather than wait for it or, worse,
  // overwrite the buffer underneath it. At 40 Hz the next tick is 25 ms away and a frame takes
  // 30 µs, so this practically never fires — but "practically never" is the interval on which
  // corrupted colours would appear, and a dropped frame of a breath is invisible.
  if (!rmtTransmitCompleted(RGB_LED_PIN)) return;

#if LED_COLOR_ORDER_GRB
  encodeByte(c.g, 0);
  encodeByte(c.r, 8);
#else
  encodeByte(c.r, 0);
  encodeByte(c.g, 8);
#endif
  encodeByte(c.b, 16);

  rmtWriteAsync(RGB_LED_PIN, symbols, kBits);
  lastSent = c;
}

}  // namespace

const char* ledStateName(LedState state) {
  switch (state) {
    case LedState::Idle:          return "idle";
    case LedState::Connecting:    return "connecting";
    case LedState::Listening:     return "listening";
    case LedState::Thinking:      return "thinking";
    case LedState::NeedsApproval: return "needs-approval";
    case LedState::Error:         return "error";
    case LedState::Offline:       return "offline";
    default:                      return "unknown";
  }
}

bool ledAvailable() { return ready.load(std::memory_order_acquire); }

bool ledBegin() {
  if (ready.load(std::memory_order_acquire)) return true;

  // 10 MHz tick. rmtInit claims one TX channel on the pin for the life of the firmware.
  if (!rmtInit(RGB_LED_PIN, RMT_TX_MODE, RMT_MEM_NUM_BLOCKS_1, kRmtHz)) {
    Serial.printf("[led] Could not claim an RMT TX channel on GPIO%d.\n", (int)RGB_LED_PIN);
    return false;
  }
  // Leave the data line low between frames. A WS2812B latches on a long low, so an idle-high line
  // means the LED never latches and holds whatever it had.
  rmtSetEOT(RGB_LED_PIN, 0);

  ready.store(true, std::memory_order_release);

  current = LedState::Idle;
  previous = LedState::Idle;
  transitioning = false;
  lastTickAt = 0;
  requestedState.store((uint8_t)LedState::Idle, std::memory_order_relaxed);
  transmit(Rgb{0, 0, 0});

  Serial.printf("[led] Ready on GPIO%d, WS2812B GRB, brightness %u%%.\n", (int)RGB_LED_PIN,
                (unsigned)brightnessPct.load(std::memory_order_relaxed));
  return true;
}

void ledSetState(LedState state) {
  if ((uint8_t)state >= (uint8_t)LedState::StateCount) return;
  requestedState.store((uint8_t)state, std::memory_order_relaxed);
}

LedState ledState() { return (LedState)requestedState.load(std::memory_order_relaxed); }

void ledSetBrightness(uint8_t pct) {
  if (pct > 100) pct = 100;
  brightnessPct.store(pct, std::memory_order_relaxed);
}

uint8_t ledBrightness() { return brightnessPct.load(std::memory_order_relaxed); }

void ledTick() {
  if (!ready.load(std::memory_order_acquire)) return;

  const uint32_t now = millis();
  if (lastTickAt != 0 && (uint32_t)(now - lastTickAt) < (uint32_t)LED_TICK_INTERVAL_MS) return;
  lastTickAt = now;

  // Pick up whatever ledSetState() last asked for and start a crossfade if it changed. Doing it
  // here rather than in the setter is what lets the setter be a single atomic store: only this
  // function ever touches the four transition variables, and only one task calls this function.
  const LedState wanted = (LedState)requestedState.load(std::memory_order_relaxed);
  if (wanted != current) {
    previous = current;
    current = wanted;
    transitionStartedAt = now;
    transitioning = true;
  }

  Rgb target = effectColor(current, now);

  if (transitioning) {
    const uint32_t elapsed = now - transitionStartedAt;
    if (elapsed >= (uint32_t)LED_TRANSITION_MS) {
      transitioning = false;
    } else {
      // Crossfade between the two effects rather than between two static colours, so a state that
      // changes mid-breath does not stall the animation for the length of the fade.
      const float t = (float)elapsed / (float)LED_TRANSITION_MS;
      const Rgb from = effectColor(previous, now);
      target = Rgb{mix8(from.r, target.r, t), mix8(from.g, target.g, t), mix8(from.b, target.b, t)};
    }
  }

  // Skip the transmission when nothing changed. At the bottom of the Idle breath this is most
  // ticks, and every skipped frame is 30 µs of RMT the radio does not contend with.
  if (target.r == lastSent.r && target.g == lastSent.g && target.b == lastSent.b) return;
  transmit(target);
}

void ledDemoStates() {
  if (!ready.load(std::memory_order_acquire)) return;
  for (uint8_t i = 0; i < (uint8_t)LedState::StateCount; ++i) {
    const LedState s = (LedState)i;
    ledSetState(s);
    Serial.printf("[led] %s\n", ledStateName(s));
    const uint32_t until = millis() + 2500;
    while ((int32_t)(millis() - until) < 0) {
      ledTick();
      delay(5);
    }
  }
  ledSetState(LedState::Idle);
}

#else  // ENABLE_NOTIFICATION_LED

const char* ledStateName(LedState) { return "disabled"; }
bool ledAvailable() { return false; }
bool ledBegin() {
  Serial.println("[led] Disabled. Build with -DENABLE_NOTIFICATION_LED=1 to enable GPIO42.");
  return false;
}
void ledSetState(LedState) {}
LedState ledState() { return LedState::Idle; }
void ledSetBrightness(uint8_t) {}
uint8_t ledBrightness() { return 0; }
void ledTick() {}
void ledDemoStates() {}

#endif  // ENABLE_NOTIFICATION_LED
