// Bench probe for the CrowPanel 2.13" panel: panel supply rail sweep.
//
// Established on hardware so far:
//   * The panel is a JD79661, not an SSD1680Z. Elecrow's SSD1680 example
//     (example/arduino/Example Code/) hangs on the first busy-wait in
//     EPD_Init(); their JD79661 example (example/arduino-v1.2/) completes
//     EPD_Init() and EPD_ALL_Fill(). BUSY idles HIGH, the JD79661 convention.
//     => GxEPD2 cannot drive this panel: wrong command set AND wrong polarity.
//   * The controller accepts commands, but 0x04 POWER ON never completes: BUSY
//     goes busy and stays there. The charge pump that generates the panel's
//     +/-15V rails never starts, so the glass cannot change - and it doesn't.
//
// A controller that talks but cannot run its pump points at the supply rail.
// Elecrow drives GPIO7 HIGH for "screen power"; the closely related Heltec
// T190 drives its GPIO7 display rail ACTIVE LOW. This sweeps the candidates and
// reports which, if any, lets POWER ON finish.
//
// Build and run with:  pio run -e epd-probe -t upload && pio device monitor
#include <Arduino.h>
#include <SPI.h>

#if __has_include("controller_config.h")
#include "controller_config.h"
#else
#include "controller_config.example.h"
#endif

namespace {

constexpr uint32_t kSpiHz = 4000000;
constexpr uint16_t kPanelHeight = 250;
constexpr uint16_t kRowBytes = 16;
constexpr uint32_t kFrameBytes = static_cast<uint32_t>(kRowBytes) * kPanelHeight;

// JD79661: BUSY LOW = busy, HIGH = idle.
constexpr int kBusyIdle = HIGH;

void cmd(uint8_t value) {
  digitalWrite(EINK_DC, LOW);
  digitalWrite(EINK_CS, LOW);
  SPI.transfer(value);
  digitalWrite(EINK_CS, HIGH);
}

void data(uint8_t value) {
  digitalWrite(EINK_DC, HIGH);
  digitalWrite(EINK_CS, LOW);
  SPI.transfer(value);
  digitalWrite(EINK_CS, HIGH);
}

// The panel takes a moment to assert BUSY after a refresh command. Sampling
// immediately reports "idle" and races straight past the refresh, so wait for
// the busy edge first, then for the return to idle.
int32_t waitRefresh(const char* label, uint32_t timeoutMs) {
  const uint32_t start = millis();
  while (digitalRead(EINK_BUSY) == kBusyIdle) {
    if (millis() - start > 1000) {
      Serial.printf("  %s: BUSY never asserted - command ignored\n", label);
      return -1;
    }
    delayMicroseconds(200);
  }
  const uint32_t busyAt = millis();
  while (digitalRead(EINK_BUSY) != kBusyIdle) {
    if (millis() - start > timeoutMs) {
      Serial.printf("  %s: still busy after %lums\n", label, (unsigned long)timeoutMs);
      return -1;
    }
    delay(1);
  }
  Serial.printf("  %s: busy asserted at %lums, refresh took %lums\n", label,
                (unsigned long)(busyAt - start), (unsigned long)(millis() - busyAt));
  return static_cast<int32_t>(millis() - busyAt);
}

int32_t waitIdle(uint32_t timeoutMs) {
  const uint32_t start = millis();
  while (digitalRead(EINK_BUSY) != kBusyIdle) {
    if (millis() - start > timeoutMs) return -1;
    delay(1);
  }
  return static_cast<int32_t>(millis() - start);
}

void hardwareReset() {
  digitalWrite(EINK_RST, HIGH);
  delay(10);
  digitalWrite(EINK_RST, LOW);
  delay(100);
  digitalWrite(EINK_RST, HIGH);
  delay(100);
}

// Elecrow's arduino-v1.2 EPD_Init(), JD79661 register set.
void panelInit() {
  cmd(0x00); data(0xF7); data(0x8A);
  cmd(0x01); data(0x03); data(0x00); data(0x3F); data(0x3F); data(0x03);
  cmd(0x03); data(0x00);
  cmd(0x06); data(0x27); data(0x27); data(0x2F);
  cmd(0x30); data(0x0D);
  cmd(0x60); data(0x22);
  cmd(0x82); data(0x07);
  cmd(0xE3); data(0x88);
  cmd(0x41); data(0x00);
  cmd(0x61); data(0x80); data(0x00); data(0xFA);
  cmd(0x65); data(0x00); data(0x00); data(0x00);
  cmd(0x50); data(0xB7);
}

// The JD79661 has no OTP waveform: the LUTs must be pushed before every
// refresh, or the refresh command returns in milliseconds having done nothing.
// Transcribed from Elecrow's EPD_Init.cpp lut_GC(). Only the first eight bytes
// carry data; the controller expects all 56.
const uint8_t kLutR20[56] = {0x01, 0x00, 0x14, 0x14, 0x01, 0x00, 0x00, 0x01};
const uint8_t kLutR21[56] = {0x01, 0x60, 0x14, 0x14, 0x01, 0x00, 0x00, 0x01};
const uint8_t kLutR22[56] = {0x01, 0x20, 0x14, 0x14, 0x01, 0x00, 0x00, 0x01};
const uint8_t kLutR23[56] = {0x01, 0x10, 0x14, 0x14, 0x01, 0x00, 0x00, 0x01};
const uint8_t kLutR24[56] = {0x01, 0x90, 0x14, 0x14, 0x01, 0x00, 0x00, 0x01};

void writeLut(uint8_t reg, const uint8_t* lut) {
  cmd(reg);
  for (uint8_t index = 0; index < 56; index += 1) data(lut[index]);
}

void loadGcLut() {
  writeLut(0x20, kLutR20);
  writeLut(0x21, kLutR21);
  writeLut(0x24, kLutR24);
  writeLut(0x22, kLutR22);
  writeLut(0x23, kLutR23);
}

void writeFrame(uint8_t reg, uint8_t value) {
  cmd(reg);
  for (uint32_t index = 0; index < kFrameBytes; index += 1) data(value);
}

// POWER ON is the gate: if the charge pump cannot start, nothing downstream can
// possibly reach the glass, so this is the only result that matters here.
bool attempt(const char* label, int railLevel, int ledLevel) {
  Serial.printf("\n--- %s: GPIO%d=%s GPIO%d=%s ---\n", label,
                EINK_POWER_PIN, railLevel ? "HIGH" : "LOW",
                POWER_LED_PIN, ledLevel ? "HIGH" : "LOW");

  digitalWrite(POWER_LED_PIN, ledLevel);
  digitalWrite(EINK_POWER_PIN, railLevel);
  delay(300);

  hardwareReset();
  Serial.printf("  BUSY after reset = %d (%s)\n",
                digitalRead(EINK_BUSY), digitalRead(EINK_BUSY) == kBusyIdle ? "idle" : "busy");
  panelInit();

  cmd(0x04);  // POWER ON
  const int32_t powerMs = waitIdle(5000);
  if (powerMs < 0) {
    Serial.println("  POWER ON never completed - charge pump did not start");
    return false;
  }
  Serial.printf("  *** POWER ON completed in %ldms - THIS RAIL CONFIG WORKS ***\n",
                static_cast<long>(powerMs));

  // Try the vendor refresh command first, then the UC8151 fallback.
  Serial.println("  --> filling BLACK");
  cmd(0x50); data(0xD7);
  writeFrame(0x10, 0xFF);
  writeFrame(0x13, 0x00);
  loadGcLut();
  cmd(0x17); data(0xA5);
  int32_t refreshMs = waitRefresh("refresh 0x17", 25000);
  if (refreshMs < 0) {
    Serial.println("  retrying with 0x12");
    cmd(0x12);
    refreshMs = waitRefresh("refresh 0x12", 25000);
  }
  Serial.println("  *** LOOK AT THE PANEL: should be BLACK ***");
  delay(6000);

  Serial.println("  --> filling WHITE");
  cmd(0x50); data(0xD7);
  writeFrame(0x10, 0x00);
  writeFrame(0x13, 0xFF);
  loadGcLut();
  cmd(0x17); data(0xA5);
  if (waitRefresh("refresh 0x17", 25000) < 0) {
    cmd(0x12);
    waitRefresh("refresh 0x12", 25000);
  }
  Serial.println("  *** LOOK AT THE PANEL: should be WHITE ***");
  delay(6000);
  return refreshMs >= 0;
}

}  // namespace

void setup() {
  Serial.begin(115200);
  delay(2000);
  Serial.println("\n\n=== CrowPanel 2.13\" probe: panel supply rail sweep ===");

  pinMode(POWER_LED_PIN, OUTPUT);
  pinMode(EINK_POWER_PIN, OUTPUT);
  pinMode(EXPANSION_IO_A, OUTPUT);
  pinMode(EXPANSION_IO_B, OUTPUT);
  pinMode(EINK_CS, OUTPUT);
  pinMode(EINK_DC, OUTPUT);
  pinMode(EINK_RST, OUTPUT);
  pinMode(EINK_BUSY, INPUT);
  digitalWrite(EINK_CS, HIGH);

  SPI.begin(EINK_SCK, -1, EINK_MOSI, EINK_CS);
  SPI.beginTransaction(SPISettings(kSpiHz, MSBFIRST, SPI_MODE0));

  if (attempt("A rail HIGH (what Elecrow ships)", HIGH, HIGH)) { Serial.println("\ndone"); return; }
  if (attempt("B rail LOW (Heltec T190 convention)", LOW, HIGH)) { Serial.println("\ndone"); return; }
  if (attempt("C rail HIGH, LED pin LOW", HIGH, LOW)) { Serial.println("\ndone"); return; }
  if (attempt("D rail LOW, LED pin LOW", LOW, LOW)) { Serial.println("\ndone"); return; }

  Serial.println("\n=== no rail configuration started the charge pump ===");
  Serial.println("The controller answers on SPI but cannot raise its panel voltages.");
  Serial.println("That is characteristic of an unseated/damaged FPC or a faulty unit,");
  Serial.println("rather than a firmware problem.");
}

void loop() {
  delay(1000);
}
