#pragma once

// Copy this file to controller_config.h before flashing real hardware.
// Keep controller_config.h out of git because it contains WiFi and device secrets.

#define WIFI_SSID "your-wifi"
#define WIFI_PASSWORD "your-password"

// Use your deployed gateway URL, for example:
//   https://gateway.example.com
//   http://192.168.1.20:3996
#define GATEWAY_BASE_URL "http://127.0.0.1:3996"

// Values returned by the factory or development registration endpoint.
#define DEVICE_ID "dev_replace_me"
#define DEVICE_SECRET "replace_me"

#define HARDWARE_MODEL "vision-master-t190"
#define FIRMWARE_VERSION "0.1.0"

// Board-specific defaults for the Vision Master T190.
// Adjust these to the exact wired pins once the hardware is available.
#define ENCODER_PIN_A 1
#define ENCODER_PIN_B 2
#define ENCODER_BUTTON_PIN 3

#define DISPLAY_CS 39
#define DISPLAY_DC 47
#define DISPLAY_SDA 48
#define DISPLAY_SCL 38
#define DISPLAY_RST 40
#define DISPLAY_BL 42

// Default prompt and environment values used by the controller flow.
#define ENVIRONMENT_ID "env_replace_me"
#define THREAD_ID "thread_replace_me"
#define DEFAULT_AGENT_PROMPT "Continue the current task, inspect progress, and run relevant tests."
#define DEFAULT_SHELL_COMMAND "npm test"
