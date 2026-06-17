#pragma once

// Copy this file to controller_config.h for real hardware builds.
// Keep controller_config.h out of git because it contains WiFi and device secrets.

#define WIFI_SSID "your-wifi"
#define WIFI_PASSWORD "your-password"

// Use your deployed gateway URL, for example:
//   https://gateway.example.com
//   http://192.168.1.20:3996
#define GATEWAY_BASE_URL "http://127.0.0.1:3996"

// Values returned by POST /v1/factory/devices or POST /v1/devices.
#define DEVICE_ID "dev_replace_me"
#define DEVICE_SECRET "replace_me"

#define HARDWARE_MODEL "e213-esp32-s3r8"
#define FIRMWARE_VERSION "0.1.0"

// OTA apply is off by default for bench bring-up. Set to 1 when the partition
// table, rollback plan, and release process have been tested on real hardware.
#define ENABLE_OTA_APPLY 0

// Prototype manifest verification uses the gateway HMAC key. This is useful for
// development, but production hardware should move to asymmetric signatures.
#define REQUIRE_OTA_SIGNATURE 0
#define OTA_MANIFEST_VERIFY_KEY ""

// The environment/thread defaults are used by the encoder menu prompt actions.
// The status action only needs ENVIRONMENT_ID.
#define ENVIRONMENT_ID "env_replace_me"
#define THREAD_ID "thread_replace_me"

// Default prompt sent by the hardware when the Prompt menu item is pressed.
#define DEFAULT_AGENT_PROMPT "Continue the current task, inspect progress, and run relevant tests."

// Default shell command sent by the hardware when the Shell menu item is pressed.
// The gateway policy still screens the command before dispatching it to T3 Code.
#define DEFAULT_SHELL_COMMAND "npm test"

// Hardware pins. Adjust these for the actual E213 board revision and wiring.
#define ENCODER_PIN_A 4
#define ENCODER_PIN_B 5
#define ENCODER_BUTTON_PIN 6

// E-ink pins. The E213 board variants differ; verify against your schematic.
#define EINK_CS 10
#define EINK_DC 11
#define EINK_RST 12
#define EINK_BUSY 13

// Set to 0 if you want to bring up networking and encoder logic before wiring the display.
#define ENABLE_EINK 1

// TLS certificate validation is intentionally disabled in this first firmware scaffold so
// self-hosted HTTPS gateways work during bring-up. Pin the gateway certificate before production.
#define INSECURE_SKIP_TLS_VERIFY 1
