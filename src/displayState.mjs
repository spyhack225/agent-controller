export async function buildUserDisplayState(store, userId) {
  // One bounded store call, not six unbounded ones.
  //
  // This used to fetch every environment, device, media upload, macro, command and audit entry the
  // account had ever produced, and then read `.length` and `.at(-1)` off them. Batching the six
  // with Promise.all fixed the round-trip count but not the payload: the audit log grows on every
  // write, so a device polling this route every five seconds was dragging a monotonically larger
  // history across the wire forever, and the firmware logged `HTTPClient error(-11): read Timeout`
  // on roughly every poll. `getDisplaySummary()` answers with counts and two small projections, so
  // the work and the response are the same size on an account's first day and its thousandth.
  const { counts, latestCommand, latestAudit } = await store.getDisplaySummary(userId);

  // `counts` is passed through verbatim and its keys are fixed by the store, because firmware
  // parses these field names (applyDisplayJson in GatewayOperate.cpp) and a renamed or reordered
  // key is a silent regression on hardware nothing here can test.
  return {
    title: "Agent Controller",
    state: counts.environments > 0 ? "ready" : "setup",
    line1: `${counts.environments} env / ${counts.devices} devices`,
    line2: latestCommand ? `${latestCommand.status}: ${latestCommand.intentType}` : "No commands yet",
    counts,
    latestAction: latestAudit?.action ?? null,
    menu: ["status", "prompt", "shell", "macro", "media", "stop"],
  };
}

export async function buildDeviceDisplayState(store, device, options = {}) {
  const base = await buildUserDisplayState(store, device.userId);
  const configuredMenu = Array.isArray(device.config?.menu) && device.config.menu.length > 0
    ? device.config.menu
    : base.menu;
  return {
    ...base,
    // Firmware applies the display menu every poll and the config menu far less often,
    // so a generic menu here silently overwrites whatever the owner configured.
    menu: configuredMenu,
    title: device.label || "Controller",
    device: {
      id: device.id,
      profile: device.profile,
      lastSeenAt: device.lastSeenAt,
      status: device.status ?? null,
      presence: device.presence ?? null,
    },
    selectedEnvironmentId: options.environmentId ?? null,
  };
}
