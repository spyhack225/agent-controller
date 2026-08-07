# ESP32 Controller Configuration

Target board: **CrowPanel ESP32 2.13" E-Paper HMI Display**, 122x250, ESP32-S3-WROOM-1 N8R8.

- [Elecrow wiki](https://www.elecrow.com/wiki/CrowPanel_ESP32_E-Paper_HMI_2.13-inch_Display.html)
- [Vendor source and schematics](https://github.com/Elecrow-RD/CrowPanel-ESP32-2.13-E-paper-HMI-Display-with-122-250)

Create a private config before flashing real hardware:

```bash
cp include/controller_config.example.h include/controller_config.h
```

Then edit `include/controller_config.h` with:

- WiFi SSID/password.
- Gateway base URL.
- Device ID and secret from the factory or development registration endpoint.
- T3 environment ID and default thread ID.

The pin map in the example header is the real CrowPanel map, taken from Elecrow's factory
source, and should not need changing.

`controller_config.h` is ignored by git.

## Board notes

- **Panel power (GPIO7) must be driven HIGH before `display.init()`.** Skip it and the panel
  stays blank with BUSY asserted forever.
- **The SPI pins are not the ESP32-S3 defaults** (SCK 12, MOSI 11), so the firmware calls
  `SPI.begin(...)` to remap the bus before initialising GxEPD2. MISO is not wired.
- **There is no rotary encoder.** The "dial" is three discrete active-low switches (up 6,
  down 4, confirm 5) alongside MENU (2) and EXIT (1). All five have external pull-ups, so they
  are configured as plain `INPUT`.
- **Native USB is unavailable.** GPIO19 is the power LED, and GPIO19/20 are the ESP32-S3 native
  USB D-/D+ pins; the board programs over a USB-to-UART bridge. `ARDUINO_USB_CDC_ON_BOOT` must
  stay 0 or `Serial` goes to a port that does not exist.
- **The panel is a JD79661, and GxEPD2 cannot drive it.** Elecrow lists both SSD1680Z and
  JD79661 for this SKU and ships a driver for each; the units we have are JD79661. It uses a
  different command set from the SSD1680 (`0x10`/`0x13` RAM planes, software-loaded waveform
  LUTs, `0x17`+`0xA5` or `0x12` to refresh) and BUSY idles **HIGH** rather than LOW. GxEPD2's
  `GxEPD2_213_BN` hardcodes SSD1680 commands and `busy_level = HIGH`, so it waits on the idle
  level and blocks forever. The working driver is vendored at `lib/ElecrowEPD/`.
- **Use `EPD_Clear()`, never `EPD_ALL_Fill()`.** Both exist in that library, but `EPD_ALL_Fill()`
  is leftover SSD1680 code (`0x3C`/`0x24`) that this panel silently ignores. `EPD_Clear()` primes
  both RAM planes and loads the LUTs — without the LUTs a refresh returns in ~4 ms having done
  nothing, because this controller has no OTP waveform.
- **Both vendor busy-waits are unbounded `while` loops.** Anything ported out of that library
  needs a timeout, or a panel fault hangs the firmware. This is what made the original bring-up
  look like a dead board.

## Key map

| Key | GPIO | Action |
|---|---|---|
| Dial up | 6 | previous menu item |
| Dial down | 4 | next menu item |
| Dial confirm | 5 | submit the selected intent |
| MENU | 2 | refresh display state now |
| EXIT | 1 | fetch and show the claim/setup code |
