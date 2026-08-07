#include "media_capture.h"

#include <cstring>

#if ENABLE_AUDIO_CAPTURE
// The legacy driver/i2s.h API is used deliberately: it is the one that exists
// on both the IDF 4.4 core this project pins today and the IDF 5.x cores, so
// the firmware is not tied to an ESP-IDF major version. It carries a
// deprecation warning on IDF 5.x builds.
#include <driver/i2s.h>
#endif

#if ENABLE_CAMERA_CAPTURE
#if !__has_include("esp_camera.h")
#error "ENABLE_CAMERA_CAPTURE=1 needs esp32-camera. It ships with the ESP32 Arduino core; on a core that lacks it, add espressif/esp32-camera to lib_deps."
#endif
#include "esp_camera.h"
#endif

namespace capture {

#if ENABLE_AUDIO_CAPTURE

namespace {

constexpr i2s_port_t kPort = static_cast<i2s_port_t>(AUDIO_I2S_PORT);

// One i2s_read() never covers a whole clip. Keeping the chunk small is what
// makes push-to-talk feel like a button rather than a timer: the caller regains
// control every few milliseconds to re-check whether the key is still down.
constexpr size_t kPcmChunkBytes = 1024;

// Stack window used to narrow 32-bit slots. 128 slots = 512 B in, 256 B out.
constexpr size_t kSlotWindow = 128;

bool driverInstalled = false;

void writeLe16(uint8_t* out, uint16_t value) {
  out[0] = static_cast<uint8_t>(value & 0xFF);
  out[1] = static_cast<uint8_t>((value >> 8) & 0xFF);
}

void writeLe32(uint8_t* out, uint32_t value) {
  out[0] = static_cast<uint8_t>(value & 0xFF);
  out[1] = static_cast<uint8_t>((value >> 8) & 0xFF);
  out[2] = static_cast<uint8_t>((value >> 16) & 0xFF);
  out[3] = static_cast<uint8_t>((value >> 24) & 0xFF);
}

}  // namespace

bool audioBegin() {
  if (driverInstalled) return true;

  i2s_config_t config = {};
  config.mode = static_cast<i2s_mode_t>(
#if AUDIO_MIC_PDM
    I2S_MODE_MASTER | I2S_MODE_RX | I2S_MODE_PDM
#else
    I2S_MODE_MASTER | I2S_MODE_RX
#endif
  );
  config.sample_rate = AUDIO_SAMPLE_RATE_HZ;
  config.bits_per_sample = static_cast<i2s_bits_per_sample_t>(AUDIO_SLOT_BITS);
  // A single mic drives one slot. Asking for stereo would double the buffer for
  // a duplicate channel.
  config.channel_format = I2S_CHANNEL_FMT_ONLY_LEFT;
  config.communication_format = I2S_COMM_FORMAT_STAND_I2S;
  config.intr_alloc_flags = ESP_INTR_FLAG_LEVEL1;
  config.dma_buf_count = 4;
  config.dma_buf_len = 512;
  config.use_apll = false;
  config.tx_desc_auto_clear = false;
  config.fixed_mclk = 0;

  esp_err_t status = i2s_driver_install(kPort, &config, 0, nullptr);
  if (status != ESP_OK) {
    Serial.printf("[audio] i2s_driver_install failed: %d\n", static_cast<int>(status));
    return false;
  }

  i2s_pin_config_t pins = {};
  pins.mck_io_num = I2S_PIN_NO_CHANGE;
#if AUDIO_MIC_PDM
  // PDM RX has no bit clock or word select: the driver emits the PDM clock on
  // ws_io_num and samples data_in_num.
  pins.bck_io_num = I2S_PIN_NO_CHANGE;
  pins.ws_io_num = AUDIO_I2S_CLK_PIN;
#else
  pins.bck_io_num = AUDIO_I2S_CLK_PIN;
  pins.ws_io_num = AUDIO_I2S_WS_PIN;
#endif
  pins.data_out_num = I2S_PIN_NO_CHANGE;
  pins.data_in_num = AUDIO_I2S_DATA_PIN;

  status = i2s_set_pin(kPort, &pins);
  if (status != ESP_OK) {
    Serial.printf("[audio] i2s_set_pin failed: %d\n", static_cast<int>(status));
    i2s_driver_uninstall(kPort);
    return false;
  }

  // The first DMA buffers hold whatever the mic emitted while its charge pump
  // settled, which is a loud click at the head of every clip.
  i2s_zero_dma_buffer(kPort);
  driverInstalled = true;
  return true;
}

void audioEnd() {
  if (!driverInstalled) return;
  i2s_driver_uninstall(kPort);
  driverInstalled = false;
}

size_t audioReadPcm(uint8_t* destination, size_t maxBytes, uint32_t timeoutMs) {
  if (!driverInstalled || destination == nullptr || maxBytes < 2) return 0;

#if AUDIO_SLOT_BITS == 16
  size_t wanted = maxBytes & ~static_cast<size_t>(1);
  if (wanted > kPcmChunkBytes) wanted = kPcmChunkBytes;

  size_t bytesRead = 0;
  const esp_err_t status = i2s_read(kPort, destination, wanted, &bytesRead, pdMS_TO_TICKS(timeoutMs));
  if (status != ESP_OK) return 0;
  // A partial slot would desynchronise every following sample.
  return bytesRead & ~static_cast<size_t>(1);
#else
  size_t wantedSamples = maxBytes / 2;
  if (wantedSamples > kSlotWindow) wantedSamples = kSlotWindow;
  if (wantedSamples == 0) return 0;

  int32_t slots[kSlotWindow];
  size_t bytesRead = 0;
  const esp_err_t status = i2s_read(
    kPort,
    slots,
    wantedSamples * sizeof(int32_t),
    &bytesRead,
    pdMS_TO_TICKS(timeoutMs)
  );
  if (status != ESP_OK) return 0;

  const size_t samples = bytesRead / sizeof(int32_t);
  if (samples == 0) return 0;

  // 24-bit data sits left-justified in the 32-bit slot, so the usable 16 bits
  // are the top ones. Clamp instead of letting the shift wrap, or a loud sample
  // inverts into a click.
  int16_t narrowed[kSlotWindow];
  for (size_t index = 0; index < samples; index += 1) {
    int32_t sample = slots[index] >> (16 - AUDIO_GAIN_SHIFT);
    if (sample > 32767) sample = 32767;
    if (sample < -32768) sample = -32768;
    narrowed[index] = static_cast<int16_t>(sample);
  }

  const size_t outBytes = samples * sizeof(int16_t);
  memcpy(destination, narrowed, outBytes);
  return outBytes;
#endif
}

void buildWavHeader(uint8_t header[44], uint32_t dataBytes) {
  const uint32_t sampleRate = static_cast<uint32_t>(AUDIO_SAMPLE_RATE_HZ);
  const uint16_t channels = 1;
  const uint16_t bitsPerSample = 16;
  const uint16_t blockAlign = static_cast<uint16_t>(channels * (bitsPerSample / 8));
  const uint32_t byteRate = sampleRate * blockAlign;

  memcpy(header + 0, "RIFF", 4);
  writeLe32(header + 4, 36 + dataBytes);
  memcpy(header + 8, "WAVE", 4);
  memcpy(header + 12, "fmt ", 4);
  writeLe32(header + 16, 16);           // PCM fmt chunk size
  writeLe16(header + 20, 1);            // audio format: PCM
  writeLe16(header + 22, channels);
  writeLe32(header + 24, sampleRate);
  writeLe32(header + 28, byteRate);
  writeLe16(header + 32, blockAlign);
  writeLe16(header + 34, bitsPerSample);
  memcpy(header + 36, "data", 4);
  writeLe32(header + 40, dataBytes);
}

#endif  // ENABLE_AUDIO_CAPTURE

#if ENABLE_CAMERA_CAPTURE

namespace {
bool cameraInitialised = false;
camera_fb_t* heldFrame = nullptr;
}  // namespace

bool cameraBegin() {
  if (cameraInitialised) return true;

  camera_config_t config = {};
  config.pin_pwdn = CAMERA_PIN_PWDN;
  config.pin_reset = CAMERA_PIN_RESET;
  config.pin_xclk = CAMERA_PIN_XCLK;
  config.pin_sccb_sda = CAMERA_PIN_SIOD;
  config.pin_sccb_scl = CAMERA_PIN_SIOC;
  config.pin_d7 = CAMERA_PIN_D7;
  config.pin_d6 = CAMERA_PIN_D6;
  config.pin_d5 = CAMERA_PIN_D5;
  config.pin_d4 = CAMERA_PIN_D4;
  config.pin_d3 = CAMERA_PIN_D3;
  config.pin_d2 = CAMERA_PIN_D2;
  config.pin_d1 = CAMERA_PIN_D1;
  config.pin_d0 = CAMERA_PIN_D0;
  config.pin_vsync = CAMERA_PIN_VSYNC;
  config.pin_href = CAMERA_PIN_HREF;
  config.pin_pclk = CAMERA_PIN_PCLK;
  config.xclk_freq_hz = CAMERA_XCLK_FREQ_HZ;
  config.ledc_timer = LEDC_TIMER_0;
  config.ledc_channel = LEDC_CHANNEL_0;
  config.pixel_format = PIXFORMAT_JPEG;
  config.jpeg_quality = CAMERA_JPEG_QUALITY;
  config.fb_count = 1;
  // Only the newest frame matters for a still, and one buffer is all the
  // internal RAM budget allows on a PSRAM-less board.
  config.grab_mode = CAMERA_GRAB_LATEST;

  if (psramFound()) {
    config.frame_size = CAMERA_FRAME_SIZE;
    config.fb_location = CAMERA_FB_IN_PSRAM;
  } else {
    // An SVGA JPEG frame buffer does not fit in internal DRAM alongside WiFi.
    config.frame_size = FRAMESIZE_QVGA;
    config.fb_location = CAMERA_FB_IN_DRAM;
  }

  const esp_err_t status = esp_camera_init(&config);
  if (status != ESP_OK) {
    Serial.printf("[camera] esp_camera_init failed: 0x%x\n", static_cast<int>(status));
    return false;
  }

  cameraInitialised = true;

  // The sensor's first frame is exposed with the power-on gain, so it is
  // usually unusable. Throw it away rather than sending it to a vision model.
  camera_fb_t* warmup = esp_camera_fb_get();
  if (warmup) esp_camera_fb_return(warmup);
  return true;
}

bool cameraCaptureJpeg(const uint8_t** data, size_t* length) {
  if (!cameraInitialised || data == nullptr || length == nullptr) return false;
  // A leaked frame buffer starves the driver on the next capture.
  cameraRelease();

  heldFrame = esp_camera_fb_get();
  if (heldFrame == nullptr) {
    Serial.println("[camera] esp_camera_fb_get returned null");
    return false;
  }
  if (heldFrame->format != PIXFORMAT_JPEG || heldFrame->len == 0) {
    Serial.println("[camera] frame is not a non-empty JPEG");
    cameraRelease();
    return false;
  }

  *data = heldFrame->buf;
  *length = heldFrame->len;
  return true;
}

void cameraRelease() {
  if (heldFrame == nullptr) return;
  esp_camera_fb_return(heldFrame);
  heldFrame = nullptr;
}

#endif  // ENABLE_CAMERA_CAPTURE

}  // namespace capture
