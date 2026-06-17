# ESP32 Controller Configuration

Create a private config before flashing real hardware:

```bash
cp include/controller_config.example.h include/controller_config.h
```

Then edit `include/controller_config.h` with:

- WiFi SSID/password.
- Gateway base URL.
- Device ID and secret from the factory or development registration endpoint.
- T3 environment ID and default thread ID.
- Actual E213 board and EC11 encoder pins.

`controller_config.h` is ignored by git.
