import assert from "node:assert/strict";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadState, removeState, runtimeStatePath, saveRuntimeState, saveState, STATE_VERSION, validateHttpUrl } from "../src/config.mjs";

const sample = {
  version: STATE_VERSION,
  server: "https://controller.example",
  connectorId: "con_1",
  environmentId: "env_1",
  secret: "standing-secret",
  t3BaseUrl: "http://127.0.0.1:3773",
  t3AccessToken: "local-only",
};

test("state is atomically persisted with restricted permissions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "connector-state-"));
  const path = await saveState(dir, sample);
  assert.deepEqual(await loadState(dir), sample);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  await removeState(dir);
  assert.equal(await loadState(dir), null);
});

test("only loopback may use plaintext HTTP", () => {
  assert.equal(validateHttpUrl("http://localhost:3773", "T3", { allowHttpLoopback: true }), "http://localhost:3773");
  assert.throws(() => validateHttpUrl("http://192.168.1.5:3773", "T3", { allowHttpLoopback: true }), /HTTPS/);
  assert.equal(validateHttpUrl("https://controller.example/", "server"), "https://controller.example");
});

test("stale managed-service telemetry cannot overwrite a credential rotation journal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "connector-runtime-state-"));
  await saveState(dir, sample);
  const staleManagedState = await loadState(dir);
  await saveState(dir, {
    ...staleManagedState,
    credentialRotation: {
      id: "rot_1",
      pendingSecret: "next-standing-secret",
      phase: "staged",
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    },
  });

  // The already-running service still holds its pre-rotation object. Runtime
  // persistence must update only the sidecar, never connector.json.
  await saveRuntimeState(dir, {
    ...staleManagedState,
    lastConnectedAt: "2026-01-01T00:00:00.000Z",
  });

  const recovered = await loadState(dir);
  assert.equal(recovered.secret, sample.secret);
  assert.equal(recovered.credentialRotation.id, "rot_1");
  assert.equal(recovered.credentialRotation.pendingSecret, "next-standing-secret");
  assert.equal(recovered.lastConnectedAt, "2026-01-01T00:00:00.000Z");
  if (process.platform !== "win32") assert.equal((await stat(runtimeStatePath(dir))).mode & 0o777, 0o600);
});
