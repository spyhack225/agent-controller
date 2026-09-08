import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/capacity.test.ts"],
    testTimeout: 10_000,
    disableConsoleIntercept: true,
  },
});
