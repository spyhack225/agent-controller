#pragma once

// Is the configured gateway actually there?
//
// A wrong gateway URL is invisible on this device: the screen says "Ready" because Wi-Fi joined,
// and nothing contradicts it until the owner tries to use the thing. This probe is what lets the
// device say so itself.

#include <Arduino.h>

enum class GatewayStatus : uint8_t {
  Unknown,        // not checked yet, or offline so it cannot be checked
  Reachable,
  Unreachable,    // no route, refused, timed out — the usual shape of a typo'd host
  BadResponse,    // something answered, but it is not a gateway
};

// Starts the background probe task. Safe to call once, from setup(), after Wi-Fi exists.
void gatewayProbeBegin();

GatewayStatus gatewayStatus();
const char* gatewayStatusText(GatewayStatus s);

// Forces the next probe to run immediately rather than waiting out the interval — used after the
// owner changes the URL, when they are standing there waiting to find out if it worked.
void gatewayProbeNow();
