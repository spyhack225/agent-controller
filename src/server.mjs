import { createApp } from "./app.mjs";
import { loadConfig } from "./config.mjs";
import { createConfiguredStore } from "./storage.mjs";

const config = loadConfig();
const store = await createConfiguredStore(config);
const { server } = createApp({ config, ...(store ? { store } : {}) });

server.listen(config.port, config.host, () => {
  console.log(`agent-controller listening on http://${config.host}:${config.port}`);
});
