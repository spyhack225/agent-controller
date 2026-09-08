# Hosyond ES3C28P vendor materials (not tracked)

This folder holds the vendor's `2.8inch_IPS_ESP32-S3_ILI9341V_ES3C28P_ES3N28P_V1.0` kit: the
schematic and specification (section 4.2 is the pin allocation the board README cites), the
ILI9341V init sequence, ESP32-S3 datasheets, the 3D models, the flash download tool, and a
30-example Arduino/ESP-IDF pack with its bundled third-party libraries. It is over a gigabyte
unpacked and is not ours to redistribute, so it is deliberately not committed. Everything except
this file is ignored by Git.

Obtain the kit from the vendor's download link for the ES3C28P / ES3N28P product (Hosyond and
LCDWIKI publish the same archive) and unpack it here so the paths referenced in the board README
and `platformio.ini` comments resolve.

The pin map, display init, and ES8311 audio driver were transcribed from those sources into
`include/controller_config.example.h` and the board sources; nothing in the PlatformIO build
reads from `docs/`.
