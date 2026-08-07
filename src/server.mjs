import { createApp } from "./app.mjs";
import { loadConfig } from "./config.mjs";
import { createRateLimiter, createRedisBackend } from "./rateLimit.mjs";
import { createRespClient } from "./resp.mjs";
import { createConfiguredStore } from "./storage.mjs";

const config = loadConfig();
const store = await createConfiguredStore(config);

// Without a shared backend each process enforces its own window, so N instances allow N times
// the configured limit.
let rateLimiter;
if (config.rateLimits?.redisUrl) {
  const client = createRespClient({ url: config.rateLimits.redisUrl });
  rateLimiter = createRateLimiter({
    backend: createRedisBackend({ connect: async () => client }),
  });
  console.log(`rate limiting shared via ${config.rateLimits.redisUrl}`);
} else {
  rateLimiter = createRateLimiter();
}

const { server, snapshotPoller } = createApp({
  config,
  rateLimiter,
  ...(store ? { store } : {}),
});

server.listen(config.port, config.host, () => {
  console.log(`agent-controller listening on http://${config.host}:${config.port}`);
  if (config.snapshotPollEnabled) {
    snapshotPoller.start();
    console.log(`T3 snapshot poller running every ${config.snapshotPollIntervalMs}ms`);
  }
});
