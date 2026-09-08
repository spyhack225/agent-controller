import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/protocol.test.ts", "test/runtime.test.ts", "test/control-plane.test.ts", "test/background.test.ts"],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          ROUTER_SHARED_SECRET: "test-router-secret",
          DEV_TICKET_ISSUER_SECRET: "test-ticket-secret",
        },
      },
    }),
  ],
});
