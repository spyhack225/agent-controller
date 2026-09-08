# CrowPanel vendor materials (not tracked)

This folder holds Elecrow's CrowPanel ESP32 2.13" E-Paper HMI download kit: the example
repository, datasheets for the JD79661/EK79029 panel controller, the user manual, the 3D model,
and the CH34x USB driver installers. It is roughly 250 MB of archives and third-party example
code, so it is deliberately not committed. Everything except this file is ignored by Git.

Download it from Elecrow's wiki page and unpack it here:

<https://www.elecrow.com/wiki/CrowPanel_ESP32_E-Paper_HMI_2.13-inch_Display.html>

The parts the firmware actually builds against are already vendored into this board folder and
`firmware/shared/`; nothing in the PlatformIO build reads from `docs/`.
