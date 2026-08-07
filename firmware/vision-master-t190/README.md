# Vision Master T190 firmware

This project scaffolds a PlatformIO firmware target for the Heltec Vision Master T190 (ESP32-S3R8, 170x320 color TFT).

## Quick start

```bash
cd firmware/vision-master-t190
cp include/controller_config.example.h include/controller_config.h
pio run
```

## Notes

- Update the WiFi credentials, gateway URL, and device credentials in `include/controller_config.h` before flashing.
- The display pins and encoder pins are placeholders and should be verified against the hardware wiring.
- The initial firmware brings up WiFi, shows status on the TFT screen, and attempts a simple gateway heartbeat when a real gateway URL is configured.
