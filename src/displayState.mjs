export async function buildUserDisplayState(store, userId) {
  // Awaited together, not in sequence. None of these six depends on another, and under the Convex
  // store each one is its own network round trip — so serialising them made the device's five-second
  // display poll six round trips deep and it began timing out on the firmware side
  // (HTTPClient error -11) once the account had enough history. Batching turns that back into one
  // slowest-call wait.
  const [environments, devices, media, macros, commands, audit] = await Promise.all([
    store.listEnvironments(userId),
    store.listDevices(userId),
    store.listMediaUploads(userId),
    store.listMacros(userId),
    store.listCommands(userId),
    store.listAuditLogs(userId),
  ]);
  const lastCommand = commands.at(-1) ?? null;
  const lastAudit = audit.at(-1) ?? null;
  const onlineDevices = devices.filter((device) => device.presence?.online).length;
  const offlineDevices = Math.max(0, devices.length - onlineDevices);

  return {
    title: "Agent Controller",
    state: environments.length > 0 ? "ready" : "setup",
    line1: `${environments.length} env / ${devices.length} devices`,
    line2: lastCommand ? `${lastCommand.status}: ${lastCommand.intent.type}` : "No commands yet",
    counts: {
      environments: environments.length,
      devices: devices.length,
      media: media.length,
      macros: macros.length,
      commands: commands.length,
      audit: audit.length,
      onlineDevices,
      offlineDevices,
    },
    latestAction: lastAudit?.action ?? null,
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
