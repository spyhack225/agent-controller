#pragma once

// Finds the gateway on the local network, so nobody has to type a URL on a device with no keyboard.
//
// Wire protocol, matching src/discovery.mjs on the gateway:
//
//   device  -> 255.255.255.255:3997   "AGENTCTL?"
//   gateway -> device (unicast)       {"service":"agent-controller","baseUrl":"http://…","name":…}
//
// The gateway replies with the address of ITS interface on our subnet, which is the part a device
// cannot work out for itself.

#include <Arduino.h>

struct GatewayCandidate {
  String baseUrl;
  String name;
  bool found = false;
};

// Broadcasts and waits up to `timeoutMs` for the first valid reply. Requires an active station
// connection — a device in pure SoftAP mode is not on the network it is trying to search.
GatewayCandidate discoverGateway(uint32_t timeoutMs = 1500);
