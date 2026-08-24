#include "display.h"

#include <esp_heap_caps.h>

#ifndef DISPLAY_FRAME_PROBE
#define DISPLAY_FRAME_PROBE 0
#endif

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
  // 80 MHz, which is what the vendor's own driver uses (docs/.../Example_01/spi_dev.h) — so it is
  // a rate this board's routing is known to carry, not an optimistic guess. Adafruit's 24 MHz
  // default left the frame time dominated by the blit: a 148x148 push is ~9 ms at 40 MHz against a
  // 33 ms budget that the orb maths had already mostly spent.
  panelFreq = 80000000;

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

// A GFXcanvas16 whose pixels live in INTERNAL RAM.
//
// The stock class allocates with plain malloc, which on this board lands in PSRAM, and the buffer
// then intermittently reads back as zeros. That was measured, not guessed: probing the buffer just
// before pushing it caught a frame where every sampled pixel was 0x0000 instead of the 0xFFFF the
// canvas had been filled with, while the surrounding frames were correct. Zeros on this inverted
// panel are white, which is the flickering box.
//
// Staging rows through DMA-capable RAM was necessary but not sufficient: the corruption is on the
// read side, before the copy. The fix is for the pixels never to be in PSRAM at all. 54 KB out of
// ~250 KB of free internal heap.
class InternalCanvas16 : public GFXcanvas16 {
 public:
  InternalCanvas16(uint16_t w, uint16_t h) : GFXcanvas16(w, h, false) {
    buffer = (uint16_t*)heap_caps_malloc((size_t)w * h * sizeof(uint16_t),
                                         MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    buffer_owned = false;   // freed here, not by the base destructor
  }
  ~InternalCanvas16() {
    heap_caps_free(buffer);
    buffer = nullptr;
  }
};

// Off-screen canvases, blitted in one transaction each.
//
// The first version drew every dot straight to the panel and erased the previous frame dot by dot.
// That is ~600 separate SPI transactions per frame, and the panel is scanning out the whole time,
// so the user sees the redraw sweep across the glass — the dark band visible in the bring-up
// video. Compositing in RAM and pushing one rectangle removes both problems: the cost stops
// scaling with dot count, and the panel never shows a half-built frame.
//
// A 148x148 canvas is 43 KB and the label strip is 11 KB, against ~300 KB of free internal heap.
// The orb composites as 8-bit coverage, not colour: it is greyscale by nature, this halves the
// buffer, and anti-aliasing wants to blend coverage rather than packed RGB565.
uint8_t* orbGrey = nullptr;
int16_t orbDim = 0;

InternalCanvas16* labelCanvas = nullptr;

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

  if (!orbGrey) {
    orbDim = (int16_t)orbSize;
    orbGrey = (uint8_t*)heap_caps_malloc((size_t)orbSize * orbSize,
                                         MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  }
  if (!labelCanvas) labelCanvas = new InternalCanvas16(240, kLabelH);

  const uint8_t* orbBuf = orbGrey;
  const uint16_t* labelBuf = labelCanvas ? labelCanvas->getBuffer() : nullptr;

  Serial.printf(
    "[display] buffers: orb %ux%u grey=%p (%u B), label 240x%d buf=%p (%u B), heap %u -> %u\n",
    (unsigned)orbSize, (unsigned)orbSize, (const void*)orbBuf,
    (unsigned)(orbSize * orbSize), (int)kLabelH, (const void*)labelBuf,
    (unsigned)(240 * kLabelH * 2), (unsigned)heapBefore, (unsigned)ESP.getFreeHeap()
  );

  if (!dmaRow) {
    dmaRow = (uint16_t*)heap_caps_malloc(240 * sizeof(uint16_t), MALLOC_CAP_DMA | MALLOC_CAP_INTERNAL);
  }

  Serial.printf("[display] dma row buf=%p (%s)\n", (const void*)dmaRow,
                dmaRow ? "internal/DMA" : "FAILED");

  if (!orbBuf || !labelBuf || !dmaRow) {
    Serial.println("[display] BUFFER ALLOCATION FAILED — the orb cannot be composited.");
    return false;
  }
  return true;
}

void displayDrawOrb(ThinkingOrb& orb, int16_t cx, int16_t cy, uint32_t elapsedMs) {
  if (!displayReady() || !orbGrey || !dmaRow) return;

  const OrbFrame frame = orb.render(elapsedMs);

  const int16_t w = orbDim;
  const int16_t h = orbDim;
  const int16_t mid = w / 2;

  memset(orbGrey, 0, (size_t)w * h);

  // Edges first, so nodes sit on top of their own links.
  //
  // Walked along the segment rather than rasterised over its bounding box. A near-diagonal edge
  // fills a box that is almost entirely empty, and at 30 nodes the constellation can have a hundred
  // of them — that approach measured 41 ms a frame against a 33 ms budget. Walking makes the cost
  // proportional to length instead of area.
  for (uint16_t i = 0; i < frame.lineCount; ++i) {
    const OrbLine& L = frame.lines[i];
    const float ax = mid + L.x16a / 16.0f, ay = mid + L.y16a / 16.0f;
    const float bx = mid + L.x16b / 16.0f, by = mid + L.y16b / 16.0f;
    const float ink = L.ink * (L.alpha / 255.0f);
    if (ink < 1.0f) continue;

    const float ex = bx - ax, ey = by - ay;
    const float len = sqrtf(ex * ex + ey * ey);
    if (len < 0.5f) continue;

    const int steps = (int)ceilf(len);
    const float sx = ex / steps, sy = ey / steps;

    for (int st = 0; st <= steps; ++st) {
      const float cxp = ax + sx * st;
      const float cyp = ay + sy * st;
      const int16_t bx0 = (int16_t)floorf(cxp - 1.0f);
      const int16_t by0 = (int16_t)floorf(cyp - 1.0f);

      // A 3x3 neighbourhood is enough for a hairline: anything wider is a stroke width this design
      // never uses.
      for (int16_t py = by0; py <= by0 + 2; ++py) {
        if (py < 0 || py >= h) continue;
        uint8_t* row = orbGrey + (size_t)py * w;
        for (int16_t px = bx0; px <= bx0 + 2; ++px) {
          if (px < 0 || px >= w) continue;
          const float dx = (px + 0.5f) - cxp, dy = (py + 0.5f) - cyp;
          const float d2 = dx * dx + dy * dy;
          if (d2 >= 1.0f) continue;         // outside the hairline; no sqrt needed
          float cov = 1.0f - sqrtf(d2);
          if (cov <= 0.0f) continue;
          const uint8_t v = (uint8_t)(ink * cov);
          if (v > row[px]) row[px] = v;
        }
      }
    }
  }

  // Anti-aliased splat, in 8-bit coverage rather than colour.
  //
  // Each dot contributes brightness proportional to how much of the pixel it actually covers, so a
  // dot drifting across a pixel boundary fades over rather than jumping. That is the whole
  // difference between "rotating sphere" and "twitching dots", and it is only possible because the
  // renderer now hands over sixteenths of a pixel instead of rounded integers.
  //
  // Overlap takes the maximum, not a sum: the dots are one colour on one ground, so adding would
  // blow out crossings into blobs, and the painter's far-to-near order already decides what should
  // read as being in front.
  for (uint16_t i = 0; i < frame.count; ++i) {
    const OrbDot& d = frame.dots[i];

    const float fx = mid + d.x16 / 16.0f;
    const float fy = mid + d.y16 / 16.0f;
    const float r = d.r16 / 16.0f;
    // Alpha folds into coverage: the ground is uniform, so a half-transparent dot and a
    // half-covered pixel are indistinguishable here, and one multiply is cheaper than a blend.
    const float ink = d.ink * (d.alpha / 255.0f);

    // Coverage falls off over one pixel at the rim. Wider looks blurred; narrower reintroduces the
    // hard edge that was aliasing in the first place.
    const float outer = r + 0.5f;
    const float outer2 = outer * outer;
    const float innerEdge = r - 0.5f;
    const float inner2 = innerEdge > 0.0f ? innerEdge * innerEdge : 0.0f;
    const int16_t x0 = (int16_t)floorf(fx - outer);
    const int16_t x1 = (int16_t)ceilf(fx + outer);
    const int16_t y0 = (int16_t)floorf(fy - outer);
    const int16_t y1 = (int16_t)ceilf(fy + outer);

    for (int16_t py = y0; py <= y1; ++py) {
      if (py < 0 || py >= h) continue;
      const float dy = (py + 0.5f) - fy;
      const float dy2 = dy * dy;
      uint8_t* row = orbGrey + (size_t)py * w;
      for (int16_t px = x0; px <= x1; ++px) {
        if (px < 0 || px >= w) continue;
        const float dx = (px + 0.5f) - fx;
        const float d2 = dx * dx + dy2;
        // Reject on squared distance first. The bounding box corners are always outside the disc,
        // so roughly a fifth of every dot's pixels were paying for a sqrt only to be discarded.
        if (d2 >= outer2) continue;
        // Fully-interior pixels are opaque and need no distance at all — for anything but the
        // smallest dots that is most of them.
        float cov = 1.0f;
        if (d2 > inner2) cov = outer - sqrtf(d2);
        if (cov <= 0.0f) continue;
        if (cov > 1.0f) cov = 1.0f;

        const uint8_t v = (uint8_t)(ink * cov);
        if (v > row[px]) row[px] = v;
      }
    }
  }

  // Convert a row at a time straight into the DMA staging buffer. The 8-bit coverage buffer is half
  // the RAM of the RGB565 canvas it replaces, and the colour conversion has to happen on the way
  // out regardless.
  Adafruit_ILI9341& g = displayPanel();
  g.startWrite();
  g.setAddrWindow(cx - mid, cy - mid, w, h);
  for (int16_t row = 0; row < h; ++row) {
    const uint8_t* src = orbGrey + (size_t)row * w;
    for (int16_t col = 0; col < w; ++col) dmaRow[col] = panelGrey(src[col]);
    g.writePixels(dmaRow, w);
  }
  g.endWrite();
}

void displayClearStatus(int16_t cy) {
  if (!displayReady()) return;
  // Full width, because only the caller knows the label changed and the incoming word may be
  // narrower than the outgoing one.
  displayPanel().fillRect(0, cy - 4, 240, kLabelH, panelGrey(0));
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
