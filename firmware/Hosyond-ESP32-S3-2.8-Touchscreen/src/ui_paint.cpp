#include "ui_paint.h"

#include <math.h>

#include "display.h"

namespace uip {

namespace {

Adafruit_ILI9341& g() { return displayPanel(); }

}  // namespace

bool hit(const Rect& r, int16_t x, int16_t y) {
  return x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h;
}

// ---------------------------------------------------------------------------------------------
// Motion
// ---------------------------------------------------------------------------------------------

float easeOutCubic(float t) {
  if (t <= 0.0f) return 0.0f;
  if (t >= 1.0f) return 1.0f;
  const float u = 1.0f - t;
  return 1.0f - u * u * u;
}

float easeInOutCubic(float t) {
  if (t <= 0.0f) return 0.0f;
  if (t >= 1.0f) return 1.0f;
  if (t < 0.5f) return 4.0f * t * t * t;
  const float u = -2.0f * t + 2.0f;
  return 1.0f - u * u * u / 2.0f;
}

float approach(float value, float target, uint32_t frameMs, uint32_t durationMs) {
  if (durationMs == 0) return target;
  const float step = (float)frameMs / (float)durationMs;
  if (target > value) {
    value += step;
    return value > target ? target : value;
  }
  value -= step;
  return value < target ? target : value;
}

// ---------------------------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------------------------

String fit(const String& value, size_t cols) {
  if (value.length() <= cols) return value;
  if (cols <= 1) return value.substring(0, cols);
  return value.substring(0, cols - 1) + "~";
}

void text(int16_t x, int16_t y, uint8_t size, uint8_t grey, const String& value) {
  if (value.length() == 0) return;
  g().setTextWrap(false);
  g().setTextSize(size);
  g().setTextColor(panelGrey(grey));
  g().setCursor(x, y);
  g().print(value);
}

void textCentered(int16_t y, uint8_t size, uint8_t grey, const String& value) {
  if (value.length() == 0) return;
  const int16_t w = (int16_t)(value.length() * 6 * size);
  text((int16_t)((kW - w) / 2), y, size, grey, value);
}

void textCenteredIn(const Rect& r, int16_t y, uint8_t size, uint8_t grey, const String& value) {
  if (value.length() == 0) return;
  const int16_t w = (int16_t)(value.length() * 6 * size);
  text((int16_t)(r.x + (r.w - w) / 2), y, size, grey, value);
}

void textRight(int16_t right, int16_t y, uint8_t size, uint8_t grey, const String& value) {
  if (value.length() == 0) return;
  const int16_t w = (int16_t)(value.length() * 6 * size);
  text((int16_t)(right - w), y, size, grey, value);
}

size_t wrapText(const String& value, size_t cols, String* out, size_t maxLines) {
  size_t lines = 0;
  size_t i = 0;
  const size_t len = value.length();
  while (i < len && lines < maxLines) {
    while (i < len && value[i] == ' ') i += 1;
    if (i >= len) break;
    size_t end = min(len, i + cols);
    if (end < len) {
      size_t brk = end;
      while (brk > i && value[brk] != ' ') brk -= 1;
      if (brk > i) end = brk;
    }
    out[lines++] = value.substring(i, end);
    i = end;
  }
  return lines;
}

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

void card(const Rect& r, float radius, int16_t fill, int16_t stroke, float strokeWidth,
          float feather, uint8_t bg) {
  displaySoftRoundRect(r.x, r.y, r.w, r.h, radius, bg, fill, stroke, strokeWidth, feather);
}

void capsule(const Rect& r, int16_t fill, int16_t stroke, float strokeWidth, float feather,
             uint8_t bg) {
  displaySoftRoundRect(r.x, r.y, r.w, r.h, r.h * 0.5f, bg, fill, stroke, strokeWidth, feather);
}

void button(const Rect& r, const String& label, bool primary, bool enabled, uint8_t bg) {
  // A primary button is a filled capsule with dark ink, which is how it wins against an outline
  // without either of them having to be bigger than the other.
  const int16_t fill = enabled ? (primary ? (int16_t)kBright : (int16_t)kSurface) : (int16_t)kSurface;
  const int16_t stroke = enabled ? (primary ? -1 : (int16_t)kMuted) : (int16_t)kHair;
  const uint8_t ink = enabled ? (primary ? kBg : kText) : kHair;
  capsule(r, fill, stroke, 1.3f, primary ? 1.4f : 1.2f, bg);

  const size_t cols = r.w > 16 ? (size_t)((r.w - 14) / 6) : 1;
  const String shown = fit(label, cols);
  const int16_t tw = (int16_t)(shown.length() * 6);
  text((int16_t)(r.x + (r.w - tw) / 2), (int16_t)(r.y + (r.h - 8) / 2), 1, ink, shown);
}

void divider(int16_t x, int16_t y, int16_t w, uint8_t grey, uint8_t bg) {
  displaySoftArcDivider(x, y, w, 2.5f, 1.4f, bg, grey);
}

void dot(int16_t cx, int16_t cy, float radius, uint8_t grey, uint8_t bg) {
  const int16_t d = (int16_t)(radius * 2.0f + 2.0f);
  displaySoftRoundRect((int16_t)(cx - d / 2), (int16_t)(cy - d / 2), d, d, d * 0.5f, bg,
                       (int16_t)grey, -1, 0.0f, 1.1f);
}

void chevron(int16_t cx, int16_t cy, float size, int8_t dir, uint8_t grey, float thickness,
             uint8_t bg) {
  const float s = size;
  switch (dir) {
    case -1:   // left
      displaySoftSegment(cx + s * 0.5f, cy - s, cx - s * 0.5f, cy, thickness, bg, grey);
      displaySoftSegment(cx - s * 0.5f, cy, cx + s * 0.5f, cy + s, thickness, bg, grey);
      return;
    case 1:    // right
      displaySoftSegment(cx - s * 0.5f, cy - s, cx + s * 0.5f, cy, thickness, bg, grey);
      displaySoftSegment(cx + s * 0.5f, cy, cx - s * 0.5f, cy + s, thickness, bg, grey);
      return;
    case 2:    // down
      displaySoftSegment(cx - s, cy - s * 0.5f, cx, cy + s * 0.5f, thickness, bg, grey);
      displaySoftSegment(cx, cy + s * 0.5f, cx + s, cy - s * 0.5f, thickness, bg, grey);
      return;
    default:   // up
      displaySoftSegment(cx - s, cy + s * 0.5f, cx, cy - s * 0.5f, thickness, bg, grey);
      displaySoftSegment(cx, cy - s * 0.5f, cx + s, cy + s * 0.5f, thickness, bg, grey);
      return;
  }
}

void marker(int16_t x, int16_t y, int16_t h, uint8_t grey, uint8_t bg) {
  displaySoftRoundRect(x, y, 4, h, 2.0f, bg, (int16_t)grey, -1, 0.0f, 1.1f);
}

}  // namespace uip
