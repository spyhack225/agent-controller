#include "touch.h"

#include <Wire.h>

#if __has_include("controller_config.h")
#include "controller_config.h"
#else
#include "controller_config.example.h"
#endif

namespace {

bool present = false;

bool down = false;
int16_t startX = 0, startY = 0;
int16_t lastX = 0, lastY = 0;
uint32_t startMs = 0;

// A swipe has to travel this far to count, and a tap has to stay within it. Below this the two are
// indistinguishable from a finger rolling slightly on release.
constexpr int16_t kSwipeMinPx = 40;
constexpr uint32_t kTapMaxMs = 500;
constexpr uint32_t kLongPressMs = 1200;
// A long press is a press, not a slow drag: the finger has to stay put.
constexpr int16_t kLongPressSlopPx = 24;
bool longFired = false;

bool readPoint(int16_t& x, int16_t& y) {
  Wire.beginTransmission(TOUCH_I2C_ADDR);
  Wire.write(0x02);                       // touch count, then point 1
  if (Wire.endTransmission(false) != 0) return false;
  if (Wire.requestFrom((int)TOUCH_I2C_ADDR, 5) != 5) return false;

  const uint8_t count = Wire.read() & 0x0F;
  const uint8_t xh = Wire.read();
  const uint8_t xl = Wire.read();
  const uint8_t yh = Wire.read();
  const uint8_t yl = Wire.read();
  if (count == 0 || count > 2) return false;

  x = (int16_t)(((xh & 0x0F) << 8) | xl);
  y = (int16_t)(((yh & 0x0F) << 8) | yl);
  return true;
}

}  // namespace

bool touchPresent() { return present; }

bool touchBegin() {
  pinMode(TOUCH_RST_PIN, OUTPUT);
  digitalWrite(TOUCH_RST_PIN, LOW);
  delay(10);
  digitalWrite(TOUCH_RST_PIN, HIGH);
  delay(120);                              // the controller needs this long before it will ACK

  pinMode(TOUCH_INT_PIN, INPUT_PULLUP);

  Wire.beginTransmission(TOUCH_I2C_ADDR);
  present = Wire.endTransmission() == 0;
  Serial.printf("[touch] FT6336G at 0x%02x: %s\n", TOUCH_I2C_ADDR,
                present ? "present" : "no ACK");
  return present;
}

TouchGesture touchPoll() {
  if (!present) return TouchGesture::None;

  int16_t x = 0, y = 0;
  const bool hasPoint = readPoint(x, y);

  if (hasPoint) {
    if (!down) {
      down = true;
      longFired = false;
      startX = x;
      startY = y;
      startMs = millis();
    }
    // The release read returns nothing at all, so the travel has to be measured from the last
    // point seen while the finger was still down.
    lastX = x;
    lastY = y;

    if (!longFired && millis() - startMs >= kLongPressMs) {
      const int16_t mx = x - startX, my = y - startY;
      if (abs(mx) <= kLongPressSlopPx && abs(my) <= kLongPressSlopPx) {
        longFired = true;
        return TouchGesture::LongPress;
      }
    }
    return TouchGesture::None;
  }

  if (!down) return TouchGesture::None;
  down = false;
  // A long press already fired; the release that follows it is not also a tap.
  if (longFired) { longFired = false; return TouchGesture::None; }

  const int16_t dx = lastX - startX;
  const uint32_t heldMs = millis() - startMs;

  // Horizontal intent wins over a tap; a slow drag still counts, because a deliberate swipe on a
  // 2.8" panel is often slower than a phone gesture.
  if (dx <= -kSwipeMinPx) return TouchGesture::SwipeLeft;
  if (dx >= kSwipeMinPx) return TouchGesture::SwipeRight;
  if (heldMs <= kTapMaxMs) return TouchGesture::Tap;
  return TouchGesture::None;
}
