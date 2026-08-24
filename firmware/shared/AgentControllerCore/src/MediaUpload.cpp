#include "MediaUpload.h"

#include <string.h>

namespace {

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

namespace media {

void buildWavHeader(uint8_t header[kWavHeaderBytes], uint32_t dataBytes, uint32_t sampleRateHz,
                    uint16_t channels, uint16_t bitsPerSample) {
  const uint16_t blockAlign = static_cast<uint16_t>(channels * (bitsPerSample / 8));
  const uint32_t byteRate = sampleRateHz * blockAlign;

  memcpy(header + 0, "RIFF", 4);
  writeLe32(header + 4, 36 + dataBytes);
  memcpy(header + 8, "WAVE", 4);
  memcpy(header + 12, "fmt ", 4);
  writeLe32(header + 16, 16);           // PCM fmt chunk size
  writeLe16(header + 20, 1);            // audio format: PCM
  writeLe16(header + 22, channels);
  writeLe32(header + 24, sampleRateHz);
  writeLe32(header + 28, byteRate);
  writeLe16(header + 32, blockAlign);
  writeLe16(header + 34, bitsPerSample);
  memcpy(header + 36, "data", 4);
  writeLe32(header + 40, dataBytes);
}

}  // namespace media
