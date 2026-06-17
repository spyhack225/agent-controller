export async function buildUserDisplayState(store, userId) {
  const environments = await store.listEnvironments(userId);
  const devices = await store.listDevices(userId);
  const media = await store.listMediaUploads(userId);
  const macros = await store.listMacros(userId);
  const commands = await store.listCommands(userId);
  const audit = await store.listAuditLogs(userId);
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
  return {
    ...base,
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
