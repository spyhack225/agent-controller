#pragma once

// FT6336G capacitive touch, on the I2C bus shared with the ES8311 codec.
//
// Deliberately minimal: this panel reports up to two points, but nothing in this UI needs a second
// finger, and a gesture recogniser that only has to tell a tap from a drag does not need the
// controller's gesture registers (which are unreliable across FT6xxx variants anyway).
//
// The UI needs three things from a finger and gets exactly those: where it landed (tap targets),
// how far it has moved since the last poll (list scrolling, which is direct manipulation rather
// than a fling), and whether it is still down (push-to-talk).

#include <Arduino.h>

enum class TouchGesture : uint8_t {
  None,
  Press,        // first contact, at (x, y)
  Drag,         // still down and moved since the last poll; dx/dy carry the movement
  Release,      // lifted after a drag — the gesture was movement, not a tap
  Tap,          // pressed and lifted without travelling
  SwipeLeft,
  SwipeRight,
  LongPress,    // fires WHILE held
};

// One event per poll. `x`/`y` are panel pixels for Press, Drag and Tap — the coordinate frame the
// renderer draws in, not the controller's raw frame. `dx`/`dy` are movement since the previous
// poll and are zero except on Drag.
struct TouchEvent {
  TouchGesture gesture = TouchGesture::None;
  int16_t x = 0;
  int16_t y = 0;
  int16_t dx = 0;
  int16_t dy = 0;
};

// Resets the controller and probes for it on I2C. Wire must already be started.
bool touchBegin();
bool touchPresent();

// Call from loop(). Returns a gesture once.
//
// Everything but LongPress and Drag is decided on release, because a swipe is not distinguishable
// from a tap until the finger lifts. LongPress fires WHILE held, the moment the threshold passes —
// waiting for release would mean holding a button with no acknowledgement, which reads as broken.
TouchEvent touchPoll();

// True while a finger is on the glass. Push-to-talk needs the held state rather than an edge: the
// recording runs for as long as this is true and stops when it goes false.
bool touchDown();
