import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/capacity.test.ts"],
    testTimeout: 30_000,
    disableConsoleIntercept: true,
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
