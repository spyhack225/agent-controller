import {
  Battery,
  Boxes,
  CheckCircle2,
  ChevronRight,
  CircleOff,
  Cpu,
  KeyRound,
  PackagePlus,
  Radio,
  RotateCcwKey,
  Save,
  ShieldCheck,
  Signal,
  Smartphone,
  Trash2,
  Unplug,
  Wifi,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import type { Controller } from "../controller";
import { formatMetric, formatRelativeTime, formatUptime } from "../format";
import type { Device, DeviceProfile } from "../types";
import {
  Button,
  EmptyState,
  Field,
  Metric,
  Panel,
  SectionHeader,
  StatusBadge,
  type StatusTone,
  useConfirm,
} from "../ui";
import { ProfilePicker } from "./ProfilePicker";

// Mirrors the allowlist in normalizeDeviceConfig (src/store.mjs and convex/gatewayStore.ts).
// A value missing here cannot be assigned to a device at all, however permissive the server is.
const menuItems = ["status", "prompt", "shell", "macro", "thread", "approve", "reject", "media", "stop", "reset"];

// Mirrors src/profiles.mjs. Only used when GET /v1/device-profiles is unreachable, so the
// picker still explains what each profile grants instead of rendering an empty list.
const FALLBACK_PROFILES: DeviceProfile[] = [
  {
    id: "agent-controller",
    label: "Agent controller",
    description: "Full remote agent control for prompts, media, status, approvals, session control, and policy-screened shell input.",
    capabilities: [
      "status",
      "agent_prompt",
      "media_prompt",
      "session_control",
      "approval_response",
      "shell_input",
    ],
  },
  {
    id: "read-only",
    label: "Read only",
    description: "Status inspection only. Prompts, media, approvals, session control, and shell input are blocked.",
    capabilities: ["status"],
  },
  {
    id: "power-controller",
    label: "Power controller",
    description: "High-trust control profile used by signed-in web clients and advanced devices; dangerous shell input still requires approval.",
    capabilities: [
      "status",
      "agent_prompt",
      "media_prompt",
      "session_control",
      "approval_response",
      "shell_input",
    ],
  },
];

/**
 * A device's headline status, used by both the inventory row and the detail header so the two
 * cannot describe the same device differently.
 *
 * Revocation outranks presence. A revoked credential can never authenticate again, so the device
 * simply stops being seen and decays to "offline" — which reads as "it might come back" when it
 * never will. Saying "revoked" names the cause instead of reporting its side effect.
 */
function deviceStatus(device: Device | null | undefined): { label: string; tone: StatusTone } {
  if (!device) return { label: "offline", tone: "neutral" };
  if (device.revokedAt) return { label: "revoked", tone: "danger" };
  const state = device.presence?.state
    ?? (device.lastSeenAt && Date.now() - Date.parse(device.lastSeenAt) <= 90_000
      ? "online"
      : "offline");
  return {
    label: state,
    tone: state === "online" ? "success" : state === "stale" ? "warning" : "neutral",
  };
}

export function DevicesPage({ controller: c }: { controller: Controller }) {
  const confirm = useConfirm();
  const [label, setLabel] = useState("Desk controller");
  const [profile, setProfile] = useState("agent-controller");
  const [claimCode, setClaimCode] = useState("");
  const [selectedProfile, setSelectedProfile] = useState("agent-controller");

  useEffect(() => {
    setSelectedProfile(c.selectedDevice?.profile ?? "agent-controller");
  }, [c.selectedDevice]);

  const profiles = c.deviceProfiles.length ? c.deviceProfiles : FALLBACK_PROFILES;

  const registerDevice = async () => {
    await c.run("register-device", "Device registered. Copy the new secret now.", async () => {
      const result = await c.api<{
        device: { id: string };
        secret: string;
      }>("/v1/devices", {
        method: "POST",
        body: { label: label.trim() || "Controller", profile },
      });
      c.setDeviceSecret({
        title: "New device secret",
        id: result.device.id,
        secret: result.secret,
      });
      await c.refreshAll();
      return result;
    });
  };

  const preprovisionDevice = async () => {
    await c.run("preprovision-device", "Factory device pre-provisioned.", async () => {
      const result = await c.api<{
        device: { id: string };
        secret: string;
        claimCode: string;
      }>("/v1/factory/devices", {
        method: "POST",
        auth: false,
        body: { label: label.trim() || "Controller", profile },
      });
      setClaimCode(result.claimCode);
      c.setDeviceSecret({
        title: "Factory device",
        id: result.device.id,
        secret: result.secret,
        claimCode: result.claimCode,
      });
      return result;
    });
  };

  const claimDevice = async () => {
    if (!claimCode.trim()) {
      c.setNotice({ tone: "danger", message: "Enter the claim code shown on the controller." });
      return;
    }
    await c.run("claim-device", "Device claimed to this account.", async () => {
      const result = await c.api("/v1/devices/claim", {
        method: "POST",
        body: {
          claimCode: claimCode.trim(),
          label: label.trim() || undefined,
        },
      });
      setClaimCode("");
      await c.refreshAll();
      return result;
    });
  };

  const saveProfile = async () => {
    if (!c.selectedDevice) return;
    const deviceId = c.selectedDevice.id;
    await c.run("save-device-profile", "Device policy profile updated.", async () => {
      const result = await c.api(`/v1/devices/${encodeURIComponent(deviceId)}/profile`, {
        method: "PUT",
        body: { profile: selectedProfile },
      });
      await c.refreshAll();
      return result;
    });
  };

  const saveConfig = async () => {
    if (!c.selectedDevice) return;
    const deviceId = c.selectedDevice.id;
    await c.run("save-device-config", "Device runtime configuration saved.", async () => {
      const result = await c.api(`/v1/devices/${encodeURIComponent(deviceId)}/config`, {
        method: "PUT",
        body: {
          environmentId: c.deviceConfig.environmentId || null,
          threadId: c.deviceConfig.threadId?.trim() || null,
          defaultPrompt: c.deviceConfig.defaultPrompt?.trim() || undefined,
          shellCommand: c.deviceConfig.shellCommand?.trim() || undefined,
          menu: c.deviceConfig.menu ?? [],
        },
      });
      await c.refreshAll();
      return result;
    });
  };

  const deleteDevice = async () => {
    if (!c.selectedDevice) return;
    const device = c.selectedDevice;
    const accepted = await confirm({
      title: `Delete ${device.label}?`,
      description: "This permanently removes the controller from your inventory. Its command history "
        + "and audit trail are kept. The credential is already revoked, so no hardware is affected.",
      confirmLabel: "Delete permanently",
    });
    if (!accepted) return;
    await c.run("delete-device", "Device deleted.", async () => {
      const result = await c.api(`/v1/devices/${encodeURIComponent(device.id)}`, { method: "DELETE" });
      // The selection points at a record that no longer exists.
      c.setSelectedDeviceId("");
      await c.refreshAll();
      return result;
    });
  };

  const rotateSecret = async () => {
    if (!c.selectedDevice) return;
    const accepted = await confirm({
      title: `Rotate ${c.selectedDevice.label}’s secret?`,
      description: "The existing hardware credential will stop working immediately. Install the new secret on the device.",
      confirmLabel: "Rotate secret",
    });
    if (!accepted) return;
    await c.run("rotate-device-secret", "Device secret rotated. Copy it now.", async () => {
      const result = await c.api<{
        device: { id: string };
        secret: string;
      }>(`/v1/devices/${encodeURIComponent(c.selectedDevice!.id)}/rotate-secret`, {
        method: "POST",
        body: {},
      });
      c.setDeviceSecret({
        title: "Rotated device secret",
        id: result.device.id,
        secret: result.secret,
      });
      await c.refreshAll();
      return result;
    });
  };

  const transferReset = async () => {
    if (!c.selectedDevice) return;
    const accepted = await confirm({
      title: `Reset ${c.selectedDevice.label} for transfer?`,
      description: "This unclaims the device, rotates its hardware secret, creates a new claim code, and removes it from this account.",
      confirmLabel: "Reset for transfer",
    });
    if (!accepted) return;
    await c.run("transfer-reset-device", "Device reset for transfer.", async () => {
      const result = await c.api<{
        device: { id: string };
        secret: string;
        claimCode: string;
      }>(`/v1/devices/${encodeURIComponent(c.selectedDevice!.id)}/transfer-reset`, {
        method: "POST",
        body: {},
      });
      c.setDeviceSecret({
        title: "Transfer reset",
        id: result.device.id,
        secret: result.secret,
        claimCode: result.claimCode,
      });
      await c.refreshAll();
      return result;
    });
  };

  const revokeDevice = async () => {
    if (!c.selectedDevice) return;
    const accepted = await confirm({
      title: `Revoke ${c.selectedDevice.label}?`,
      description: "This disables the current hardware credential. The controller will no longer authenticate.",
      confirmLabel: "Revoke device",
    });
    if (!accepted) return;
    await c.run("revoke-device", "Device revoked.", async () => {
      const result = await c.api(`/v1/devices/${encodeURIComponent(c.selectedDevice!.id)}/revoke`, {
        method: "POST",
        body: {},
      });
      await c.refreshAll();
      return result;
    });
  };

  const selectedStatus = deviceStatus(c.selectedDevice);
  const selectedRevoked = Boolean(c.selectedDevice?.revokedAt);
  // Server-declared, not re-derived: the store's guards are invisible from here, so mirroring them
  // meant every new one produced a control that looked live and returned 404.
  const can = (action: keyof NonNullable<Device["actions"]>) =>
    c.selectedDevice?.actions?.[action] ?? true;
  const status = c.selectedDevice?.status;
  const activeMenu = new Set(c.deviceConfig.menu ?? []);

  return (
    <div className="page-stack">
      {/* Revealed once and never again, so it sits above the fold at full width rather
          than inside a column where it can be scrolled past. */}
      {c.deviceSecret ? (
        <Panel className="overflow-hidden border-warning/30">
          <SectionHeader
            compact
            eyebrow="One-time credential"
            title={c.deviceSecret.title}
            action={<StatusBadge tone="warning" label="Copy now" />}
          />
          <div className="grid gap-4 border-t border-control bg-console p-4 text-console-ink sm:grid-cols-[1fr_auto] sm:items-center">
            <dl className="grid gap-3 sm:grid-cols-3">
              {c.deviceSecret.id ? <Metric label="Device ID" value={c.deviceSecret.id} /> : null}
              {c.deviceSecret.secret ? <Metric label="Secret" value={c.deviceSecret.secret} /> : null}
              {c.deviceSecret.claimCode ? <Metric label="Claim code" value={c.deviceSecret.claimCode} /> : null}
            </dl>
            <Button
              size="sm"
              onClick={() => {
                const value = [c.deviceSecret?.id, c.deviceSecret?.secret, c.deviceSecret?.claimCode]
                  .filter(Boolean)
                  .join("\n");
                void navigator.clipboard.writeText(value);
                c.setNotice({ tone: "success", message: "Credential copied to clipboard." });
              }}
            >
              Copy credential
            </Button>
          </div>
        </Panel>
      ) : null}

      {/* Row 1 pairs the two capability pickers. Both are the same shape — three profile
          cards with a capability list each — so side by side they stay level instead of
          one running a screen longer than its neighbour. */}
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <Panel className="overflow-hidden">
          <SectionHeader
            eyebrow="Onboarding"
            title="Add a controller"
            description="Create credentials for development or claim physical hardware."
          />
          <div className="space-y-4 border-t border-control p-5">
            <Field label="Device label" htmlFor="new-device-label">
              <input id="new-device-label" value={label} onChange={(event) => setLabel(event.target.value)} />
            </Field>
            <ProfilePicker
              name="new-device-profile"
              legend="Policy profile"
              description="Each profile is a capability set. The device can only issue the intents listed here."
              profiles={profiles}
              value={profile}
              onChange={setProfile}
            />
            <div className="grid grid-cols-2 gap-2">
              <Button busy={c.busyAction === "register-device"} onClick={() => void registerDevice()}>
                <PackagePlus className="size-4" /> Register
              </Button>
              <Button busy={c.busyAction === "preprovision-device"} onClick={() => void preprovisionDevice()}>
                <Boxes className="size-4" /> Pre-provision
              </Button>
            </div>
            <div className="relative flex items-center py-1">
              <span className="h-px flex-1 bg-control" />
              <span className="px-3 text-[10px] font-semibold uppercase tracking-[0.14em] text-ink-faint">or claim existing hardware</span>
              <span className="h-px flex-1 bg-control" />
            </div>
            <Field label="Claim code" htmlFor="claim-code" hint="Use the code shown on the device or printed claim card.">
              <input
                id="claim-code"
                className="font-mono uppercase tracking-[0.12em]"
                value={claimCode}
                onChange={(event) => setClaimCode(event.target.value)}
                placeholder="ABCDE-23456"
              />
            </Field>
            <Button
              className="w-full"
              variant="primary"
              busy={c.busyAction === "claim-device"}
              onClick={() => void claimDevice()}
            >
              <KeyRound className="size-4" /> Claim controller
            </Button>
          </div>
        </Panel>
        {c.selectedDevice ? (
        <Panel className="overflow-hidden">
          <SectionHeader
            eyebrow="Policy"
            title="Policy profile"
            description="Each profile is a capability set. Review what it grants before reassigning — changes take effect on the device's next command."
            action={
              <Button
                size="sm"
                busy={c.busyAction === "save-device-profile"}
                disabled={!can("updateProfile") || selectedProfile === c.selectedDevice.profile}
                onClick={() => void saveProfile()}
              >
                <ShieldCheck className="size-4" /> Save policy profile
              </Button>
            }
          />
          <div className="border-t border-control bg-surface-inset/45 p-5">
            <ProfilePicker
              name="selected-device-profile"
              legend="Assigned profile"
              profiles={profiles}
              value={selectedProfile}
              onChange={setSelectedProfile}
              assignedProfileId={c.selectedDevice.profile}
            />
          </div>
        </Panel>
        ) : null}
      </div>

      {/* Row 2 pairs the fleet list with whichever controller is selected from it. */}
      <div className="grid items-start gap-4 xl:grid-cols-2">
        <Panel elevated className="overflow-hidden">
          <SectionHeader
            eyebrow="Fleet"
            title="Controller inventory"
            description="Presence, policy, and runtime context for every claimed hardware controller."
            action={<StatusBadge label={`${c.devices.length} devices`} />}
          />
          {c.devices.length ? (
            <div className="divide-y divide-control border-t border-control">
              {c.devices.map((device) => {
                // A revoked device stays in the inventory on purpose — the hardware still exists and
                // may still be powered on, and hiding it would leave the owner with no record of what
                // they revoked.
                const revoked = Boolean(device.revokedAt);
                const rowStatus = deviceStatus(device);
                const selected = c.selectedDeviceId === device.id;
                return (
                  <button
                    type="button"
                    key={device.id}
                    onClick={() => c.setSelectedDeviceId(device.id)}
                    className="inventory-row"
                    data-selected={selected || undefined}
                    data-revoked={revoked || undefined}
                  >
                    <div className="grid size-10 place-items-center rounded-lg border border-control bg-surface-inset">
                      {revoked
                        ? <CircleOff className="size-4.5 text-ink-faint" />
                        : <Radio className="size-4.5 text-primary" />}
                    </div>
                    <span className="min-w-0">
                      <span className="flex flex-wrap items-center gap-2">
                        <span
                          className={`truncate font-display text-sm font-semibold${revoked ? " text-ink-muted line-through" : ""}`}
                        >
                          {device.label}
                        </span>
                        <StatusBadge tone={rowStatus.tone} label={rowStatus.label} />
                      </span>
                      <span className="mt-1 block truncate font-mono text-[11px] text-ink-faint">{device.id}</span>
                      <span className="mt-1 block truncate text-xs text-ink-muted">
                        {device.config?.environmentId ?? "No environment"} · {device.profile}
                      </span>
                    </span>
                    <ChevronRight className="size-4 text-ink-faint" />
                  </button>
                );
              })}
            </div>
          ) : (
            <EmptyState
              icon={Smartphone}
              title="No claimed controllers"
              description="Register a development controller, pre-provision factory hardware, or enter a claim code."
            />
          )}
        </Panel>
        {c.selectedDevice ? (
          <Panel className="overflow-hidden">
            <SectionHeader
              eyebrow="Selected controller"
              title={c.selectedDevice.label}
              description={c.selectedDevice.id}
              action={
                <StatusBadge tone={selectedStatus.tone} label={selectedStatus.label} />
              }
            />
            {/* Once revoked, every figure below is the last reading before the credential died —
                a frozen snapshot, not telemetry. Rendered at full strength it reads as a live
                device; dimmed and labelled it reads as history, which is what it is. */}
            <div className="border-t border-control p-5">
              {selectedRevoked ? (
                <p className="mb-4 text-xs text-ink-faint">
                  Last reported before revocation. These values no longer update.
                </p>
              ) : null}
              <dl
                className={`grid grid-cols-2 gap-x-5 gap-y-5${selectedRevoked ? " opacity-45" : ""}`}
              >
                <Metric label="Last seen" value={formatRelativeTime(status?.lastHeartbeatAt ?? c.selectedDevice.lastSeenAt)} />
                <Metric label="Firmware" value={status?.firmwareVersion ?? "unknown"} />
                <Metric label="Hardware" value={status?.hardwareModel ?? "unknown"} />
                <Metric label="IP address" value={status?.ipAddress ?? "unknown"} />
                <Metric label="Wi-Fi" value={formatMetric(status?.wifiRssi, "dBm")} />
                <Metric label="Free heap" value={formatMetric(status?.freeHeap, "B")} />
                <Metric label="Uptime" value={formatUptime(status?.uptimeMs)} />
                <Metric
                  label="Battery"
                  value={status?.batteryPercent != null
                    ? formatMetric(status.batteryPercent, "%")
                    : formatMetric(status?.batteryMv, "mV")}
                />
              </dl>
            </div>
            <div className="space-y-2 border-t border-danger/20 p-5">
              <p className="text-xs font-semibold uppercase tracking-[0.12em] text-danger">Credential danger zone</p>
              {/* All three are dead ends on a revoked device: the store refuses rotate and transfer
                  reset outright (both 404), and revoking again just rewrites the same flag. Offering
                  them invites a click that either errors or silently does nothing. */}
              {selectedRevoked ? (
                <p className="text-xs text-ink-muted">
                  This credential is revoked and cannot be rotated or transferred. Claim the hardware
                  again to issue a new one.
                </p>
              ) : null}
              <div className="grid gap-2 sm:grid-cols-3">
                <Button size="sm" disabled={!can("rotateSecret")} onClick={() => void rotateSecret()}>
                  <RotateCcwKey className="size-4" /> Rotate
                </Button>
                <Button
                  size="sm"
                  variant="danger-ghost"
                  disabled={!can("transferReset")}
                  onClick={() => void transferReset()}
                >
                  <Unplug className="size-4" /> Transfer reset
                </Button>
                <Button
                  size="sm"
                  variant="danger-ghost"
                  disabled={!can("revoke")}
                  onClick={() => void revokeDevice()}
                >
                  <CircleOff className="size-4" /> Revoke
                </Button>
              </div>
              {can("delete") ? (
                <div className="mt-3 border-t border-danger/20 pt-3">
                  <p className="text-xs text-ink-muted">
                    Revoked and no longer in use? Remove it from the inventory. Command history and
                    audit records are kept.
                  </p>
                  <Button
                    size="sm"
                    variant="danger-ghost"
                    className="mt-2"
                    busy={c.busyAction === "delete-device"}
                    onClick={() => void deleteDevice()}
                  >
                    <Trash2 className="size-4" /> Delete permanently
                  </Button>
                </div>
              ) : null}
            </div>
          </Panel>
        ) : null}
      </div>

      {/* Full width: the configuration form has its own two-column grid inside, which
          collapses to one and doubles in height when squeezed into half the page. */}
      {c.selectedDevice ? (
        <Panel elevated className="overflow-hidden">
          <SectionHeader
            eyebrow="Runtime"
            title="Device configuration"
            description="Choose the default environment, thread, prompt, shell command, and rotary menu."
            action={<StatusBadge tone="info" label="Explicit save" />}
          />
          <div className="grid gap-4 border-t border-control p-5 sm:grid-cols-2">
            <Field label="Default environment" htmlFor="device-config-environment">
              <select
                id="device-config-environment"
                value={c.deviceConfig.environmentId ?? ""}
                onChange={(event) => c.setDeviceConfig((current) => ({
                  ...current,
                  environmentId: event.target.value || null,
                }))}
              >
                <option value="">No environment</option>
                {c.environments.map((environment) => (
                  <option key={environment.id} value={environment.id}>{environment.label}</option>
                ))}
              </select>
            </Field>
            <Field label="Default thread ID" htmlFor="device-config-thread">
              <input
                id="device-config-thread"
                className="font-mono"
                value={c.deviceConfig.threadId ?? ""}
                onChange={(event) => c.setDeviceConfig((current) => ({
                  ...current,
                  threadId: event.target.value,
                }))}
                placeholder="thread_…"
              />
            </Field>
            <Field label="Default prompt" htmlFor="device-default-prompt" className="sm:col-span-2">
              <textarea
                id="device-default-prompt"
                rows={4}
                value={c.deviceConfig.defaultPrompt ?? ""}
                onChange={(event) => c.setDeviceConfig((current) => ({
                  ...current,
                  defaultPrompt: event.target.value,
                }))}
              />
            </Field>
            <Field label="Shell command" htmlFor="device-shell-command" className="sm:col-span-2">
              <input
                id="device-shell-command"
                className="font-mono"
                value={c.deviceConfig.shellCommand ?? ""}
                onChange={(event) => c.setDeviceConfig((current) => ({
                  ...current,
                  shellCommand: event.target.value,
                }))}
              />
            </Field>
          </div>
          <fieldset className="border-t border-control p-5">
            <legend className="px-1 text-xs font-semibold text-ink-muted">Controller menu</legend>
            <div className="mt-1 grid grid-cols-2 gap-2 sm:grid-cols-4">
              {menuItems.map((item) => (
                <label key={item} className="check-card">
                  <input
                    type="checkbox"
                    checked={activeMenu.has(item)}
                    onChange={(event) => c.setDeviceConfig((current) => {
                      const next = new Set(current.menu ?? []);
                      if (event.target.checked) next.add(item);
                      else next.delete(item);
                      return { ...current, menu: [...next] };
                    })}
                  />
                  <span className="capitalize">{item}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <div className="flex justify-end border-t border-control bg-surface-inset/45 p-4">
            <Button
              variant="primary"
              busy={c.busyAction === "save-device-config"}
              disabled={!can("updateConfig")}
              onClick={() => void saveConfig()}
            >
              <Save className="size-4" /> Save device configuration
            </Button>
          </div>
        </Panel>
      ) : null}
    </div>
  );
}
