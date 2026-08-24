// Hosyond / LCDWIKI ES3C28P — 2.8" IPS ESP32-S3 touchscreen module.
//
// Bring-up firmware with a working on-board audio capture path.
//
// This goes further than the Waveshare AMOLED scaffold because it can: every pin here comes from
// the manufacturer's own pin-allocation table, and the ES8311 codec driver is vendored in lib/, so
// the microphone path is real code rather than a TODO. Hold BOOT to record from the on-board MEMS
// microphone into PSRAM; release to stop. The clip is measured and optionally played back through
// the speaker connector, which verifies capture end to end **without a network, a cloud service,
// or any external audio source**.
//
// What is deliberately NOT here: the gateway client. Heartbeat, display state, intent submission,
// OTA, and media upload all still live inside the CrowPanel's main.cpp and have to be extracted
// into firmware/shared before any second board can talk to the gateway. See README.md.

#include <Arduino.h>
#include <WiFi.h>

#include "display.h"
#include "touch.h"

#ifndef ORB_BENCH
#define ORB_BENCH 0
#endif

#include <ThinkingOrb.h>

#include <DeviceStore.h>
#include <Provisioning.h>

#if __has_include("controller_config.h")
#include "controller_config.h"
#else
#include "controller_config.example.h"
#endif

#include <Wire.h>

#if ENABLE_AUDIO_CAPTURE
#include "driver/i2s_std.h"
#include "es8311.h"
#endif

#ifndef HARDWARE_MODEL
#define HARDWARE_MODEL "ips28-esp32-s3r8"
#endif
#ifndef FIRMWARE_VERSION
#define FIRMWARE_VERSION "0.1.0"
#endif

// Play each recording back through the speaker. Useful on the bench to prove the whole chain in
// one press; turn it off once the microphone is trusted, because a speaker next to a microphone
// is a feedback loop waiting for a reason.
#ifndef AUDIO_SELFTEST_PLAYBACK
#define AUDIO_SELFTEST_PLAYBACK 1
#endif

// Record a short clip at boot and report what the microphone actually produced. This is the
// first-run microphone diagnostic the roadmap asks for, and it is the only way to answer "is the
// mic alive" on a unit whose only button is also the provisioning reset.
#ifndef AUDIO_BOOT_SELFTEST_MS
#define AUDIO_BOOT_SELFTEST_MS 2000
#endif

namespace {

DeviceStore store;
Provisioning provisioning;

ProvisioningState lastState = ProvisioningState::Unprovisioned;

// Mode browser. The setup screen doubles as the place to see every animation, because that is the
// one screen a device sits on for minutes at a time with nothing else to say. Declared up here
// because reportState() consults it long before the screen code is defined.
bool orbBrowsing = false;
uint8_t browseIndex = 0;
uint32_t bootHeldSince = 0;
bool bootWasDown = false;

// ---------------------------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------------------------

#if ENABLE_AUDIO_CAPTURE

i2s_chan_handle_t txHandle = nullptr;
i2s_chan_handle_t rxHandle = nullptr;

int16_t* clipBuffer = nullptr;      // mono 16-bit PCM, PSRAM
size_t clipSamples = 0;             // valid samples in clipBuffer
size_t clipCapacity = 0;            // in samples, not bytes
bool audioReady = false;

constexpr size_t kFrameSamples = 512;   // per i2s_channel_read, per channel

bool i2sInit() {
  i2s_chan_config_t chanCfg =
      I2S_CHANNEL_DEFAULT_CONFIG((i2s_port_t)AUDIO_I2S_PORT, I2S_ROLE_MASTER);
  chanCfg.auto_clear = true;
  if (i2s_new_channel(&chanCfg, &txHandle, &rxHandle) != ESP_OK) return false;

  i2s_std_config_t stdCfg = {
      .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(AUDIO_SAMPLE_RATE_HZ),
      // Stereo slots: the microphone is mono, but the codec clocks out two channels either way.
      // The capture path keeps the left one.
      .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
      .gpio_cfg = {
          .mclk = (gpio_num_t)AUDIO_I2S_MCLK_PIN,
          .bclk = (gpio_num_t)AUDIO_I2S_BCLK_PIN,
          .ws   = (gpio_num_t)AUDIO_I2S_WS_PIN,
          .dout = (gpio_num_t)AUDIO_I2S_DOUT_PIN,
          .din  = (gpio_num_t)AUDIO_I2S_DIN_PIN,
          .invert_flags = {
              .mclk_inv = false,
              .bclk_inv = false,
              .ws_inv = false,
          },
      },
  };
  // The ES8311 driver configures itself for a 384x MCLK. The I2S side has to agree, or the codec
  // returns silence with no error reported anywhere.
  stdCfg.clk_cfg.mclk_multiple = I2S_MCLK_MULTIPLE_384;

  if (i2s_channel_init_std_mode(txHandle, &stdCfg) != ESP_OK) return false;
  if (i2s_channel_init_std_mode(rxHandle, &stdCfg) != ESP_OK) return false;
  if (i2s_channel_enable(txHandle) != ESP_OK) return false;
  if (i2s_channel_enable(rxHandle) != ESP_OK) return false;
  return true;
}

void speakerEnable(bool on) {
#if AUDIO_PA_ENABLE_ACTIVE_LOW
  digitalWrite(AUDIO_PA_ENABLE_PIN, on ? LOW : HIGH);
#else
  digitalWrite(AUDIO_PA_ENABLE_PIN, on ? HIGH : LOW);
#endif
}

bool audioInit() {
  pinMode(AUDIO_PA_ENABLE_PIN, OUTPUT);
  speakerEnable(false);

  if (!i2sInit()) {
    Serial.println("[audio] I2S init failed.");
    return false;
  }
  if (es8311_codec_init() != ESP_OK) {
    Serial.println("[audio] ES8311 init failed — check the codec is at 0x18 on the shared I2C bus.");
    return false;
  }

  // Microphone gain, which es8311_codec_init deliberately leaves at its default (the vendor left
  // the call commented out). A second handle is cheap — it is a struct holding the port and
  // address, and the register write is idempotent — and it keeps lib/ES8311 byte-identical to the
  // vendor drop rather than forking it for one line.
  es8311_handle_t gainHandle = es8311_create((i2c_port_t)I2C_PORT_NUM, ES8311_I2C_ADDR);
  if (gainHandle) {
    if (es8311_microphone_gain_set(gainHandle, AUDIO_MIC_GAIN) != ESP_OK) {
      Serial.println("[audio] Could not set microphone gain; continuing at the default.");
    }
    es8311_delete(gainHandle);
  }

  clipCapacity = AUDIO_CAPTURE_MAX_BYTES / sizeof(int16_t);
  clipBuffer = (int16_t*)ps_malloc(clipCapacity * sizeof(int16_t));
  if (!clipBuffer) {
    // Falling back to internal RAM would succeed for a very short clip and then fail confusingly
    // at a longer one, so refuse instead.
    Serial.println("[audio] Could not allocate the clip buffer in PSRAM.");
    return false;
  }

  Serial.printf("[audio] Ready. %u kHz mono, up to %u ms into %u KB of PSRAM.\n",
                (unsigned)(AUDIO_SAMPLE_RATE_HZ / 1000),
                (unsigned)AUDIO_CAPTURE_MAX_MS,
                (unsigned)(clipCapacity * sizeof(int16_t) / 1024));
  audioReady = true;
  return true;
}
// Reads one I2S frame and appends the left channel to the clip. Returns false when the clip is
// full, which is one of the three ways recording ends.
bool captureFrame() {
  static int16_t frame[kFrameSamples * 2];  // stereo slots

  size_t bytesRead = 0;
  if (i2s_channel_read(rxHandle, frame, sizeof(frame), &bytesRead, 200) != ESP_OK) return false;

  const size_t framesRead = bytesRead / (sizeof(int16_t) * 2);
  for (size_t i = 0; i < framesRead; ++i) {
    if (clipSamples >= clipCapacity) return false;
    int32_t sample = frame[i * 2];  // left channel
#if AUDIO_GAIN_SHIFT
    sample <<= AUDIO_GAIN_SHIFT;
    if (sample > INT16_MAX) sample = INT16_MAX;
    if (sample < INT16_MIN) sample = INT16_MIN;
#endif
    clipBuffer[clipSamples++] = (int16_t)sample;
  }
  return true;
}

// Peak and RMS are what tell you the microphone is alive without needing a speaker. A dead mic
// reads a flat zero; a clipping one pins peak at 32767.
struct ClipStats {
  int32_t peak;
  double rms;
  uint32_t ms;
  uint32_t dcOffset;   // a stuck codec often reads a constant non-zero value rather than zero
};

ClipStats measureClip() {
  ClipStats st = {0, 0.0, 0, 0};
  if (clipSamples == 0) return st;

  int64_t sum = 0;
  uint64_t sumSquares = 0;
  for (size_t i = 0; i < clipSamples; ++i) {
    const int32_t v = clipBuffer[i];
    const int32_t a = v < 0 ? -v : v;
    if (a > st.peak) st.peak = a;
    sum += v;
    sumSquares += (uint64_t)((int64_t)v * v);
  }
  st.rms = sqrt((double)sumSquares / (double)clipSamples);
  st.ms = (uint32_t)((uint64_t)clipSamples * 1000ULL / AUDIO_SAMPLE_RATE_HZ);
  const int64_t mean = sum / (int64_t)clipSamples;
  st.dcOffset = (uint32_t)(mean < 0 ? -mean : mean);
  return st;
}

void printClipVerdict(const ClipStats& st) {
  Serial.printf("[audio] %u ms, %u samples, %u bytes. peak %d, rms %.0f, dc %u",
                (unsigned)st.ms, (unsigned)clipSamples,
                (unsigned)(clipSamples * sizeof(int16_t)), (int)st.peak, st.rms,
                (unsigned)st.dcOffset);
  if (st.peak == 0) {
    Serial.print("  <- SILENT: the codec is not delivering samples");
  } else if (st.peak >= 32700) {
    Serial.print("  <- CLIPPING: lower the mic gain");
  } else if (st.rms < 8.0) {
    Serial.print("  <- VERY QUIET: check mic gain, or the room really is silent");
  }
  Serial.println();
}

void reportClip() {
  if (clipSamples == 0) {
    Serial.println("[audio] Nothing captured.");
    return;
  }

  const ClipStats st = measureClip();
  printClipVerdict(st);
  const uint32_t ms = st.ms;

  if (ms < AUDIO_CAPTURE_MIN_MS) {
    Serial.printf("[audio] Shorter than %u ms — discarded as a mis-tap.\n",
                  (unsigned)AUDIO_CAPTURE_MIN_MS);
    clipSamples = 0;
    return;
  }

  Serial.println("[audio] This is where the clip would upload to POST /v1/device/media and then");
  Serial.println("        submit an audio_prompt intent. Needs the shared gateway client first.");
}

#if AUDIO_SELFTEST_PLAYBACK
void playClip() {
  if (clipSamples == 0) return;

  Serial.println("[audio] Playing back through the speaker connector.");
  speakerEnable(true);

  // The clip is mono but the bus is running stereo slots, so duplicate each sample.
  static int16_t frame[kFrameSamples * 2];
  size_t offset = 0;
  while (offset < clipSamples) {
    const size_t chunk = min(kFrameSamples, clipSamples - offset);
    for (size_t i = 0; i < chunk; ++i) {
      frame[i * 2] = clipBuffer[offset + i];
      frame[i * 2 + 1] = clipBuffer[offset + i];
    }
    size_t written = 0;
    if (i2s_channel_write(txHandle, frame, chunk * 2 * sizeof(int16_t), &written, 1000) != ESP_OK) {
      Serial.println("[audio] Playback write failed.");
      break;
    }
    offset += chunk;
  }

  speakerEnable(false);
}
#endif  // AUDIO_SELFTEST_PLAYBACK

#if AUDIO_BOOT_SELFTEST_MS > 0
// Records for a fixed window with no button involved, so a unit whose only key is also the
// provisioning reset can still prove its microphone works.
void audioBootSelfTest() {
  if (!audioReady) return;

  Serial.printf("[audio] Self-test: recording %u ms from the on-board microphone...\n",
                (unsigned)AUDIO_BOOT_SELFTEST_MS);
  clipSamples = 0;
  const uint32_t startedAt = millis();
  // The first frames after the codec starts are unreliable while its ADC settles, so discard a
  // few before measuring rather than reporting a false SILENT.
  for (int i = 0; i < 4; ++i) captureFrame();
  clipSamples = 0;

  while (millis() - startedAt < AUDIO_BOOT_SELFTEST_MS) {
    if (!captureFrame()) break;
  }

  const ClipStats st = measureClip();
  printClipVerdict(st);
  if (st.peak > 0 && st.peak < 32700) {
    Serial.println("[audio] Self-test PASSED — the microphone is delivering samples.");
  } else {
    Serial.println("[audio] Self-test FAILED — see the verdict above.");
  }
  clipSamples = 0;
}
#endif

void recordWhileHeld() {
  if (!audioReady) return;

  Serial.println("[audio] Recording — release BOOT to stop.");
  clipSamples = 0;
  const uint32_t startedAt = millis();

  while (digitalRead(BOOT_BUTTON_PIN) == LOW) {
    if (!captureFrame()) {
      Serial.println("[audio] Clip buffer full.");
      break;
    }
    if (millis() - startedAt >= AUDIO_CAPTURE_MAX_MS) {
      Serial.println("[audio] Hit the maximum clip length.");
      break;
    }
  }

  reportClip();
#if AUDIO_SELFTEST_PLAYBACK
  playClip();
#endif
}

#endif  // ENABLE_AUDIO_CAPTURE

// ---------------------------------------------------------------------------------------------
// Boot reporting and provisioning
// ---------------------------------------------------------------------------------------------

void reportMemory() {
  Serial.printf("Flash size:  %u bytes\n", (unsigned)ESP.getFlashChipSize());
  Serial.printf("Heap free:   %u bytes\n", (unsigned)ESP.getFreeHeap());

  const size_t psram = ESP.getPsramSize();
  if (psram == 0) {
    Serial.println("PSRAM:       NOT DETECTED");
    Serial.println("  The vendor spec says 8 MB internal OPI PSRAM. Check that platformio.ini sets");
    Serial.println("  board_build.arduino.memory_type = qio_opi.");
    return;
  }
  Serial.printf("PSRAM:       %u bytes free of %u\n",
                (unsigned)ESP.getFreePsram(), (unsigned)psram);
}

void reportBattery() {
  // GPIO9 sits behind a divide-by-two, so the pin reads half the cell voltage. analogReadMilliVolts
  // applies the ESP32-S3's own ADC calibration, which is why this is not a raw-count conversion.
  const uint32_t mv = analogReadMilliVolts(BATTERY_ADC_PIN) * BATTERY_DIVIDER_RATIO;
  Serial.printf("Battery:     %u mV%s\n", (unsigned)mv,
                mv < 500 ? "  (no cell connected, or USB-only)" : "");
}

void reportIdentity() {
  if (store.hasIdentity()) {
    Serial.printf("Device id:   %s\n", store.deviceId().c_str());
    Serial.printf("Gateway:     %s\n", store.gatewayUrl().c_str());
    return;
  }
  Serial.println("Device id:   none in NVS");
  Serial.println("  Seed one by copying controller_config.example.h to controller_config.h and");
  Serial.println("  filling in DEVICE_ID / DEVICE_SECRET from POST /v1/devices, or flash a factory");
  Serial.println("  nvsSeed CSV from POST /v1/factory/batches.");
}

// Defined further down, with the rest of the screen code.
void setOrbState(OrbMode mode, const String& label, const String& context);

void reportState(ProvisioningState state) {
  const ProvisioningStatus& status = provisioning.status();
  // A state change while the user is flipping through animations would yank the screen away
  // mid-gesture. The serial line still reports it.
  Serial.printf("[provisioning] %s", provisioningStateName(state));
  if (status.detail.length()) Serial.printf(" — %s", status.detail.c_str());
  Serial.println();

  if (state == ProvisioningState::Provisioning) {
    Serial.printf("  Join \"%s\" and open %s to set Wi-Fi.\n",
                  status.apName.c_str(), status.portalUrl.c_str());
  }
  if (state == ProvisioningState::Online) {
    Serial.printf("  IP %s, RSSI %d dBm\n", WiFi.localIP().toString().c_str(), WiFi.RSSI());
  }

  if (orbBrowsing) return;

  switch (state) {
    case ProvisioningState::Provisioning:
      // Web, not Ring: the device is waiting on the owner, and a constellation trying to link up
      // says that better than a calm idle ring.
      setOrbState(OrbMode::Web, "Set up", status.apName);
      break;
    case ProvisioningState::Connecting:
      setOrbState(OrbMode::Web, "Connecting", status.detail);
      break;
    case ProvisioningState::Online:
      setOrbState(OrbMode::Ring, "Ready", WiFi.localIP().toString());
      break;
    case ProvisioningState::Failed:
      setOrbState(OrbMode::Ring, "Offline", status.detail);
      break;
    default:
      setOrbState(OrbMode::Ring, "Starting", status.detail);
      break;
  }
}

// BOOT is overloaded: a hold of PROVISIONING_RESET_HOLD_MS wipes Wi-Fi, while a shorter press
// starts a recording. The reset has to win, so recording only begins on release of a press that
// was too short to be a reset.
void pollBootButton() {
  const bool down = digitalRead(BOOT_BUTTON_PIN) == LOW;

  if (down && !bootWasDown) {
    bootHeldSince = millis();
    bootWasDown = true;
    return;
  }

  if (down) {
    if (millis() - bootHeldSince >= PROVISIONING_RESET_HOLD_MS) {
      Serial.println("[provisioning] BOOT held — clearing Wi-Fi and re-entering provisioning.");
      provisioning.resetToProvisioning();
      bootWasDown = false;
      // Wait out the release so the same hold does not immediately start a recording.
      while (digitalRead(BOOT_BUTTON_PIN) == LOW) delay(10);
    }
    return;
  }

  if (!bootWasDown) return;
  bootWasDown = false;

  // A short press opens the config portal. This is the escape hatch for a wrong gateway URL: the
  // portal closes as soon as Wi-Fi joins, so without it a typo left the device online, unable to
  // reach any gateway, and recoverable only by the long-press wipe — which also destroys Wi-Fi
  // credentials that were perfectly good.
  Serial.println("[provisioning] BOOT tapped — opening the config portal.");
  provisioning.openConfigPortal();
}

// The controller screen.
//
// One orb, one verb, one line of context, on near-black. That is the whole design, and it is the
// web console's language rather than a shrunk-down dashboard: at arm's length on a 2.8" panel the
// only things that read are motion and a single short word.
//
// The orb is the state. Its mode says what the agent is doing without the user parsing text, which
// matters because this device is glanced at, not read.

ThinkingOrb orb;
uint32_t orbStartedAt = 0;
OrbMode currentMode = OrbMode::Ring;
String statusLabel = "Starting";
String contextLine = "";
bool chromeDrawn = false;

constexpr int16_t kScreenW = 240;
constexpr int16_t kScreenH = 320;
constexpr int16_t kOrbCx = kScreenW / 2;
constexpr int16_t kOrbCy = 118;
constexpr int16_t kLabelY = 208;
constexpr int16_t kContextY = 244;

// ~30 fps. The orb maths and the panel blit together measure ~27 ms on this board, so this is the
// cadence the hardware can actually hold rather than an aspiration.
constexpr uint32_t kFrameMs = 33;

// Frame statistics.
//
// Draw time alone was not enough to explain a visible hitch: it stayed at 27 ms while the animation
// still stumbled, which means the stall was somewhere else in the loop. So the interval BETWEEN
// frames is measured as well as the work inside one, and anything that blocks — the captive portal,
// DNS, the Wi-Fi stack — shows up as a gap even though it never touches the renderer.
struct FrameStats {
  uint32_t frames = 0;
  uint32_t worstDrawMs = 0;
  uint32_t worstGapMs = 0;
  uint32_t hitches = 0;        // intervals beyond 1.5x the budget
  uint32_t worstPollMs = 0;    // provisioning/portal work, the prime suspect
  float fps = 0.0f;

  // Never reset. The interesting stall is the one that happens while nothing is watching, so the
  // worst gap since boot has to survive the per-window reset to be reportable after the fact.
  uint32_t worstGapEverMs = 0;
  uint32_t hitchesEver = 0;
};

FrameStats stats;
uint32_t lastFrameAt = 0;
uint32_t nextFrameAt = 0;

// Greys, resolved through panelGrey() so the panel's polarity is applied in one place.
constexpr uint8_t kBgGrey = 0;      // #000, the ground the web component sits on
constexpr uint8_t kDimGrey = 56;    // hairlines
constexpr uint8_t kMutedGrey = 132; // secondary text

// Static chrome, drawn once. Redrawing it every frame would triple the SPI traffic for pixels that
// never change.
void drawChrome() {
  if (!displayReady()) return;
  Adafruit_ILI9341& g = displayPanel();
  g.fillScreen(panelGrey(kBgGrey));

  g.setTextSize(1);
  g.setTextColor(panelGrey(kMutedGrey));
  g.setCursor(12, 14);
  g.print("AGENT CONTROLLER");

  g.drawFastHLine(12, 30, kScreenW - 24, panelGrey(kDimGrey));
  g.drawFastHLine(12, kScreenH - 34, kScreenW - 24, panelGrey(kDimGrey));

  g.setTextColor(panelGrey(kDimGrey));
  g.setCursor(12, kScreenH - 24);
  g.print(HARDWARE_MODEL);

  chromeDrawn = true;
}

// Bottom-right, and only when the number changes. A counter that repaints every frame is itself a
// load, and one that flickers is worse than none.
void drawFpsReadout() {
  if (!displayReady()) return;
  static uint32_t lastDrawAt = 0;
  static int lastShown = -1;

  const uint32_t now = millis();
  if (now - lastDrawAt < 1000) return;
  lastDrawAt = now;

  const int shown = (int)(stats.fps + 0.5f);
  if (shown == lastShown) return;
  lastShown = shown;

  Adafruit_ILI9341& g = displayPanel();
  char buf[16];
  snprintf(buf, sizeof(buf), "%d fps", shown);
  const int16_t w = (int16_t)(strlen(buf) * 6);
  const int16_t x = kScreenW - 12 - w;
  const int16_t y = kScreenH - 24;

  g.fillRect(x - 2, y - 2, w + 6, 12, panelGrey(kBgGrey));
  g.setTextSize(1);
  // Amber when the budget is being missed, so a glance is enough.
  g.setTextColor(shown >= 27 ? panelGrey(kDimGrey) : panelGrey(200));
  g.setCursor(x, y);
  g.print(buf);
}

void drawContext(const String& text) {
  if (!displayReady()) return;
  Adafruit_ILI9341& g = displayPanel();
  g.fillRect(0, kContextY - 2, kScreenW, 16, panelGrey(kBgGrey));
  if (text.length() == 0) return;

  g.setTextSize(1);
  g.setTextColor(panelGrey(kMutedGrey));
  const int16_t w = (int16_t)(text.length() * 6);
  g.setCursor((kScreenW - w) / 2, kContextY);
  g.print(text);
}

void setOrbState(OrbMode mode, const String& label, const String& context) {
  const bool contextChanged = context != contextLine;
  const bool labelChanged = label != statusLabel;
  currentMode = mode;
  statusLabel = label;
  contextLine = context;

  orb.setMode(mode);
  if (!chromeDrawn) drawChrome();
  if (labelChanged) displayClearStatus(kLabelY);
  if (contextChanged || !chromeDrawn) drawContext(context);
}

// Called from loop(). The orb owns the frame budget: at ~30 ms a frame the sphere reads as smooth
// without starving Wi-Fi or the provisioning portal, both of which share this core.
// Swipe through the nine states; tap returns to whatever the device is actually doing.
void pollOrbBrowser() {
#if ORB_BENCH
  // Bench build: walk every mode on a timer so each one's cost can be measured without a finger.
  static uint32_t nextAt = 0;
  const uint32_t now = millis();
  if (now >= nextAt) {
    nextAt = now + 6000;
    const uint8_t count = (uint8_t)OrbMode::ModeCount;
    browseIndex = (uint8_t)((browseIndex + 1) % count);
    orbBrowsing = true;
    const OrbMode m = orbModeAt(browseIndex);
    setOrbState(m, orbLabelForMode(m),
                String(browseIndex + 1) + "/" + String(count) + "  " + orbStateName(m));
  }
  return;
#endif
  const TouchGesture g = touchPoll();
  if (g == TouchGesture::None) return;

  if (g == TouchGesture::Tap && orbBrowsing) {
    orbBrowsing = false;
    Serial.println("[orb] browser off; following device state again");
    reportState(provisioning.status().state);
    return;
  }

  if (g == TouchGesture::SwipeLeft || g == TouchGesture::SwipeRight) {
    const uint8_t count = (uint8_t)OrbMode::ModeCount;
    if (!orbBrowsing) {
      orbBrowsing = true;
      browseIndex = (uint8_t)currentMode;
    }
    browseIndex = (uint8_t)((g == TouchGesture::SwipeLeft)
                            ? (browseIndex + 1) % count
                            : (browseIndex + count - 1) % count);
    const OrbMode m = orbModeAt(browseIndex);
    Serial.printf("[orb] %u/%u %s\n", (unsigned)(browseIndex + 1), (unsigned)count,
                  orbStateName(m));
    setOrbState(m, orbLabelForMode(m),
                String(browseIndex + 1) + "/" + String(count) + "  " + orbStateName(m));
  }
}

void drawFpsReadout();

void tickScreen() {
  if (!displayReady()) return;

  // Paced against a running deadline rather than "33 ms since the last frame finished". The latter
  // adds the draw time to every interval, so a 27 ms draw yields 37 ms frames — 27 fps that also
  // wanders as the draw cost changes. A deadline keeps the cadence even, which the eye notices more
  // than the rate.
  const uint32_t now = millis();
  if (nextFrameAt == 0) nextFrameAt = now;
  if ((int32_t)(now - nextFrameAt) < 0) return;
  nextFrameAt += kFrameMs;
  // If a frame ran long, do not try to catch up by drawing several back to back — that reads as a
  // stutter followed by a sprint. Drop the missed slots and resync.
  if ((int32_t)(now - nextFrameAt) > (int32_t)kFrameMs) nextFrameAt = now + kFrameMs;

  if (lastFrameAt != 0) {
    const uint32_t gap = now - lastFrameAt;
    if (gap > stats.worstGapMs) stats.worstGapMs = gap;
    if (gap > stats.worstGapEverMs) stats.worstGapEverMs = gap;
    if (gap > kFrameMs * 3 / 2) { stats.hitches++; stats.hitchesEver++; }
  }
  lastFrameAt = now;

  const uint32_t elapsed = now - orbStartedAt;
  const uint32_t drawStart = millis();
  displayDrawOrb(orb, kOrbCx, kOrbCy, elapsed);
  displayDrawStatus(statusLabel.c_str(), kLabelY, elapsed);

  // Frame pacing is the other half of smoothness: an animation that renders beautifully but
  // arrives at uneven intervals still reads as stutter. Reported rarely, and only worst-case,
  // because the average hides exactly the frames that are visible.
  const uint32_t drawMs = millis() - drawStart;
  if (drawMs > stats.worstDrawMs) stats.worstDrawMs = drawMs;
  stats.frames++;

  static uint32_t lastReport = 0;
  if (lastReport == 0) lastReport = now;
  if (now - lastReport >= 2000) {
    const uint32_t windowMs = now - lastReport;
    stats.fps = stats.frames * 1000.0f / windowMs;
    // The mode is on the line because draw cost varies enormously between them, so a slow frame
    // is only diagnosable if you know what was being drawn.
    Serial.printf(
      "[fps] %-10s %.1f  draw<=%ums  gap<=%ums  poll<=%ums  hitches=%u  budget=%ums  heap=%u\n",
      orbStateName(currentMode), stats.fps, (unsigned)stats.worstDrawMs,
      (unsigned)stats.worstGapMs, (unsigned)stats.worstPollMs, (unsigned)stats.hitches,
      (unsigned)kFrameMs, (unsigned)ESP.getFreeHeap());
    Serial.printf("      since boot: worst gap %u ms, %u hitches, up %u s\n",
                  (unsigned)stats.worstGapEverMs, (unsigned)stats.hitchesEver,
                  (unsigned)(millis() / 1000));
    stats.frames = 0;
    stats.worstDrawMs = 0;
    stats.worstGapMs = 0;
    stats.worstPollMs = 0;
    stats.hitches = 0;
    lastReport = now;
  }

  drawFpsReadout();
}

}  // namespace

void setup() {
  Serial.begin(115200);

  // Never block on a serial write.
  //
  // This board's Serial is the ESP32-S3's native USB CDC, and by default a write waits for the host
  // to drain the TX buffer. With a monitor attached that is invisible; with nothing reading, the
  // buffer fills and every Serial.printf stalls the loop for the timeout — which presents as the
  // animation freezing at 0 fps for anyone watching the panel rather than the console. The bug is
  // therefore masked by the very tool used to look for it: measured over 200 s with a monitor
  // attached, this firmware held 30.3 fps with zero hitches.
  //
  // 0 means "write what fits, drop the rest". Diagnostics are worth exactly nothing if printing
  // them is what stops the device working.
  Serial.setTxTimeoutMs(0);

  // Native USB CDC needs a moment before the host enumerates it; anything printed earlier is lost.
  delay(2000);

  Serial.println();
  Serial.println("=== Agent Controller — Hosyond ES3C28P 2.8\" IPS ESP32-S3 ===");
  Serial.printf("Model:       %s\n", HARDWARE_MODEL);
  Serial.printf("Firmware:    %s\n", FIRMWARE_VERSION);
  reportMemory();
  reportBattery();

  pinMode(BOOT_BUTTON_PIN, INPUT_PULLUP);

  // One I2C bus, shared by the FT6336G touch controller, the ES8311 codec and the external header.
  // It is started here rather than inside audio init because touch needs it in builds that have no
  // audio at all — which is exactly how the display build failed to see the touch controller.
  if (!Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN, I2C_SPEED_HZ)) {
    Serial.println("[i2c] Wire.begin failed; touch and codec will not respond.");
  }

  if (displayBegin()) {
    Serial.println("[display] ILI9341V up, 240x320, backlight on.");
    touchBegin();
    // 132 px across, comfortably inside the 240 px panel, and a dot budget that keeps a frame
    // under the 30 ms tick.
    if (displayBeginCanvases(148) && orb.begin(140, 900)) {
      orbStartedAt = millis();
      setOrbState(OrbMode::Ring, "Starting", "");
    } else {
      Serial.println("[display] Orb allocation failed; running without it.");
    }
  } else {
    Serial.println("[display] Not initialised (ENABLE_LCD is 0, or init failed).");
  }

  if (!store.begin()) {
    // An NVS failure here means the partition table is wrong. Nothing after this would work.
    Serial.println("FATAL: NVS unavailable. Check board_build.partitions in platformio.ini.");
    return;
  }

  store.seedIdentityIfEmpty(DEVICE_ID, DEVICE_SECRET, GATEWAY_BASE_URL);
  reportIdentity();

#if ENABLE_AUDIO_CAPTURE
  if (audioInit()) {
#if AUDIO_BOOT_SELFTEST_MS > 0
    audioBootSelfTest();
#endif
  }
#else
  Serial.println("[audio] Disabled. Build -e hosyond-es3c28p-capture to enable the microphone.");
#endif

  provisioning.begin(store, store.deviceId());
  lastState = provisioning.status().state;
  reportState(lastState);

  // -----------------------------------------------------------------------------------------
  // Not yet implemented, in dependency order:
  //
  //   Gateway client       — extract from the CrowPanel main.cpp into firmware/shared. Blocks
  //                          heartbeat, display state, intent submission, OTA, and media upload.
  //   ILI9341V over SPI    — 240x320, framebuffer fits in SRAM.
  //   FT6336G touch        — I2C 0x38, interrupt on GPIO17.
  //   On-screen UI         — thread list, agent reply, approve/reject, push-to-talk target.
  //   RGB LED indicator    — GPIO42, recording state.
  // -----------------------------------------------------------------------------------------
}

void loop() {
  const uint32_t pollStart = millis();
  const ProvisioningState state = provisioning.poll();
  const uint32_t pollMs = millis() - pollStart;
  if (pollMs > stats.worstPollMs) stats.worstPollMs = pollMs;
  if (state != lastState) {
    lastState = state;
    reportState(state);
  }

  if (provisioning.consumeJustConnected()) {
    Serial.println("[provisioning] joined — the gateway handshake would run here.");
  }

#if ENABLE_AUDIO_CAPTURE
  // Push-to-talk: once BOOT has been down long enough to be intentional but not long enough to be
  // a provisioning reset, stream until it is released.
  if (audioReady && digitalRead(BOOT_BUTTON_PIN) == LOW) {
    delay(50);  // debounce
    if (digitalRead(BOOT_BUTTON_PIN) == LOW) {
      const uint32_t pressedAt = millis();
      recordWhileHeld();
      // If that turned out to be a long hold, honour the reset too.
      if (millis() - pressedAt >= PROVISIONING_RESET_HOLD_MS) {
        Serial.println("[provisioning] BOOT held — clearing Wi-Fi and re-entering provisioning.");
        provisioning.resetToProvisioning();
      }
      while (digitalRead(BOOT_BUTTON_PIN) == LOW) delay(10);
      bootWasDown = false;
      return;
    }
  }
#endif

  pollOrbBrowser();
  tickScreen();
  pollBootButton();

  // Sleep until the next frame is actually due, rather than spinning on delay(1).
  //
  // Polling in 1 ms steps means a frame fires on the first iteration AFTER its deadline, so the
  // interval was landing anywhere in 33..36 ms even though the work took 23 ms. That wander is
  // small in absolute terms and very visible in an animation: the sphere advances by an uneven
  // amount each frame. Waiting for the deadline directly removes it, and stops the touch
  // controller being polled over I2C ten times per frame for no benefit.
  const int32_t waitMs = (int32_t)(nextFrameAt - millis());
  if (waitMs > 1) delay((uint32_t)(waitMs - 1));
  else delay(1);
}
