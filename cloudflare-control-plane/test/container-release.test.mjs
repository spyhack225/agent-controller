import { describe, expect, it } from "vitest";

import { validateReleaseFiles } from "../scripts/container-smoke.mjs";

describe("container release artifacts", () => {
  it("uses a deny-by-default context and only the lock-pinned runtime dependencies", async () => {
    await expect(validateReleaseFiles()).resolves.toEqual({
      runtimeDependencies: ["@clerk/backend", "web-push"],
      runtimeClerkVersion: "3.7.0",
      runtimeWebPushVersion: "3.6.7",
      runtimePackageCount: 27,
    });
  });
});
