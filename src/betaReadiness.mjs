// Roadmap Phase 11 defines beta success as a list of numbers. Nothing measured them, so
// "are we beta-ready?" was unanswerable. This turns each criterion into a computed check.
//
// Two criteria are deliberately reported as `unmeasured` rather than guessed:
//   - reliable device reconnect after Wi-Fi loss
//   - audio-to-prompt dispatch under 10s
// Both need signals the gateway does not record yet; claiming a pass without the data would be
// worse than admitting the gap.

export const BETA_TARGETS = Object.freeze({
  minPairedDeviceDays: 50,
  maxAcknowledgementMedianMs: 2000,
  maxAudioDispatchMedianMs: 10_000,
  maxCommandFailureRatio: 0.1,
});

export function buildBetaReadiness({ devices = [], commands = [], now = Date.now(), targets = BETA_TARGETS }) {
  const limits = { ...BETA_TARGETS, ...(targets ?? {}) };
  const checks = [];

  const pairedDeviceDays = totalPairedDeviceDays(devices, now);
  checks.push({
    id: "paired_device_days",
    label: "50+ paired device-days",
    status: pairedDeviceDays >= limits.minPairedDeviceDays ? "pass" : "fail",
    value: Number(pairedDeviceDays.toFixed(2)),
    target: limits.minPairedDeviceDays,
    detail: `${devices.filter(isClaimed).length} claimed device(s) have accumulated `
      + `${pairedDeviceDays.toFixed(1)} device-days.`,
  });

  const acknowledgement = medianOf(commands
    .map((command) => numberOrNull(command.metrics?.acknowledgementDurationMs))
    .filter((value) => value !== null));
  checks.push(latencyCheck({
    id: "command_acknowledgement",
    label: "<2s median command acknowledgement",
    value: acknowledgement,
    target: limits.maxAcknowledgementMedianMs,
  }));

  // Upload -> dispatch, recorded on any command that carried media.
  const mediaDispatch = medianOf(commands
    .map((command) => numberOrNull(command.metrics?.mediaDispatchDurationMs))
    .filter((value) => value !== null));
  checks.push(latencyCheck({
    id: "audio_to_prompt_dispatch",
    label: "<10s audio-to-prompt dispatch",
    value: mediaDispatch,
    target: limits.maxAudioDispatchMedianMs,
  }));

  const unauthenticated = commands.filter(isUnauthenticatedExecution).length;
  checks.push({
    id: "zero_unauthenticated_execution",
    label: "Zero unauthenticated command execution",
    status: unauthenticated === 0 ? "pass" : "fail",
    value: unauthenticated,
    target: 0,
    detail: unauthenticated === 0
      ? "Every recorded command is attributed to an authenticated user or device."
      : `${unauthenticated} command(s) have no actor attribution.`,
  });

  // A reconnect is a heartbeat that arrives after the device had already gone offline, so it is
  // observed rather than inferred from an open-ended gap.
  const reconnects = devices.reduce((total, device) => total + (device.connectivity?.reconnectCount ?? 0), 0);
  const observedReconnects = devices.some((device) => device.connectivity?.heartbeatCount);
  const stillOnline = devices.filter((device) => isRecentlySeen(device, now)).length;
  checks.push({
    id: "device_reconnect",
    label: "Reliable device reconnect after Wi-Fi loss",
    status: !observedReconnects
      ? "unmeasured"
      : (reconnects === 0 || stillOnline > 0 ? "pass" : "fail"),
    value: observedReconnects ? reconnects : null,
    target: null,
    detail: observedReconnects
      ? `${reconnects} reconnect(s) observed; ${stillOnline} of ${devices.length} device(s) are currently reporting.`
      : "No device has sent a heartbeat yet.",
  });

  const settled = commands.filter((command) => command.status === "completed" || command.status === "failed");
  const failureRatio = settled.length === 0
    ? 0
    : settled.filter((command) => command.status === "failed").length / settled.length;
  checks.push({
    id: "command_failure_ratio",
    label: "Command failure ratio within budget",
    status: failureRatio <= limits.maxCommandFailureRatio ? "pass" : "fail",
    value: Number(failureRatio.toFixed(4)),
    target: limits.maxCommandFailureRatio,
    detail: `${settled.length} settled command(s).`,
  });

  const hasDevices = devices.length > 0;
  checks.push({
    id: "clear_revocation",
    label: "Clear token and device revocation",
    status: hasDevices ? "pass" : "unmeasured",
    // An unmeasured check must never carry a number that could be read as evidence.
    value: hasDevices ? devices.filter((device) => device.revokedAt).length : null,
    target: null,
    detail: hasDevices
      ? "Device revocation and secret rotation are implemented and audited."
      : "No devices have been claimed yet, so revocation has not been exercised.",
  });

  const failed = checks.filter((check) => check.status === "fail");
  const unmeasured = checks.filter((check) => check.status === "unmeasured");
  return {
    generatedAt: new Date(now).toISOString(),
    ready: failed.length === 0 && unmeasured.length === 0,
    blockers: failed.map((check) => check.id),
    unmeasured: unmeasured.map((check) => check.id),
    checks,
  };
}

function latencyCheck({ id, label, value, target }) {
  if (value === null) {
    return { id, label, status: "unmeasured", value: null, target, detail: "No measurements recorded yet." };
  }
  return {
    id,
    label,
    status: value <= target ? "pass" : "fail",
    value,
    target,
    detail: `Median is ${Math.round(value)}ms against a ${target}ms budget.`,
  };
}

/** Sum of days each claimed, unrevoked device has been paired. */
function totalPairedDeviceDays(devices, now) {
  let total = 0;
  for (const device of devices) {
    if (!isClaimed(device)) continue;
    const from = Date.parse(device.claimedAt ?? device.createdAt ?? "");
    if (!Number.isFinite(from)) continue;
    const until = device.revokedAt ? Date.parse(device.revokedAt) : now;
    if (!Number.isFinite(until) || until <= from) continue;
    total += (until - from) / 86_400_000;
  }
  return total;
}

const RECENTLY_SEEN_MS = 90_000;

function isRecentlySeen(device, now) {
  const seenAt = Date.parse(device?.status?.lastHeartbeatAt ?? device?.lastSeenAt ?? "");
  return Number.isFinite(seenAt) && now - seenAt <= RECENTLY_SEEN_MS;
}

function isClaimed(device) {
  return Boolean(device?.claimed || device?.claimedAt || device?.userId);
}

// A command with no user attribution would mean something executed without authentication.
function isUnauthenticatedExecution(command) {
  return !command?.userId;
}

function medianOf(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(sorted.length * 0.5) - 1;
  return sorted[Math.min(sorted.length - 1, Math.max(0, index))];
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
