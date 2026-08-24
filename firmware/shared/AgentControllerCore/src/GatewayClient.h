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
  NoIdentity,    // never provisioned: terminal, and the owner cannot fix it
  Idle,          // no network yet, or nothing asked since
  Connecting,    // online, first cycle not yet answered
  Unclaimed,     // authenticated, but no owner — claimCode() is what to show
  Claimed,       // owned and talking
  Revoked,       // credential rejected: revoked, or transfer-reset
  Unreachable,   // no gateway answered
};

class GatewayClient {
 public:
  void begin(DeviceStore& store, const String& hardwareModel, const String& firmwareVersion);

  // Run once the Wi-Fi link is up. `justConnected` fires every poll immediately rather than
  // waiting out its timer, which is what makes a fresh join show real state at once instead of up
  // to a minute later.
  //
  // Non-blocking in the sense that matters: at most one HTTP request per call.
  void runCycle(bool justConnected);

  // Call when the link is NOT up, so the client stops claiming to know anything.
  void goOffline();

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
  void fetchConfig();
  void fetchSetupCode(bool rotate);

  DeviceStore* store_ = nullptr;
  String hardwareModel_;
  String firmwareVersion_;

  GatewayLink link_ = GatewayLink::Idle;
  String claimCode_;
  String detail_;
  bool justClaimed_ = false;

  // Separate cadences, following the reference firmware: a heartbeat is cheap and proves liveness,
  // config changes rarely, and a claim code must not be re-requested on a timer at all.
  uint32_t nextHeartbeatAt_ = 0;
  uint32_t nextConfigAt_ = 0;
  uint32_t nextSetupCodeAt_ = 0;
  uint32_t backoffUntil_ = 0;   // honours 429 retry-after
  bool revoked_ = false;
};

const char* gatewayLinkName(GatewayLink link);
