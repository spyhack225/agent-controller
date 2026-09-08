import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/connector-contract.node.test.ts", "test/background.node.test.ts", "test/telemetry.node.test.ts"],
  },
});
