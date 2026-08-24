#include "display.h"

#if __has_include("controller_config.h")
#include "controller_config.h"
#else
#include "controller_config.example.h"
#endif

#include <SPI.h>

namespace {
Adafruit_ILI9341 panel(LCD_CS, LCD_DC, LCD_RST);
bool ready = false;
}  // namespace

bool displayReady() { return ready; }
Adafruit_ILI9341& displayPanel() { return panel; }

void displayBacklight(bool on) {
  // Ramped, not switched. The vendor spec rates this board at 140 mA with the display alone and
  // 560 mA with display + speaker + charging, and the backlight is four white LEDs. Slamming the
  // pin high draws the inrush in one step, which on a weak USB port is enough to brown out the
  // regulator — and a brownout during Wi-Fi bring-up looks exactly like the crash-reboot loop the
  // first hardware flash of this adapter produced.
  //
  // Ramping also avoids driving GPIO45 to a hard rail instantly. That pin is the VDD_SPI strapping
  // pin as well as the backlight, so it is the one pin here worth being gentle with.
  ledcAttach(LCD_BL, 5000, 8);
  if (!on) {
    ledcWrite(LCD_BL, 0);
    return;
  }
  for (int duty = 0; duty <= 255; duty += 5) {
    ledcWrite(LCD_BL, duty);
    delay(2);
  }
  ledcWrite(LCD_BL, 255);
}

bool displayBegin() {
#if !ENABLE_LCD
  return false;
#else
  // Remap the bus: these are not the S3's default SPI pins. MISO is passed because the panel
  // shares the bus, though this driver never reads from it.
  SPI.begin(LCD_SCLK, LCD_MISO, LCD_MOSI, LCD_CS);

  panel.begin();
  panel.setRotation(0);            // portrait, 240x320, ribbon at the bottom
  panel.fillScreen(ILI9341_BLACK);

  // Let the panel's own rails settle before adding the backlight load on top of them.
  delay(20);

  // Backlight goes on only after the framebuffer has been cleared. Enabling it first shows the
  // panel's power-on noise for a few hundred milliseconds, which reads as a fault.
  displayBacklight(true);

  ready = true;
  return true;
#endif
}

namespace {

// The panel is 16-bit RGB565 and the orb is greyscale, so ink collapses to one channel triple.
inline uint16_t greyToRgb565(uint8_t g) {
  return (uint16_t)(((g & 0xF8) << 8) | ((g & 0xFC) << 3) | (g >> 3));
}

// Tracks the previous frame's dots so each one can be erased individually. Clearing the whole orb
// box every frame is ~40k pixels over SPI and visibly tears; erasing ~300 small discs is an order
// of magnitude less traffic and reads as smooth.
constexpr uint16_t kMaxTracked = 512;
struct PaintedDot { int16_t x, y; uint8_t r; };
PaintedDot painted[kMaxTracked];
uint16_t paintedCount = 0;

}  // namespace

void displayDrawOrb(ThinkingOrb& orb, int16_t cx, int16_t cy, uint32_t elapsedMs) {
  if (!ready) return;
  Adafruit_ILI9341& g = displayPanel();

  const OrbFrame frame = orb.render(elapsedMs);

  for (uint16_t i = 0; i < paintedCount; ++i) {
    g.fillCircle(painted[i].x, painted[i].y, painted[i].r, 0x0000);
  }

  paintedCount = 0;
  for (uint16_t i = 0; i < frame.count; ++i) {
    const OrbDot& d = frame.dots[i];
    const int16_t x = cx + d.x;
    const int16_t y = cy + d.y;
    const uint8_t r = d.radius;

    if (r <= 1) g.drawPixel(x, y, greyToRgb565(d.ink));
    else g.fillCircle(x, y, r, greyToRgb565(d.ink));

    if (paintedCount < kMaxTracked) {
      painted[paintedCount++] = {x, y, (uint8_t)(r + 1)};
    }
  }
}

void displayDrawStatus(const char* label, int16_t cy, uint32_t elapsedMs) {
  if (!ready || !label) return;
  Adafruit_ILI9341& g = displayPanel();

  const size_t len = strlen(label);
  if (len == 0) return;

  g.setTextSize(2);
  const int16_t charW = 12;                       // 6px base glyph at size 2
  const int16_t textW = (int16_t)(len * charW);
  const int16_t x0 = (int16_t)((240 - textW) / 2);

  // The web component sweeps a bright band across the label with a CSS gradient. There is no
  // gradient here, so the same read is produced per-glyph: a moving window of brighter characters.
  const float head = fmodf(elapsedMs / 1100.0f, 1.6f) * (len + 3.0f) - 1.5f;

  g.fillRect(0, cy - 2, 240, 20, 0x0000);
  for (size_t i = 0; i < len; ++i) {
    const float d = fabsf((float)i - head);
    const float lift = d > 2.2f ? 0.0f : (1.0f - d / 2.2f);
    const uint8_t grey = (uint8_t)(96 + lift * 159);
    g.setTextColor(greyToRgb565(grey));
    g.setCursor(x0 + (int16_t)(i * charW), cy);
    g.write(label[i]);
  }
}
