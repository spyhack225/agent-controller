#pragma once

// The device's side of the gateway conversation: authenticate, heartbeat, and — before either of
// those can work — get claimed.
//
// This exists because a device cannot be set up by flashing it. The end user has no toolchain and
// no serial cable. The product flow is:
//
//   factory   flashes an identity (device id + secret) once, from POST /v1/factory/batches
//   device    boots, calls the gateway, and is told 403 because nobody owns it yet
//   device    asks POST /v1/device/setup-code and SHOWS the claim code on its screen
//   owner     types that code into the console
//   device    next heartbeat succeeds, and it belongs to them
//
// Only the first step involves flashing, it happens once per unit at manufacture, and it is the
// same image for every unit — the identity is data in NVS, not code.
//
// Lifted out of the CrowPanel firmware, where all of this lived inside a 3600-line main.cpp and so
// could not be used by any other board.

#include <Arduino.h>

#include "DeviceStore.h"

enum class GatewayLink : uint8_t {
  Idle,          // no network yet
  Unclaimed,     // authenticated as a device, but no owner — claimCode() is what to show
  Claimed,       // owned and talking
  AuthFailed,    // credentials rejected: revoked, or seeded against a different gateway
  Unreachable,   // no gateway answered
};

class GatewayClient {
 public:
  void begin(DeviceStore& store, const String& hardwareModel, const String& firmwareVersion);

  // Non-blocking. Call from loop(); it does at most one HTTP request per invocation and rate-limits
  // itself, so the render loop keeps its frame budget.
  void poll();

  GatewayLink link() const { return link_; }
  const String& claimCode() const { return claimCode_; }
  const String& detail() const { return detail_; }

  // True once after the device transitions into Claimed, so the caller can refresh its screen.
  bool consumeJustClaimed();

  // Owner asking for a replacement code ("I lost the card"). Never called on a timer: rotating
  // invalidates the code already printed or displayed.
  void requestNewClaimCode();

 private:
  int request(const char* method, const char* path, const String& body, String& response);
  void sendHeartbeat();
  void fetchSetupCode(bool rotate);

  DeviceStore* store_ = nullptr;
  String hardwareModel_;
  String firmwareVersion_;

  GatewayLink link_ = GatewayLink::Idle;
  String claimCode_;
  String detail_;
  bool justClaimed_ = false;

  uint32_t nextHeartbeatAt_ = 0;
  uint32_t nextSetupCodeAt_ = 0;
};

const char* gatewayLinkName(GatewayLink link);
