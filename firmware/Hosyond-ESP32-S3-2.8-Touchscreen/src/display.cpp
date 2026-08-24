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
  pinMode(LCD_BL, OUTPUT);
  digitalWrite(LCD_BL, on ? HIGH : LOW);
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

  // Backlight goes on only after the framebuffer has been cleared. Enabling it first shows the
  // panel's power-on noise for a few hundred milliseconds, which reads as a fault.
  displayBacklight(true);

  ready = true;
  return true;
#endif
}
