import { describe, expect, test } from "vitest";

import {
  buildGatewayTunnelDisableCommand,
  buildGatewayTunnelSetupCommand,
} from "./remoteAccess";

describe("remote access commands", () => {
  test("uses persistent private Serve as the recommended setup", () => {
    expect(buildGatewayTunnelSetupCommand("serve")).toBe(
      "npm run setup:tunnel -- --mode serve --write-env",
    );
    expect(buildGatewayTunnelDisableCommand("serve")).toBe(
      "npm run setup:tunnel -- --mode serve-off",
    );
  });

  test("keeps public Funnel explicit", () => {
    expect(buildGatewayTunnelSetupCommand("funnel")).toBe(
      "npm run setup:tunnel -- --mode funnel --write-env",
    );
  });
});
