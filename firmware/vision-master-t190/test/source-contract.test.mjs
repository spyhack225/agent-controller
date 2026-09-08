import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const BOARD = dirname(dirname(fileURLToPath(import.meta.url)));
const source = await readFile(join(BOARD, "src", "main.cpp"), "utf8");
const config = await readFile(join(BOARD, "include", "controller_config.example.h"), "utf8");
const ini = await readFile(join(BOARD, "platformio.ini"), "utf8");
const readme = await readFile(join(BOARD, "README.md"), "utf8");

test("T190 delegates identity, provisioning, gateway, and browsing to the shared core", () => {
  for (const header of ["DeviceStore.h", "Provisioning.h", "GatewayClient.h", "GatewayBrowse.h"]) {
    assert.match(source, new RegExp(`#include <${header.replace(".", "\\.")}>`, "u"));
  }
  assert.match(source, /store\.seedIdentityIfEmpty\(DEVICE_ID, DEVICE_SECRET, GATEWAY_BASE_URL\)/u);
  assert.match(source, /provisioning\.begin\(store, store\.deviceId\(\)\)/u);
  assert.match(source, /gateway\.startNetworkTask\(\)/u);
  assert.match(source, /browse\.begin\(store\)/u);
  assert.doesNotMatch(source, /\bHTTPClient\b|x-device-secret|setInsecure\s*\(/u);
});

test("T190 advertises only the hardware surface enabled by its compile-time gates", () => {
  assert.match(source, /gateway\.setCapabilities\(ENABLE_T190_DISPLAY != 0,\s*ENABLE_T190_EXTERNAL_ENCODER != 0,\s*false,\s*false\)/u);
  assert.match(config, /#ifndef ENABLE_T190_EXTERNAL_ENCODER\s*#define ENABLE_T190_EXTERNAL_ENCODER 0/u);
  assert.match(config, /#ifndef T190_EXTERNAL_ENCODER_PINS_VERIFIED\s*#define T190_EXTERNAL_ENCODER_PINS_VERIFIED 0/u);
  assert.match(source, /#if ENABLE_T190_EXTERNAL_ENCODER && !T190_EXTERNAL_ENCODER_PINS_VERIFIED\s*#error/u);
  assert.match(source, /HARDWARE DISABLED/u);
  assert.match(ini, /-DSECURE_BUILD_TLS_VERIFY=1/u);
  assert.doesNotMatch(ini, /-DENABLE_T190_EXTERNAL_ENCODER=1/u);
});

test("T190 renders truthful lifecycle and recovery boundaries", () => {
  for (const evidence of [
    "DEVICE SETUP",
    "FACTORY ID REQUIRED",
    "CLAIM THIS DEVICE",
    "ACCESS REMOVED",
    "STATUS-ONLY BUILD - INPUT DISABLED",
    "Cached state",
    "Identity is never erased locally",
  ]) assert.match(source, new RegExp(evidence, "u"));

  assert.match(source, /gateway\.link\(\) == GatewayLink::NoIdentity/u);
  assert.match(source, /gateway\.link\(\) == GatewayLink::Unclaimed/u);
  assert.match(source, /gateway\.link\(\) == GatewayLink::Revoked/u);
  assert.match(source, /kRecoveryHoldMs = 10000/u);
  assert.match(source, /provisioning\.resetToProvisioning\(\)/u);
});

test("verified input build follows the compact remote operate path", () => {
  for (const call of [
    "refreshEnvironments",
    "selectEnvironment",
    "refreshProjects",
    "selectProject",
    "refreshThreads",
    "selectThread",
    "createThread",
    "adoptThreadBinding",
    "runControl",
    "answerApproval",
    "fetchResponsePage",
  ]) assert.match(source, new RegExp(`\\.${call}\\(`, "u"), `${call} is absent`);

  assert.match(source, /cursor = 2;\s*screen = Screen::ApprovalDecision/u,
    "approval decision must default to Keep pending");
  assert.match(source, /cursor == 0 && row->risk == "high"/u);
  assert.match(source, /row->requiresConfirmation \|\| row->kind == "stop"/u);
  assert.match(source, /contextSyncPending && millis\(\) - contextSyncRequestedAt >= 2500/u);
  assert.match(source, /gateway\.link\(\) == GatewayLink::Claimed[\s\S]*gateway\.revision\(\) != contextSyncAfterRevision/u);
  assert.match(source, /WAIT FOR AUTHORITATIVE CONFIG/u);
  assert.match(source, /showPending\([\s\S]*render\(\)/u,
    "blocking gesture paths must paint a pending state before the request");
});

test("board documentation separates compile proof from physical proof", () => {
  assert.match(readme, /has not been flashed to a\s+T190/u);
  assert.match(readme, /compile-verified only/u);
  assert.match(readme, /bare T190 has one user button, not a rotary encoder/u);
  assert.match(readme, /Physical-only release gaps/u);
  assert.match(readme, /No microphone, camera, touch, battery telemetry, LoRa/u);
  assert.match(readme, /OTA apply is intentionally absent/u);
});
