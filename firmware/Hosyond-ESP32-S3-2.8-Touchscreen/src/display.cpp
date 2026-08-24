#include "display.h"

#include <esp_heap_caps.h>

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
  // Left at the library default. It provably does nothing on this glass (see PANEL_OUTPUT_INVERTED
  // in display.h); polarity is corrected in software instead.

  panel->setRotation(0);           // portrait, 240x320, ribbon at the bottom
  panel->fillScreen(panelGrey(0));

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

// One row of pixels in internal, DMA-capable RAM.
//
// GFXcanvas16 allocates with plain malloc, and on this board that lands in PSRAM (confirmed at
// runtime: the buffers came back at 0x3c0f_xxxx while the internal heap moved by 120 bytes for
// 54 KB of canvas). SPI DMA cannot reliably source from PSRAM — the controller reads stale or
// unmapped data — which is exactly what a rectangle that flickers between the drawn frame and
// white looks like.
//
// Rather than fight GFXcanvas16's allocator, each row is copied into this internal staging buffer
// on its way out. 480 bytes of DMA-safe RAM, one memcpy of ~300 bytes per row, and the canvas keeps
// all of Adafruit_GFX's drawing primitives.
uint16_t* dmaRow = nullptr;

// Copies `len` pixels from a possibly-PSRAM source into the staging row and pushes them.
void pushRow(Adafruit_ILI9341& g, const uint16_t* src, int16_t len) {
  if (!dmaRow) return;
  memcpy(dmaRow, src, (size_t)len * sizeof(uint16_t));
  g.writePixels(dmaRow, len);
}

}  // namespace

bool displayBeginCanvases(uint16_t orbSize) {
  const uint32_t heapBefore = ESP.getFreeHeap();

  if (!orbCanvas) orbCanvas = new GFXcanvas16(orbSize, orbSize);
  if (!labelCanvas) labelCanvas = new GFXcanvas16(240, kLabelH);

  const uint16_t* orbBuf = orbCanvas ? orbCanvas->getBuffer() : nullptr;
  const uint16_t* labelBuf = labelCanvas ? labelCanvas->getBuffer() : nullptr;

  Serial.printf(
    "[display] canvases: orb %ux%u buf=%p (%u B), label 240x%d buf=%p (%u B), heap %u -> %u\n",
    (unsigned)orbSize, (unsigned)orbSize, (const void*)orbBuf,
    (unsigned)(orbSize * orbSize * 2), (int)kLabelH, (const void*)labelBuf,
    (unsigned)(240 * kLabelH * 2), (unsigned)heapBefore, (unsigned)ESP.getFreeHeap()
  );

  if (!dmaRow) {
    dmaRow = (uint16_t*)heap_caps_malloc(240 * sizeof(uint16_t), MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
  }

  Serial.printf("[display] dma row buf=%p (%s)\n", (const void*)dmaRow,
                dmaRow ? "internal/DMA" : "FAILED");

  if (!orbBuf || !labelBuf || !dmaRow) {
    Serial.println("[display] CANVAS ALLOCATION FAILED — the orb cannot be composited.");
    return false;
  }
  return true;
}

void displayDrawOrb(ThinkingOrb& orb, int16_t cx, int16_t cy, uint32_t elapsedMs) {
  // The buffer, not just the object: a GFXcanvas16 whose malloc failed is a live object wrapping a
  // null pointer, and pushing from it sends whatever happens to be in RAM — which is exactly what a
  // flickering white rectangle looks like.
  if (!displayReady() || !orbCanvas || !orbCanvas->getBuffer()) return;

  const OrbFrame frame = orb.render(elapsedMs);

  // One line, once, so a frame that draws nothing is distinguishable from a frame that draws and
  // fails to reach the glass.
  static bool reported = false;
  if (!reported) {
    reported = true;
    Serial.printf("[display] first orb frame: %u dots, canvas %dx%d\n",
                  (unsigned)frame.count, orbCanvas->width(), orbCanvas->height());
  }

  const int16_t w = orbCanvas->width();
  const int16_t h = orbCanvas->height();
  const int16_t mid = w / 2;

  orbCanvas->fillScreen(panelGrey(0));
  for (uint16_t i = 0; i < frame.count; ++i) {
    const OrbDot& d = frame.dots[i];
    const uint16_t colour = panelGrey(d.ink);
    const int16_t x = mid + d.x;
    const int16_t y = mid + d.y;
    // A 1 px dot as a filled circle costs a bounding-box walk for one pixel, and most of the
    // sphere is 1 px dots.
    if (d.radius <= 1) orbCanvas->drawPixel(x, y, colour);
    else orbCanvas->fillCircle(x, y, d.radius, colour);
  }

  // Pushed with setAddrWindow + writePixels rather than drawRGBBitmap.
  //
  // The two are not equivalent here: with an identical canvas fill, drawRGBBitmap rendered the orb
  // box as a white rectangle while the label strip — same buffer type, same fill value, pushed this
  // way — came out correctly black. Whatever drawRGBBitmap does to the pixel data on this
  // core/library combination, it does not round-trip. This path is the one with evidence behind it,
  // and it is also the one the label already uses, so there is a single blit idiom in the file.
  Adafruit_ILI9341& g = displayPanel();
  const uint16_t* buf = orbCanvas->getBuffer();
  g.startWrite();
  g.setAddrWindow(cx - mid, cy - mid, w, h);
  for (int16_t row = 0; row < h; ++row) {
    pushRow(g, buf + (size_t)row * w, w);
  }
  g.endWrite();
}

void displayDrawStatus(const char* label, int16_t cy, uint32_t elapsedMs) {
  if (!displayReady() || !labelCanvas || !labelCanvas->getBuffer() || !label) return;

  const size_t len = strlen(label);
  if (len == 0) return;

  const int16_t charW = 12;                       // 6 px base glyph at size 2
  const int16_t textW = (int16_t)(len * charW);
  const int16_t x0 = (int16_t)((240 - textW) / 2);

  // The web component sweeps a bright band across the label with a CSS gradient. There is no
  // gradient here, so the same read is produced per-glyph: a moving window of brighter characters.
  //
  // The sweep is slow and the brightness range is narrow on purpose. The first version swung each
  // glyph between 96 and 255 every 1.1 s, which at a glance is not a shimmer, it is a flicker —
  // eight characters strobing out of phase. 150..235 over 2.6 s reads as a highlight travelling
  // across a word.
  const float head = fmodf(elapsedMs / 2600.0f, 1.5f) * (len + 4.0f) - 2.0f;

  // Only the glyphs, and only the width they occupy, are repainted. Clearing and pushing the full
  // 240 px strip every frame made the whole line pulse against the background.
  const int16_t stripX = (int16_t)(x0 - 4 < 0 ? 0 : x0 - 4);
  const int16_t stripW = (int16_t)(textW + 8 > 240 ? 240 : textW + 8);

  labelCanvas->fillScreen(panelGrey(0));
  labelCanvas->setTextSize(2);
  for (size_t i = 0; i < len; ++i) {
    const float d = fabsf((float)i - head);
    const float lift = d > 2.6f ? 0.0f : (1.0f - d / 2.6f);
    const uint8_t grey = (uint8_t)(150 + lift * 85);
    labelCanvas->setTextColor(panelGrey(grey));
    labelCanvas->setCursor((x0 - stripX) + (int16_t)(i * charW), 4);
    labelCanvas->write(label[i]);
  }

  // Blit the sub-rectangle the text actually occupies. GFXcanvas16 has no stride-aware push, so the
  // rows are sent one at a time; that is still one transaction per row against 240 px of untouched
  // background per frame.
  Adafruit_ILI9341& g = displayPanel();
  const uint16_t* buf = labelCanvas->getBuffer();
  g.startWrite();
  g.setAddrWindow(stripX, cy - 4, stripW, kLabelH);
  for (int16_t row = 0; row < kLabelH; ++row) {
    pushRow(g, buf + (size_t)row * 240, stripW);
  }
  g.endWrite();
}
