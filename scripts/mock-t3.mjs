import { createServer } from "node:http";

const host = process.env.MOCK_T3_HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.MOCK_T3_PORT ?? "3999", 10);
const dispatches = [];

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/.well-known/t3/environment") {
    return json(res, 200, {
      environmentId: "env_mock",
      label: "Mock T3 Code",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "mock",
      capabilities: { repositoryIdentity: false },
    });
  }

  if (req.method === "POST" && url.pathname === "/oauth/token") {
    return json(res, 200, {
      access_token: "mock-access-token",
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      token_type: "Bearer",
      expires_in: 3600,
      scope: "orchestration:read orchestration:operate",
    });
  }

  if (req.method === "GET" && url.pathname === "/api/orchestration/snapshot") {
    return json(res, 200, {
      projects: [{ id: "project_mock", title: "Mock Project" }],
      threads: [{ id: "thread_mock", title: "Mock Thread" }],
      dispatches,
    });
  }

  if (req.method === "POST" && url.pathname === "/api/orchestration/dispatch") {
    const body = await readJson(req);
    dispatches.push({ body, receivedAt: new Date().toISOString() });
    return json(res, 200, {
      status: "accepted",
      sequence: dispatches.length,
    });
  }

  return json(res, 404, { error: "not found" });
});

server.listen(port, host, () => {
  console.log(`mock T3 listening on http://${host}:${port}`);
  console.log("Use baseUrl http://127.0.0.1:3999 and any pairingToken.");
});

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const body = Buffer.concat(chunks).toString("utf8").trim();
  return body ? JSON.parse(body) : {};
}

function json(res, status, body) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body, null, 2));
}
