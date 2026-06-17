const gatewayUrl = requiredEnv("AGENT_CONTROLLER_URL").replace(/\/+$/u, "");
const factoryToken = requiredEnv("FACTORY_TOKEN");

const body = {
  version: requiredEnv("FIRMWARE_VERSION"),
  hardwareModel: process.env.HARDWARE_MODEL ?? "e213-esp32-s3r8",
  url: requiredEnv("FIRMWARE_URL"),
  sha256: requiredEnv("FIRMWARE_SHA256"),
  sizeBytes: Number.parseInt(requiredEnv("FIRMWARE_SIZE_BYTES"), 10),
  mandatory: process.env.FIRMWARE_MANDATORY === "1",
  releaseNotes: process.env.FIRMWARE_RELEASE_NOTES ?? "",
};

const response = await fetch(new URL("/v1/factory/firmware/releases", gatewayUrl), {
  method: "POST",
  headers: {
    authorization: `Bearer ${factoryToken}`,
    "content-type": "application/json",
  },
  body: JSON.stringify(body),
});

const payload = await response.json();
if (!response.ok) {
  throw new Error(`Firmware publish failed with HTTP ${response.status}: ${JSON.stringify(payload)}`);
}

console.log(JSON.stringify(payload, null, 2));

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
