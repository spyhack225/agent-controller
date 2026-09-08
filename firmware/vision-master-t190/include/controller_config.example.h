#pragma once

// Copy this file to controller_config.h before flashing real hardware.
// Keep controller_config.h out of git because it contains WiFi and device secrets.

#define WIFI_SSID "your-wifi"
#define WIFI_PASSWORD "your-password"

// Use your deployed gateway URL, for example:
//   https://gateway.example.com
//   http://192.168.1.20:3996 (explicit local bench mode only; see below)
#define GATEWAY_BASE_URL "http://127.0.0.1:3996"

// Values returned by the factory or development registration endpoint.
#define DEVICE_ID "dev_replace_me"
#define DEVICE_SECRET "replace_me"

#define HARDWARE_MODEL "vision-master-t190"
#define FIRMWARE_VERSION "0.2.0"

// The T190 has no onboard rotary encoder. These three GPIOs describe an OPTIONAL external encoder
// attached to the exposed headers. Input stays compiled out until the exact carrier wiring has
// been checked on hardware; enabling it without the separate verification flag is a build error.
#ifndef ENABLE_T190_EXTERNAL_ENCODER
#define ENABLE_T190_EXTERNAL_ENCODER 0
#endif
#ifndef T190_EXTERNAL_ENCODER_PINS_VERIFIED
#define T190_EXTERNAL_ENCODER_PINS_VERIFIED 0
#endif
#define ENCODER_PIN_A 1
#define ENCODER_PIN_B 2
#define ENCODER_BUTTON_PIN 3

// Display net names are transcribed from the bundled Heltec schematic, but this adapter has not
// been exercised on silicon. DISPLAY_POWER is active-low. DISPLAY_BL is the LEDK_EN net.
#ifndef ENABLE_T190_DISPLAY
#define ENABLE_T190_DISPLAY 1
#endif
#define DISPLAY_CS 39
#define DISPLAY_DC 47
#define DISPLAY_SDA 48
#define DISPLAY_SCL 38
#define DISPLAY_RST 40
#define DISPLAY_POWER 7
#define DISPLAY_BL 17

// Default prompt and environment values used by the controller flow.
#define ENVIRONMENT_ID "env_replace_me"
#define THREAD_ID "thread_replace_me"
#define DEFAULT_AGENT_PROMPT "Continue the current task, inspect progress, and run relevant tests."
#define DEFAULT_SHELL_COMMAND "npm test"

// HTTPS fails closed unless the cloud gateway's issuing root is configured. Concatenate a current
// and next root during rotation. Set INSECURE_SKIP_TLS_VERIFY=1 only in a local bench config; it
// exposes the long-lived device credential to interception.
#define GATEWAY_TLS_ROOT_CA_PEM ""
#define GATEWAY_TLS_NEXT_ROOT_CA_PEM ""
#define INSECURE_SKIP_TLS_VERIFY 0
