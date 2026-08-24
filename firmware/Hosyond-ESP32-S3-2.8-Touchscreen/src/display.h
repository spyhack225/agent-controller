#pragma once

// ILI9341V panel adapter for the Hosyond ES3C28P.
//
// The panel has no reset GPIO — its reset is tied to the ESP32-S3's CHIP_PU rail, so the only way
// to reset the panel is to reset the chip. Adafruit_ILI9341 accepts -1 for that.
//
// The SPI pins are not the ESP32-S3 defaults, so the bus is remapped with SPI.begin() before the
// panel is initialised.

#include <Arduino.h>
#include <Adafruit_ILI9341.h>

#include <Adafruit_GFX.h>
#include <ThinkingOrb.h>

// Panel output polarity.
//
// This glass renders what we send inverted: a 0x0000 fill comes out white. Both invertDisplay(true)
// and invertDisplay(false) were flashed and photographed, and the screen was identical white both
// times — the ILI9341's INVON/INVOFF simply does not control this panel's polarity, whatever the
// vendor's own init sequence does with 0x21 alongside their own gamma and power registers.
//
// So the correction happens here, where the bytes are ours and the result is deterministic. Every
// colour written to the panel goes through panelRgb()/panelGrey(). Flip this to 0 for a panel that
// behaves normally; it is one constant rather than a hunt through the drawing code.
#ifndef PANEL_OUTPUT_INVERTED
#define PANEL_OUTPUT_INVERTED 1
#endif

// Applies the panel's polarity to a finished RGB565 value.
inline uint16_t panelRgb(uint16_t rgb565) {
#if PANEL_OUTPUT_INVERTED
  return (uint16_t)~rgb565;
#else
  return rgb565;
#endif
}

// Greyscale convenience: 0 is ink-black on screen, 255 is white on screen, whatever the panel does.
inline uint16_t panelGrey(uint8_t g) {
  const uint16_t c = (uint16_t)(((g & 0xF8) << 8) | ((g & 0xFC) << 3) | (g >> 3));
  return panelRgb(c);
}

bool displayBegin();

// Allocates the off-screen canvases the orb and label composite into. Must be called after
// displayBegin() and before either draw function.
bool displayBeginCanvases(uint16_t orbSize);

// Paints one orb frame centred at (cx, cy). Dots are drawn far-to-near as the renderer ordered
// them, so overlap reads as depth.
void displayDrawOrb(ThinkingOrb& orb, int16_t cx, int16_t cy, uint32_t elapsedMs);

// The status line under the orb, with the shimmer sweep the web component uses. `phase` advances
// the highlight; pass the same elapsedMs as the orb.
// Only the rectangle the current text occupies is repainted, so switching to a SHORTER label must
// be preceded by displayClearStatus() — otherwise the wider previous word leaves its ends on the
// glass ("Connecting" showing around "Weaving").
void displayDrawStatus(const char* label, int16_t cy, uint32_t elapsedMs);
void displayClearStatus(int16_t cy);
void displayBacklight(bool on);
Adafruit_ILI9341& displayPanel();

// True once displayBegin() has run successfully. Everything that draws checks this, so a board
// with ENABLE_LCD 0 or a failed init degrades to serial-only rather than crashing.
bool displayReady();
