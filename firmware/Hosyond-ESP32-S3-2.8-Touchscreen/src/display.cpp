#include "display.h"

#if __has_include("controller_config.h")
#include "controller_config.h"
#else
#include "controller_config.example.h"
#endif

#include <SPI.h>

namespace {

// Constructed lazily, NOT as a global.
//
// Adafruit_ILI9341's constructor captures a reference to the global `SPI` object. As a file-scope
// global this is the static initialization order fiasco: nothing orders `panel` after `SPI` across
// translation units, so it can capture an SPIClass that has not been constructed yet. The symptom
// is a board that dies before Serial.begin() and therefore explains nothing about itself — which
// is exactly what happened, and it happened even in builds with ENABLE_LCD=0, because the global
// is constructed regardless of whether the display is ever used.
Adafruit_ILI9341* panel = nullptr;
bool ready = false;
uint32_t panelFreq = 24000000;

}  // namespace

bool displayReady() { return ready && panel != nullptr; }

Adafruit_ILI9341& displayPanel() { return *panel; }

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
  // The vendor drives this panel at 80 MHz in SPI mode 0 (docs/.../Example_01/spi_dev.h). Adafruit
  // defaults to 24 MHz, which is safe but leaves most of the bandwidth unused — and this UI redraws
  // an animated orb, so the bus is the budget. 40 MHz is the compromise: a real speed-up, with
  // margin against the ribbon and the breadboard-grade routing on a module like this.
  SPI.begin(LCD_SCLK, LCD_MISO, LCD_MOSI, LCD_CS);
  // The vendor drives this panel at 80 MHz (docs/.../Example_01/spi_dev.h). Adafruit defaults to
  // 24 MHz, which leaves the frame time dominated by the blit. 40 MHz roughly halves it while
  // keeping margin against the ribbon on a module like this.
  panelFreq = 40000000;

  // Built here, after Arduino's init and after SPI is known to exist.
  if (!panel) panel = new Adafruit_ILI9341(LCD_CS, LCD_DC, LCD_RST);
  if (!panel) return false;

  panel->begin(panelFreq);

  // Inversion OFF. The vendor's init sends 0x21 (INVON), but that sequence is relative to their
  // own register setup, not to Adafruit's — whose ILI9341 init already leaves this panel the right
  // way round. Sending it on top produced a white screen with dark dots on real glass (photo
  // evidence, 2026-08-24), so the two inversions were cancelling. Verified visually: do not
  // "restore" this from the vendor file without looking at the panel.
  panel->invertDisplay(false);

  panel->setRotation(0);           // portrait, 240x320, ribbon at the bottom
  panel->fillScreen(ILI9341_BLACK);

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

// Off-screen canvases, blitted in one transaction each.
//
// The first version drew every dot straight to the panel and erased the previous frame dot by dot.
// That is ~600 separate SPI transactions per frame, and the panel is scanning out the whole time,
// so the user sees the redraw sweep across the glass — the dark band visible in the bring-up
// video. Compositing in RAM and pushing one rectangle removes both problems: the cost stops
// scaling with dot count, and the panel never shows a half-built frame.
//
// A 148x148 canvas is 43 KB and the label strip is 11 KB, against ~300 KB of free internal heap.
GFXcanvas16* orbCanvas = nullptr;
GFXcanvas16* labelCanvas = nullptr;

constexpr int16_t kLabelH = 22;

}  // namespace

bool displayBeginCanvases(uint16_t orbSize) {
  if (!orbCanvas) orbCanvas = new GFXcanvas16(orbSize, orbSize);
  if (!labelCanvas) labelCanvas = new GFXcanvas16(240, kLabelH);
  return orbCanvas && labelCanvas && orbCanvas->getBuffer() && labelCanvas->getBuffer();
}

void displayDrawOrb(ThinkingOrb& orb, int16_t cx, int16_t cy, uint32_t elapsedMs) {
  if (!displayReady() || !orbCanvas) return;

  const OrbFrame frame = orb.render(elapsedMs);

  const int16_t w = orbCanvas->width();
  const int16_t h = orbCanvas->height();
  const int16_t mid = w / 2;

  orbCanvas->fillScreen(0x0000);
  for (uint16_t i = 0; i < frame.count; ++i) {
    const OrbDot& d = frame.dots[i];
    const uint16_t colour = greyToRgb565(d.ink);
    const int16_t x = mid + d.x;
    const int16_t y = mid + d.y;
    // A 1 px dot as a filled circle costs a bounding-box walk for one pixel, and most of the
    // sphere is 1 px dots.
    if (d.radius <= 1) orbCanvas->drawPixel(x, y, colour);
    else orbCanvas->fillCircle(x, y, d.radius, colour);
  }

  displayPanel().drawRGBBitmap(cx - mid, cy - mid, orbCanvas->getBuffer(), w, h);
}

void displayDrawStatus(const char* label, int16_t cy, uint32_t elapsedMs) {
  if (!displayReady() || !labelCanvas || !label) return;

  const size_t len = strlen(label);
  if (len == 0) return;

  labelCanvas->fillScreen(0x0000);
  labelCanvas->setTextSize(2);

  const int16_t charW = 12;                       // 6 px base glyph at size 2
  const int16_t textW = (int16_t)(len * charW);
  const int16_t x0 = (int16_t)((240 - textW) / 2);

  // The web component sweeps a bright band across the label with a CSS gradient. There is no
  // gradient here, so the same read is produced per-glyph: a moving window of brighter characters.
  const float head = fmodf(elapsedMs / 1100.0f, 1.6f) * (len + 3.0f) - 1.5f;

  for (size_t i = 0; i < len; ++i) {
    const float d = fabsf((float)i - head);
    const float lift = d > 2.2f ? 0.0f : (1.0f - d / 2.2f);
    const uint8_t grey = (uint8_t)(96 + lift * 159);
    labelCanvas->setTextColor(greyToRgb565(grey));
    labelCanvas->setCursor(x0 + (int16_t)(i * charW), 4);
    labelCanvas->write(label[i]);
  }

  displayPanel().drawRGBBitmap(0, cy - 4, labelCanvas->getBuffer(), 240, kLabelH);
}
