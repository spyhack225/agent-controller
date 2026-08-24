#pragma once

// FT6336G capacitive touch, on the I2C bus shared with the ES8311 codec.
//
// Deliberately minimal: this panel reports up to two points, but nothing in this UI needs a second
// finger, and a gesture recogniser that only has to tell a tap from a horizontal swipe does not
// need the controller's gesture registers (which are unreliable across FT6xxx variants anyway).

#include <Arduino.h>

enum class TouchGesture : uint8_t {
  None,
  Tap,
  SwipeLeft,
  SwipeRight,
  LongPress,
};

// Resets the controller and probes for it on I2C. Wire must already be started.
bool touchBegin();
bool touchPresent();

// Call from loop(). Returns a gesture once.
//
// Everything but LongPress is decided on release, because a swipe is not distinguishable from a
// tap until the finger lifts. LongPress fires WHILE held, the moment the threshold passes — waiting
// for release would mean holding a button with no acknowledgement, which reads as broken.
TouchGesture touchPoll();
