import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const gatewayUrl = requiredEnv("AGENT_CONTROLLER_URL").replace(/\/+$/u, "");
const factoryToken = requiredEnv("FACTORY_TOKEN");
const outputDir = process.env.OUTPUT_DIR ?? ".manufacturing";
const count = Number.parseInt(process.env.COUNT ?? "1", 10);

const body = {
  count,
  labelPrefix: process.env.LABEL_PREFIX ?? "Agent Controller",
  profile: process.env.DEVICE_PROFILE ?? "agent-controller",
  gatewayBaseUrl: process.env.PUBLIC_GATEWAY_URL ?? gatewayUrl,
  wifiSsid: process.env.WIFI_SSID ?? "your-wifi",
  wifiPassword: process.env.WIFI_PASSWORD ?? "your-password",
  hardwareModel: process.env.HARDWARE_MODEL ?? "e213-esp32-s3r8",
  firmwareVersion: process.env.FIRMWARE_VERSION ?? "0.1.0",
  enableOtaApply: process.env.ENABLE_OTA_APPLY === "1",
  requireOtaSignature: process.env.REQUIRE_OTA_SIGNATURE === "1",
  otaManifestVerifyKey: process.env.OTA_MANIFEST_VERIFY_KEY ?? "",
};

const response = await fetch(new URL("/v1/factory/batches", gatewayUrl), {
  method: "POST",
  headers: {
    authorization: `Bearer ${factoryToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(body),
});

const payload = await response.json();
if (!response.ok) {
  throw new Error(`Batch provisioning failed with HTTP ${response.status}: ${JSON.stringify(payload)}`);
}

await mkdir(outputDir, { recursive: true });
await writeFile(join(outputDir, "batch.json"), JSON.stringify(payload, null, 2));
for (const item of payload.devices) {
  await writeFile(join(outputDir, item.flashConfigFilename), item.flashConfig);
}

console.log(`Created ${payload.devices.length} factory device(s).`);
console.log(`Wrote batch manifest and controller_config.h files to ${outputDir}`);
for (const item of payload.devices) {
  console.log(`${item.device.id} claim=${item.claimCode} config=${item.flashConfigFilename}`);
}

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
