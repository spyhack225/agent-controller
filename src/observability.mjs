const LOW_BATTERY_PERCENT = 20;
const DEVICE_ONLINE_THRESHOLD_MS = 90_000;
const TOKEN_EXPIRING_SOON_MS = 7 * 24 * 60 * 60 * 1000;

export async function buildUserObservabilitySummary(store, userId, now = Date.now()) {
  const [devices, environments, media, commands] = await Promise.all([
    store.listDevices(userId),
    store.listEnvironments(userId),
    store.listMediaUploads(userId),
    store.listCommands(userId),
  ]);

  return {
    generatedAt: new Date(now).toISOString(),
    devices: summarizeDevices(devices, now),
    environments: summarizeEnvironments(environments, now),
    commands: summarizeCommands(commands),
    media: summarizeMedia(media, now),
  };
}

function summarizeDevices(devices, now) {
  const firmwareVersions = {};
  let latestHeartbeatAt = null;
  let lowBatteryDevices = 0;
  let lowestBatteryPercent = null;
  let online = 0;

  for (const device of devices) {
    const version = device.status?.firmwareVersion ?? "unknown";
    firmwareVersions[version] = (firmwareVersions[version] ?? 0) + 1;
    latestHeartbeatAt = latestIso(latestHeartbeatAt, device.status?.lastHeartbeatAt);
    if (isDeviceOnline(device, now)) online += 1;
    const batteryPercent = nullableNumber(device.status?.batteryPercent);
    if (batteryPercent !== null) {
      if (batteryPercent < LOW_BATTERY_PERCENT) lowBatteryDevices += 1;
      lowestBatteryPercent = lowestBatteryPercent === null
        ? batteryPercent
        : Math.min(lowestBatteryPercent, batteryPercent);
    }
  }

  return {
    total: devices.length,
    online,
    offline: Math.max(0, devices.length - online),
    lowBatteryDevices,
    lowestBatteryPercent,
    latestHeartbeatAt,
    firmwareVersions,
  };
}

function isDeviceOnline(device, now) {
  const latestActivityAt = latestIso(device.lastSeenAt, device.status?.lastHeartbeatAt);
  const latestActivityMs = Date.parse(latestActivityAt);
  return Number.isFinite(latestActivityMs) && Math.max(0, now - latestActivityMs) <= DEVICE_ONLINE_THRESHOLD_MS;
}

function summarizeEnvironments(environments, now) {
  const byStatus = {};
  let tokenExpired = 0;
  let tokenExpiringSoon = 0;
  let latestHealthCheckAt = null;

  for (const environment of environments) {
    const status = environment.status ?? "unknown";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    latestHealthCheckAt = latestIso(latestHealthCheckAt, environment.health?.lastCheckedAt);

    const expiresAt = Date.parse(environment.accessTokenExpiresAt);
    if (Number.isFinite(expiresAt)) {
      if (expiresAt <= now) tokenExpired += 1;
      else if (expiresAt - now <= TOKEN_EXPIRING_SOON_MS) tokenExpiringSoon += 1;
    }
  }

  return {
    total: environments.length,
    reachable: byStatus.reachable ?? 0,
    unreachable: byStatus.unreachable ?? 0,
    tokenExpired,
    tokenExpiringSoon,
    latestHealthCheckAt,
    byStatus,
  };
}

function summarizeCommands(commands) {
  const byStatus = {};
  const acknowledgementDurations = [];
  const dispatchDurations = [];

  for (const command of commands) {
    const status = command.status ?? "unknown";
    byStatus[status] = (byStatus[status] ?? 0) + 1;
    const acknowledgementDurationMs = nullableNumber(command.metrics?.acknowledgementDurationMs);
    const dispatchDurationMs = nullableNumber(command.metrics?.dispatchDurationMs);
    if (acknowledgementDurationMs !== null) acknowledgementDurations.push(acknowledgementDurationMs);
    if (dispatchDurationMs !== null) dispatchDurations.push(dispatchDurationMs);
  }

  return {
    total: commands.length,
    dispatched: byStatus.dispatched ?? 0,
    completed: byStatus.completed ?? 0,
    failed: byStatus.failed ?? 0,
    approvalRequired: byStatus.approval_required ?? 0,
    blocked: byStatus.blocked ?? 0,
    rejected: byStatus.rejected ?? 0,
    acknowledgement: percentileSummary(acknowledgementDurations),
    dispatch: percentileSummary(dispatchDurations),
    byStatus,
  };
}

function summarizeMedia(mediaUploads, now) {
  const byKind = {};
  const transcription = {};
  let expiringSoon = 0;
  const soon = now + TOKEN_EXPIRING_SOON_MS;

  for (const media of mediaUploads) {
    const kind = media.kind ?? "unknown";
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    const status = media.processing?.transcriptionStatus ?? "not_applicable";
    transcription[status] = (transcription[status] ?? 0) + 1;
    const expiresAt = Date.parse(media.expiresAt);
    if (Number.isFinite(expiresAt) && expiresAt <= soon) expiringSoon += 1;
  }

  return {
    total: mediaUploads.length,
    failedProcessing: transcription.failed ?? 0,
    pendingProcessing: (transcription.pending ?? 0) + (transcription.processing ?? 0),
    expiringSoon,
    byKind,
    transcription,
  };
}

function percentileSummary(values) {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);
  return {
    count: sorted.length,
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
  };
}

function percentile(sorted, ratio) {
  if (sorted.length === 0) return null;
  const index = Math.ceil(sorted.length * ratio) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, index))];
}

function latestIso(left, right) {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(leftMs)) return Number.isFinite(rightMs) ? right : null;
  if (!Number.isFinite(rightMs)) return left;
  return rightMs > leftMs ? right : left;
}

function nullableNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
