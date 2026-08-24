#pragma once

// The single on-board RGB status LED.
//
// THE HARDWARE, AND HOW CONFIDENT WE ARE IN IT.
//
// GPIO42, one WS2812B-class addressable LED. This is not inferred, it is stated by the vendor in
// four independent places that agree:
//
//   1. docs/…/5-原理图_Schematic/ESP32-S3芯片IO资源分配表.xlsx, the manufacturer's IO allocation
//      table, row "48 | IO42": 单线RGB三色LED灯控制引脚 — "single-wire RGB tri-colour LED control
//      pin". That sheet is the same document the rest of this board's pin map came from.
//   2. The schematic PDF names the part: XL-5050RGBC-WS2812B, one instance, net RGB_LED.
//   3. docs/…/4-数据手册_DataSheet/ ships RGB+LED(IC)_WS2812B-V5-W.PDF — the LED's own datasheet.
//   4. Two vendor Arduino examples drive it: Example_06_RGB_LED and Example_15_RGB_LED_TOUCH, both
//      `#define LED_PIN 42` through Adafruit_NeoPixel at 800 kHz.
//
// GPIO42 is MTMS (JTAG TMS) and is NOT a strapping pin, so unlike the backlight on GPIO45 there is
// no boot hazard here. The board uses the internal USB-Serial-JTAG, so the pin is free.
//
// One detail is NOT vendor-confirmed and is worth knowing: both examples declare LED_COUNT 60 and
// Example_06 declares NEO_GRBW. Both are Adafruit strip-demo boilerplate left unedited — the
// schematic shows a single RGB (not RGBW) part, and Example_15 uses NEO_GRB. We drive one LED in
// GRB order. If a real board lights up with red and green swapped, LED_COLOR_ORDER_GRB is the
// switch; if it stays dark, suspect the count or the timing, in that order.
//
// WHY NOT Adafruit_NeoPixel: it would be a new lib_deps entry for one LED, and its show() disables
// interrupts and busy-waits for the whole 30 µs frame. The Arduino core's own RMT peripheral driver
// does it in hardware, asynchronously, with no interrupt masking — which is what makes ledTick()
// honest about being non-blocking.
//
// Everything here is declared unconditionally and stubs out when ENABLE_NOTIFICATION_LED is 0, so
// callers carry no #if.

#include <Arduino.h>

// What the device is doing, as one light can express it. These are states, not events: the LED
// holds whatever it was last told until it is told something else, because a status light that
// decays back to "idle" on a timer is a status light that lies whenever the thing it was reporting
// takes longer than the timer.
enum class LedState : uint8_t {
  Idle,           // claimed, connected, nothing happening — a slow pilot breath
  Connecting,     // Wi-Fi, provisioning, or the first gateway handshake
  Listening,      // THE MICROPHONE IS LIVE. Red, by convention, and the brightest state here
  Thinking,       // a turn is dispatched and the agent has not answered yet
  NeedsApproval,  // a command is parked waiting for the owner — the one state that nags
  Error,          // the last thing tried failed
  Offline,        // powered, but talking to nobody: no Wi-Fi, or the gateway is unreachable
  StateCount
};

const char* ledStateName(LedState state);

// True in a build with the LED compiled in and the RMT channel successfully claimed.
bool ledAvailable();

// Claims the RMT channel and blanks the LED. Call once from setup(). Safe to call twice.
bool ledBegin();

// Set the state. One relaxed atomic store and nothing else, so it is cheap, non-blocking, and
// genuinely safe to call from any task on either core — all the crossfade bookkeeping happens
// inside ledTick(), which is the only writer of it. Setting the state it is already in costs the
// store and changes nothing, so calling this every frame from a state-derived expression is fine
// and is the intended usage.
//
// The change is picked up on the next ledTick(), so a board that has stopped calling ledTick() has
// a light that has stopped telling the truth. That is deliberate: the alternative is a setter that
// paints, and painting from whichever task happened to notice a state change is how two writers
// end up interleaved on one RMT channel.
void ledSetState(LedState state);
LedState ledState();

// Overall brightness ceiling, 0..100. Every effect is scaled by this. 0 turns the LED off without
// forgetting the state, so a "lights off at night" setting does not have to be remembered by the
// caller. A WS2812B at full white is roughly 60 mA, which is real money on a 3.7 V cell, which is
// why the default is well below 100.
void ledSetBrightness(uint8_t pct);
uint8_t ledBrightness();

// Steps the current effect. Call every loop pass; it paces itself internally to
// LED_TICK_INTERVAL_MS and returns immediately when the next update is not due, so calling it more
// often costs one millis() comparison. When an update IS due it costs a few floating-point
// operations and one asynchronous 24-bit RMT transmission that it does not wait for — worst case
// well under 100 µs of CPU inside a 33 ms frame.
void ledTick();

// Bench helper: walks every state with a pause between them so the vocabulary can be seen and the
// wiring proven. Blocking, ~2 s per state — for setup() and the serial console only, NEVER from
// the render loop.
void ledDemoStates();
