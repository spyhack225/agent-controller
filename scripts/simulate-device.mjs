const baseUrl = process.env.AGENT_CONTROLLER_URL ?? "http://127.0.0.1:3996";
const userId = process.env.AGENT_CONTROLLER_USER_ID ?? "user_dev";

async function main() {
  const authHeaders = await createDevAuthHeaders();
  const device = await post("/v1/devices", {
    label: "Simulated controller",
    profile: "agent-controller",
  }, authHeaders);

  console.log("Registered device:");
  console.log(JSON.stringify(device, null, 2));
  console.log("\nUse these for device-authenticated calls:");
  console.log(`x-device-id: ${device.device.id}`);
  console.log(`x-device-secret: ${device.secret}`);
}

async function createDevAuthHeaders() {
  const created = await post("/v1/users/dev", {
    userId,
    email: "dev@example.local",
    tokenLabel: "Simulated device script",
  });
  return { authorization: `Bearer ${created.apiToken.secret}` };
}

async function post(path, body, headers = {}) {
  const response = await fetch(new URL(path, baseUrl), {
    method: "POST",
    headers: {
      ...headers,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(`${path} failed: ${JSON.stringify(data)}`);
  }
  return data;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
