import assert from "node:assert/strict";
import test from "node:test";

import { createApp } from "../src/app.mjs";
import {
  DEFAULT_HARDWARE_BOARD,
  HARDWARE_BOARDS,
  describeHardwareBoard,
  hardwareCapabilities,
} from "../src/hardware.mjs";
import { buildNvsSeedCsv } from "../src/manufacturing.mjs";

const listen = (server) => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

test("the default board is the one with a firmware validated end to end", () => {
  // CrowPanel is the reference implementation; an unspecified model must mean the proven board,
  // not whichever happens to be first in the list.
  assert.equal(DEFAULT_HARDWARE_BOARD, "e213-esp32-s3r8");
  assert.equal(describeHardwareBoard(DEFAULT_HARDWARE_BOARD).maturity, "complete");
});

test("every board names the firmware environment that builds its image", () => {
  // A claim label saying "flash the firmware" is useless when there are four of them.
  for (const board of HARDWARE_BOARDS) {
    assert.ok(board.firmwareEnv, `${board.id} has no firmwareEnv`);
    assert.ok(board.firmwareDir, `${board.id} has no firmwareDir`);
  }
});

test("capabilities follow the hardware, not the profile", () => {
  // The e-paper board has no microphone, so no profile can make audio capture possible on it.
  assert.equal(hardwareCapabilities("e213-esp32-s3r8").audioCapture, false);
  assert.equal(hardwareCapabilities("e213-esp32-s3r8").touchInput, false);
  assert.equal(hardwareCapabilities("ips28-esp32-s3r8").audioCapture, true);
  assert.equal(hardwareCapabilities("amoled175-esp32-s3r8").touchInput, true);
});

test("an unknown model is described, not rejected", () => {
  // A gateway that refuses a board built after it shipped would fail on a factory line.
  const board = describeHardwareBoard("future-board-9000");
  assert.equal(board.maturity, "unknown");
  assert.equal(board.id, "future-board-9000");
});

test("the NVS seed carries the board so a unit reports what it is", () => {
  const csv = buildNvsSeedCsv({
    deviceId: "dev_1",
    deviceSecret: "s3cret",
    gatewayBaseUrl: "http://10.0.0.2:3996",
    hardwareModel: "ips28-esp32-s3r8",
  });
  assert.match(csv, /^hw_model,data,string,ips28-esp32-s3r8$/mu);
  // NVS caps keys at 15 characters.
  for (const line of csv.trim().split("\n").slice(1)) {
    const key = line.split(",")[0];
    assert.ok(key.length <= 15, `${key} exceeds the NVS key limit`);
  }
});

test("the board catalogue is served to the console", async (t) => {
  const { server } = createApp();
  await listen(server);
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const response = await fetch(`${baseUrl}/v1/hardware/boards`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.defaultBoard, DEFAULT_HARDWARE_BOARD);
  assert.equal(body.boards.length, HARDWARE_BOARDS.length);
  assert.ok(body.boards.every((board) => typeof board.firmwareEnv === "string"));
});
