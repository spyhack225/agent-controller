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

bool displayBegin();
void displayBacklight(bool on);
Adafruit_ILI9341& displayPanel();

// True once displayBegin() has run successfully. Everything that draws checks this, so a board
// with ENABLE_LCD 0 or a failed init degrades to serial-only rather than crashing.
bool displayReady();
