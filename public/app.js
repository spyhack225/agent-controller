const state = {
  token: localStorage.getItem("agentControllerToken") || "",
  tokenSource: localStorage.getItem("agentControllerToken") ? "platform" : null,
  authConfig: null,
  deviceProfiles: [],
  clerk: null,
  clerkReady: false,
  environments: [],
  t3Threads: [],
  devices: [],
  commands: [],
  commandEvents: [],
  macros: [],
  media: [],
  events: null,
  refreshTimer: null,
  audioRecorder: null,
  audioChunks: [],
  cameraStream: null,
};

const els = {
  connectionStatus: document.querySelector("#connectionStatus"),
  userId: document.querySelector("#userId"),
  email: document.querySelector("#email"),
  clerkControls: document.querySelector("#clerkControls"),
  clerkStatus: document.querySelector("#clerkStatus"),
  clerkUser: document.querySelector("#clerkUser"),
  clerkSignInButton: document.querySelector("#clerkSignInButton"),
  clerkUseSessionButton: document.querySelector("#clerkUseSessionButton"),
  clerkSignOutButton: document.querySelector("#clerkSignOutButton"),
  createTokenButton: document.querySelector("#createTokenButton"),
  platformToken: document.querySelector("#platformToken"),
  saveTokenButton: document.querySelector("#saveTokenButton"),
  environmentSelect: document.querySelector("#environmentSelect"),
  threadId: document.querySelector("#threadId"),
  t3ThreadSelect: document.querySelector("#t3ThreadSelect"),
  loadT3SessionsButton: document.querySelector("#loadT3SessionsButton"),
  promptText: document.querySelector("#promptText"),
  mediaSelect: document.querySelector("#mediaSelect"),
  intentType: document.querySelector("#intentType"),
  sendPromptButton: document.querySelector("#sendPromptButton"),
  statusButton: document.querySelector("#statusButton"),
  stopButton: document.querySelector("#stopButton"),
  macroLabel: document.querySelector("#macroLabel"),
  createMacroButton: document.querySelector("#createMacroButton"),
  macroList: document.querySelector("#macroList"),
  deviceLabel: document.querySelector("#deviceLabel"),
  deviceProfile: document.querySelector("#deviceProfile"),
  createDeviceButton: document.querySelector("#createDeviceButton"),
  preprovisionDeviceButton: document.querySelector("#preprovisionDeviceButton"),
  deviceSecretBox: document.querySelector("#deviceSecretBox"),
  claimCode: document.querySelector("#claimCode"),
  claimDeviceButton: document.querySelector("#claimDeviceButton"),
  deviceConfigDevice: document.querySelector("#deviceConfigDevice"),
  deviceConfigEnvironment: document.querySelector("#deviceConfigEnvironment"),
  deviceConfigThread: document.querySelector("#deviceConfigThread"),
  deviceDefaultPrompt: document.querySelector("#deviceDefaultPrompt"),
  deviceShellCommand: document.querySelector("#deviceShellCommand"),
  saveDeviceConfigButton: document.querySelector("#saveDeviceConfigButton"),
  t3Label: document.querySelector("#t3Label"),
  t3BaseUrl: document.querySelector("#t3BaseUrl"),
  t3Token: document.querySelector("#t3Token"),
  pairT3Button: document.querySelector("#pairT3Button"),
  accessT3Button: document.querySelector("#accessT3Button"),
  audioCaptureStatus: document.querySelector("#audioCaptureStatus"),
  startAudioButton: document.querySelector("#startAudioButton"),
  stopAudioButton: document.querySelector("#stopAudioButton"),
  cameraCaptureStatus: document.querySelector("#cameraCaptureStatus"),
  cameraPreview: document.querySelector("#cameraPreview"),
  startCameraButton: document.querySelector("#startCameraButton"),
  captureCameraButton: document.querySelector("#captureCameraButton"),
  mediaFile: document.querySelector("#mediaFile"),
  mediaTranscript: document.querySelector("#mediaTranscript"),
  uploadMediaButton: document.querySelector("#uploadMediaButton"),
  mediaRetentionDays: document.querySelector("#mediaRetentionDays"),
  savePrivacyButton: document.querySelector("#savePrivacyButton"),
  purgeExpiredMediaButton: document.querySelector("#purgeExpiredMediaButton"),
  mediaList: document.querySelector("#mediaList"),
  refreshButton: document.querySelector("#refreshButton"),
  diagnosticsButton: document.querySelector("#diagnosticsButton"),
  environmentList: document.querySelector("#environmentList"),
  deviceList: document.querySelector("#deviceList"),
  approvalList: document.querySelector("#approvalList"),
  commandList: document.querySelector("#commandList"),
  commandTimeline: document.querySelector("#commandTimeline"),
  auditList: document.querySelector("#auditList"),
  displayState: document.querySelector("#displayState"),
  consoleOutput: document.querySelector("#consoleOutput"),
};

els.platformToken.value = state.token;
setStatus();

els.clerkSignInButton.addEventListener("click", signInWithClerk);
els.clerkUseSessionButton.addEventListener("click", useClerkSession);
els.clerkSignOutButton.addEventListener("click", signOutOfClerk);

els.createTokenButton.addEventListener("click", async () => {
  const result = await api("/v1/users/dev", {
    method: "POST",
    auth: false,
    body: {
      userId: els.userId.value.trim() || "user_dev",
      email: els.email.value.trim() || "dev@example.local",
      tokenLabel: "Dashboard token",
    },
  });
  state.token = result.apiToken.secret;
  state.tokenSource = "platform";
  els.platformToken.value = state.token;
  localStorage.setItem("agentControllerToken", state.token);
  setStatus("Token created");
  log(result);
  connectEvents();
  await refreshAll();
});

els.saveTokenButton.addEventListener("click", async () => {
  state.token = els.platformToken.value.trim();
  state.tokenSource = "platform";
  localStorage.setItem("agentControllerToken", state.token);
  setStatus("Token saved");
  try {
    await refreshAll();
    connectEvents();
  } catch {
    state.token = "";
    state.tokenSource = null;
    localStorage.removeItem("agentControllerToken");
    setStatus("Invalid token");
  }
});

els.createDeviceButton.addEventListener("click", async () => {
  const result = await api("/v1/devices", {
    method: "POST",
    body: {
      label: els.deviceLabel.value.trim() || "Controller",
      profile: els.deviceProfile.value,
    },
  });
  els.deviceSecretBox.textContent = `id: ${result.device.id}\nsecret: ${result.secret}`;
  log(result);
  await refreshAll();
});

els.preprovisionDeviceButton.addEventListener("click", async () => {
  const result = await api("/v1/factory/devices", {
    method: "POST",
    auth: false,
    body: {
      label: els.deviceLabel.value.trim() || "Controller",
      profile: els.deviceProfile.value,
    },
  });
  els.claimCode.value = result.claimCode;
  els.deviceSecretBox.textContent = [
    "Factory device",
    `id: ${result.device.id}`,
    `secret: ${result.secret}`,
    `claimCode: ${result.claimCode}`,
  ].join("\n");
  log(result);
});

els.claimDeviceButton.addEventListener("click", async () => {
  const result = await api("/v1/devices/claim", {
    method: "POST",
    body: {
      claimCode: els.claimCode.value.trim(),
      label: els.deviceLabel.value.trim() || undefined,
    },
  });
  log(result);
  await refreshAll();
});

els.deviceConfigDevice.addEventListener("change", () => {
  void loadSelectedDeviceConfig();
});

els.saveDeviceConfigButton.addEventListener("click", async () => {
  const deviceId = els.deviceConfigDevice.value;
  if (!deviceId) {
    logText("Select a device first.");
    return;
  }
  const menu = [...document.querySelectorAll("[data-menu-item]:checked")]
    .map((input) => input.dataset.menuItem);
  const result = await api(`/v1/devices/${encodeURIComponent(deviceId)}/config`, {
    method: "PUT",
    body: {
      environmentId: els.deviceConfigEnvironment.value || null,
      threadId: els.deviceConfigThread.value.trim() || null,
      defaultPrompt: els.deviceDefaultPrompt.value.trim() || undefined,
      shellCommand: els.deviceShellCommand.value.trim() || undefined,
      menu,
    },
  });
  log(result);
  await refreshAll();
});

els.pairT3Button.addEventListener("click", () => registerEnvironment("pairingToken"));
els.accessT3Button.addEventListener("click", () => registerEnvironment("accessToken"));

els.refreshButton.addEventListener("click", refreshAll);
els.diagnosticsButton.addEventListener("click", downloadDiagnosticsBundle);
els.deviceList.addEventListener("click", (event) => {
  void handleDeviceListAction(event);
});
els.environmentList.addEventListener("click", (event) => {
  void handleEnvironmentListAction(event);
});
els.environmentSelect.addEventListener("change", () => {
  state.t3Threads = [];
  fillSelect(els.t3ThreadSelect, [], "Load sessions");
});
els.t3ThreadSelect.addEventListener("change", () => {
  const threadId = els.t3ThreadSelect.value;
  if (!threadId) return;
  els.threadId.value = threadId;
  els.deviceConfigThread.value = threadId;
});
els.loadT3SessionsButton.addEventListener("click", () => {
  void loadT3SessionsFromSelectedEnvironment();
});
els.approvalList.addEventListener("click", (event) => {
  void handleApprovalListAction(event);
});
els.commandList.addEventListener("click", (event) => {
  void handleApprovalListAction(event);
});
els.macroList.addEventListener("click", (event) => {
  void handleMacroListAction(event);
});
els.mediaList.addEventListener("click", (event) => {
  void handleMediaListAction(event);
});
els.startAudioButton.addEventListener("click", startAudioRecording);
els.stopAudioButton.addEventListener("click", stopAudioRecording);
els.startCameraButton.addEventListener("click", toggleCamera);
els.captureCameraButton.addEventListener("click", captureCameraFrame);
els.savePrivacyButton.addEventListener("click", savePrivacySettings);
els.purgeExpiredMediaButton.addEventListener("click", purgeExpiredMedia);

els.uploadMediaButton.addEventListener("click", async () => {
  const file = els.mediaFile.files[0];
  if (!file) {
    logText("Choose a file first.");
    return;
  }
  const dataBase64 = await fileToBase64(file);
  const kind = file.type.startsWith("audio/") ? "audio" : "image";
  await uploadMedia({
    kind,
    contentType: file.type,
    dataBase64,
    originalName: file.name,
    transcript: kind === "audio" ? els.mediaTranscript.value.trim() || undefined : undefined,
  });
});

els.sendPromptButton.addEventListener("click", () => sendIntentFromForm());
els.createMacroButton.addEventListener("click", createMacroFromForm);
els.statusButton.addEventListener("click", () => sendControlIntent({ type: "status" }));
els.stopButton.addEventListener("click", () => sendControlIntent({ type: "session_control", action: "stop" }));

async function registerEnvironment(tokenField) {
  const body = {
    label: els.t3Label.value.trim() || "T3 Code",
    baseUrl: els.t3BaseUrl.value.trim(),
  };
  body[tokenField] = els.t3Token.value.trim();
  const result = await api("/v1/t3/environments", { method: "POST", body });
  log(result);
  await refreshAll();
}

async function loadT3SessionsFromSelectedEnvironment() {
  const environmentId = els.environmentSelect.value;
  if (!environmentId) {
    logText("Select a T3 environment first.");
    return;
  }
  els.loadT3SessionsButton.disabled = true;
  try {
    const result = await api(`/v1/t3/environments/${encodeURIComponent(environmentId)}/snapshot`);
    const threads = Array.isArray(result.snapshot?.threads) ? result.snapshot.threads : [];
    const projects = Array.isArray(result.snapshot?.projects) ? result.snapshot.projects : [];
    state.t3Threads = threads
      .map((thread) => normalizeT3ThreadOption(thread, projects))
      .filter((thread) => thread.id);
    fillSelect(els.t3ThreadSelect, state.t3Threads, "No threads");
    if (state.t3Threads.length > 0) {
      els.t3ThreadSelect.value = state.t3Threads[0].id;
      els.threadId.value = state.t3Threads[0].id;
      els.deviceConfigThread.value = state.t3Threads[0].id;
    }
    log({
      environment: result.environment,
      screen: result.screen,
      projects,
      threads: state.t3Threads,
    });
    await refreshEnvironments();
  } finally {
    els.loadT3SessionsButton.disabled = false;
  }
}

async function handleDeviceListAction(event) {
  const button = event.target.closest("[data-device-action]");
  if (!button) return;
  const deviceId = button.dataset.deviceId;
  const action = button.dataset.deviceAction;
  if (!deviceId) return;

  button.disabled = true;
  try {
    if (action === "profile") {
      const profileSelect = button.closest(".list-item")?.querySelector("[data-device-profile]");
      const profile = profileSelect?.value;
      if (!profile) {
        logText("Choose a device profile first.");
        return;
      }
      const result = await api(`/v1/devices/${encodeURIComponent(deviceId)}/profile`, {
        method: "PUT",
        body: { profile },
      });
      log(result);
      await refreshAll();
      return;
    }

    if (action === "rotate") {
      const result = await api(`/v1/devices/${encodeURIComponent(deviceId)}/rotate-secret`, {
        method: "POST",
        body: {},
      });
      els.deviceSecretBox.textContent = [
        "Rotated device secret",
        `id: ${result.device.id}`,
        `secret: ${result.secret}`,
      ].join("\n");
      log(result);
      await refreshAll();
      return;
    }

    if (action === "transfer-reset") {
      const device = state.devices.find((candidate) => candidate.id === deviceId);
      const label = device?.label || deviceId;
      if (!window.confirm(`Reset ${label} for transfer? This unclaims it, rotates the hardware secret, and creates a new claim code.`)) return;
      const result = await api(`/v1/devices/${encodeURIComponent(deviceId)}/transfer-reset`, {
        method: "POST",
        body: {},
      });
      els.deviceSecretBox.textContent = [
        "Transfer reset",
        `id: ${result.device.id}`,
        `secret: ${result.secret}`,
        `claimCode: ${result.claimCode}`,
      ].join("\n");
      log(result);
      await refreshAll();
      return;
    }

    if (action === "revoke") {
      const device = state.devices.find((candidate) => candidate.id === deviceId);
      const label = device?.label || deviceId;
      if (!window.confirm(`Revoke ${label}? This disables the current hardware credential.`)) return;
      const result = await api(`/v1/devices/${encodeURIComponent(deviceId)}/revoke`, {
        method: "POST",
        body: {},
      });
      log(result);
      await refreshAll();
    }
  } finally {
    button.disabled = false;
  }
}

async function handleEnvironmentListAction(event) {
  const button = event.target.closest("[data-environment-action]");
  if (!button) return;
  const environmentId = button.dataset.environmentId;
  const action = button.dataset.environmentAction;
  if (!environmentId || !["check", "load", "update", "delete"].includes(action)) return;

  button.disabled = true;
  try {
    const environment = state.environments.find((candidate) => candidate.id === environmentId);
    if (action === "load") {
      if (environment) {
        els.t3Label.value = environment.label || "";
        els.t3BaseUrl.value = environment.baseUrl || "";
        els.t3Token.value = "";
      }
      return;
    }
    if (action === "update") {
      const result = await api(`/v1/t3/environments/${encodeURIComponent(environmentId)}`, {
        method: "PUT",
        body: {
          label: els.t3Label.value.trim() || environment?.label,
          baseUrl: els.t3BaseUrl.value.trim() || environment?.baseUrl,
          accessToken: els.t3Token.value.trim() || undefined,
        },
      });
      log(result);
      await refreshAll();
      return;
    }
    if (action === "delete") {
      const label = environment?.label || environmentId;
      if (!window.confirm(`Unpair ${label}? Devices using it will have their default environment cleared.`)) return;
      const result = await api(`/v1/t3/environments/${encodeURIComponent(environmentId)}`, {
        method: "DELETE",
      });
      log(result);
      await refreshAll();
      return;
    }
    const result = await api(`/v1/t3/environments/${encodeURIComponent(environmentId)}/check`, {
      method: "POST",
      body: {},
    });
    log(result);
    await refreshAll();
  } finally {
    button.disabled = false;
  }
}

async function handleApprovalListAction(event) {
  const button = event.target.closest("[data-command-action]");
  if (!button) return;
  const commandId = button.dataset.commandId;
  const action = button.dataset.commandAction;
  if (!commandId || !["approve", "reject", "events"].includes(action)) return;

  button.disabled = true;
  try {
    if (action === "events") {
      const result = await api(`/v1/commands/${encodeURIComponent(commandId)}/events`);
      state.commandEvents = result.events;
      renderCommandTimeline(result.command, result.events);
      log(result);
      return;
    }
    const result = await api(`/v1/commands/${encodeURIComponent(commandId)}/${action}`, {
      method: "POST",
      body: {},
    });
    log(result);
    await refreshAll();
  } finally {
    button.disabled = false;
  }
}

async function handleMediaListAction(event) {
  const button = event.target.closest("[data-media-action]");
  if (!button) return;
  const mediaId = button.dataset.mediaId;
  const action = button.dataset.mediaAction;
  if (!mediaId || !["delete", "transcript", "transcribe"].includes(action)) return;

  if (action === "transcript") {
    const textarea = button.closest(".list-item")?.querySelector("[data-media-transcript]");
    const transcript = textarea?.value.trim();
    if (!transcript) {
      logText("Enter a transcript first.");
      return;
    }
    button.disabled = true;
    try {
      const result = await api(`/v1/media/${encodeURIComponent(mediaId)}/transcript`, {
        method: "PUT",
        body: { transcript },
      });
      log(result);
      await refreshAll();
    } finally {
      button.disabled = false;
    }
    return;
  }

  if (action === "transcribe") {
    button.disabled = true;
    try {
      const result = await api(`/v1/media/${encodeURIComponent(mediaId)}/transcribe`, {
        method: "POST",
        body: {},
      });
      log(result);
      await refreshMedia();
    } finally {
      button.disabled = false;
    }
    return;
  }

  const media = state.media.find((candidate) => candidate.id === mediaId);
  const label = media?.originalName || media?.id || mediaId;
  if (!window.confirm(`Delete ${label}? This removes the stored media capture.`)) return;

  button.disabled = true;
  try {
    const result = await api(`/v1/media/${encodeURIComponent(mediaId)}`, { method: "DELETE" });
    log(result);
    await refreshAll();
  } finally {
    button.disabled = false;
  }
}

async function handleMacroListAction(event) {
  const button = event.target.closest("[data-macro-action]");
  if (!button) return;
  const macroId = button.dataset.macroId;
  const action = button.dataset.macroAction;
  if (!macroId || !["run", "delete"].includes(action)) return;

  button.disabled = true;
  try {
    if (action === "run") {
      const result = await api(`/v1/macros/${encodeURIComponent(macroId)}/run`, {
        method: "POST",
        body: {
          environmentId: els.environmentSelect.value || undefined,
          threadId: els.threadId.value.trim() || undefined,
        },
      });
      log(result);
      await refreshAll();
      return;
    }

    const macro = state.macros.find((candidate) => candidate.id === macroId);
    const label = macro?.label || macroId;
    if (!window.confirm(`Delete ${label}?`)) return;
    const result = await api(`/v1/macros/${encodeURIComponent(macroId)}`, { method: "DELETE" });
    log(result);
    await refreshAll();
  } finally {
    button.disabled = false;
  }
}

async function startAudioRecording() {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    logText("Audio recording is not available in this browser.");
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.audioChunks = [];
    const recorder = new MediaRecorder(stream);
    state.audioRecorder = recorder;
    recorder.addEventListener("dataavailable", (event) => {
      if (event.data.size > 0) state.audioChunks.push(event.data);
    });
    recorder.addEventListener("stop", () => {
      for (const track of stream.getTracks()) track.stop();
      void uploadRecordedAudio();
    }, { once: true });
    recorder.start();
    els.startAudioButton.disabled = true;
    els.stopAudioButton.disabled = false;
    els.audioCaptureStatus.textContent = "Recording";
  } catch (error) {
    els.audioCaptureStatus.textContent = "Blocked";
    logText(error.message);
  }
}

function stopAudioRecording() {
  if (!state.audioRecorder || state.audioRecorder.state === "inactive") return;
  state.audioRecorder.stop();
  els.stopAudioButton.disabled = true;
  els.audioCaptureStatus.textContent = "Saving";
}

async function uploadRecordedAudio() {
  try {
    const contentType = normalizeContentType(state.audioChunks[0]?.type || "audio/webm");
    const blob = new Blob(state.audioChunks, { type: contentType });
    const dataBase64 = await blobToBase64(blob);
    const result = await uploadMedia({
      kind: "audio",
      contentType,
      dataBase64,
      transcript: els.mediaTranscript.value.trim() || undefined,
      originalName: `recording-${new Date().toISOString()}.webm`,
    });
    els.mediaSelect.value = result.media.id;
    els.intentType.value = "audio_prompt";
    els.audioCaptureStatus.textContent = "Uploaded";
  } catch (error) {
    els.audioCaptureStatus.textContent = "Error";
    logText(error.message);
  } finally {
    state.audioRecorder = null;
    state.audioChunks = [];
    els.startAudioButton.disabled = false;
  }
}

async function toggleCamera() {
  if (state.cameraStream) {
    closeCamera();
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    logText("Camera capture is not available in this browser.");
    return;
  }
  try {
    state.cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false,
    });
    els.cameraPreview.srcObject = state.cameraStream;
    await els.cameraPreview.play();
    els.startCameraButton.textContent = "Close";
    els.captureCameraButton.disabled = false;
    els.cameraCaptureStatus.textContent = "Ready";
  } catch (error) {
    els.cameraCaptureStatus.textContent = "Blocked";
    logText(error.message);
  }
}

async function captureCameraFrame() {
  if (!state.cameraStream || !els.cameraPreview.videoWidth) return;
  els.cameraCaptureStatus.textContent = "Saving";
  const canvas = document.createElement("canvas");
  canvas.width = els.cameraPreview.videoWidth;
  canvas.height = els.cameraPreview.videoHeight;
  const context = canvas.getContext("2d");
  context.drawImage(els.cameraPreview, 0, 0, canvas.width, canvas.height);
  const blob = await canvasToBlob(canvas, "image/png");
  const dataBase64 = await blobToBase64(blob);
  const result = await uploadMedia({
    kind: "image",
    contentType: "image/png",
    dataBase64,
    originalName: `snapshot-${new Date().toISOString()}.png`,
  });
  els.mediaSelect.value = result.media.id;
  els.intentType.value = "camera_prompt";
  els.cameraCaptureStatus.textContent = "Uploaded";
}

function closeCamera() {
  for (const track of state.cameraStream?.getTracks() || []) track.stop();
  state.cameraStream = null;
  els.cameraPreview.srcObject = null;
  els.startCameraButton.textContent = "Open";
  els.captureCameraButton.disabled = true;
  els.cameraCaptureStatus.textContent = "Idle";
}

async function uploadMedia(payload) {
  const result = await api("/v1/media", {
    method: "POST",
    body: payload,
  });
  log(result);
  await refreshAll();
  return result;
}

async function savePrivacySettings() {
  const rawRetentionDays = els.mediaRetentionDays.value.trim();
  const mediaRetentionDays = rawRetentionDays === "" ? null : Number(rawRetentionDays);
  if (mediaRetentionDays === null) {
    const result = await api("/v1/settings/privacy", {
      method: "PUT",
      body: { mediaRetentionDays },
    });
    log(result);
    await refreshPrivacy();
    return;
  }
  if (!Number.isInteger(mediaRetentionDays) || mediaRetentionDays < 1 || mediaRetentionDays > 365) {
    logText("Media retention days must be an integer from 1 to 365.");
    return;
  }
  const result = await api("/v1/settings/privacy", {
    method: "PUT",
    body: { mediaRetentionDays },
  });
  log(result);
  await refreshPrivacy();
}

async function purgeExpiredMedia() {
  const result = await api("/v1/media/purge-expired", {
    method: "POST",
    body: {},
  });
  log(result);
  await refreshAll();
}

async function sendIntentFromForm() {
  await sendControlIntent(buildIntentFromForm());
}

function buildIntentFromForm() {
  const type = els.intentType.value;
  const text = els.promptText.value.trim();
  const intent = { type };
  if (type === "shell_input") {
    intent.command = text;
  } else if (type === "camera_prompt") {
    intent.prompt = text || "Use the selected image as context.";
  } else if (type === "audio_prompt") {
    intent.transcript = text;
  } else {
    intent.text = text;
  }
  const mediaId = els.mediaSelect.value;
  if (mediaId && (type === "camera_prompt" || type === "audio_prompt")) {
    intent.mediaUploadId = mediaId;
  }
  return intent;
}

async function createMacroFromForm() {
  const environmentId = els.environmentSelect.value || null;
  const body = {
    label: els.macroLabel.value.trim() || els.promptText.value.trim() || els.intentType.value,
    environmentId,
    threadId: els.threadId.value.trim() || null,
    intent: buildIntentFromForm(),
  };
  const result = await api("/v1/macros", { method: "POST", body });
  log(result);
  els.macroLabel.value = "";
  await refreshAll();
}

async function sendControlIntent(intent) {
  const environmentId = els.environmentSelect.value;
  if (!environmentId) {
    logText("Register or select a T3 environment first.");
    return;
  }
  const body = { environmentId, intent };
  if (intent.type !== "status") body.threadId = els.threadId.value.trim();
  const result = await api("/v1/intents", { method: "POST", body });
  log(result);
  await refreshAudit();
}

async function refreshAll() {
  if (!state.token) {
    setStatus("No token");
    return;
  }
  await Promise.all([
    refreshEnvironments(),
    refreshDevices(),
    refreshCommands(),
    refreshMacros(),
    refreshPrivacy(),
    refreshMedia(),
    refreshAudit(),
    refreshDisplay(),
  ]);
  await loadSelectedDeviceConfig();
  setStatus("Connected");
}

async function downloadDiagnosticsBundle() {
  const bundle = await api("/v1/support/diagnostics");
  const blob = new Blob([`${JSON.stringify(bundle, null, 2)}\n`], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `agent-controller-diagnostics-${new Date().toISOString().replaceAll(":", "-")}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
  log(bundle);
}

function connectEvents() {
  if (state.events) {
    state.events.close();
    state.events = null;
  }
  if (!state.token) return;
  const stream = new EventSource(`/v1/events?token=${encodeURIComponent(state.token)}`);
  state.events = stream;
  stream.addEventListener("connected", () => setStatus("Live"));
  stream.addEventListener("heartbeat", () => {
    if (els.connectionStatus.textContent !== "Error") setStatus("Live");
  });
  stream.addEventListener("state.changed", (event) => {
    try {
      const payload = JSON.parse(event.data);
      setStatus(payload.summary.latestAction || "Updated");
    } catch {
      setStatus("Updated");
    }
    scheduleRefresh();
  });
  stream.onerror = () => setStatus("Live reconnecting");
}

function scheduleRefresh() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(() => {
    void refreshAll();
  }, 250);
}

async function refreshEnvironments() {
  const result = await api("/v1/t3/environments");
  state.environments = result.environments;
  fillSelect(els.environmentSelect, state.environments, "No environments");
  fillSelect(els.deviceConfigEnvironment, state.environments, "No environments");
  if (els.t3ThreadSelect.options.length === 0) {
    fillSelect(els.t3ThreadSelect, state.t3Threads, "Load sessions");
  }
  els.environmentList.innerHTML = renderList(
    state.environments,
    (environment) => `
      <div class="list-title"><span>${escapeHtml(environment.label)}</span><span>${escapeHtml(environment.status)}</span></div>
      <div class="meta">${escapeHtml(environment.id)}</div>
      <div class="meta">${escapeHtml(environment.baseUrl)}</div>
      ${renderEnvironmentHealth(environment)}
      <div class="list-actions">
        <button class="mini" data-environment-action="check" data-environment-id="${escapeHtml(environment.id)}">Check</button>
        <button class="mini" data-environment-action="load" data-environment-id="${escapeHtml(environment.id)}">Load</button>
        <button class="mini" data-environment-action="update" data-environment-id="${escapeHtml(environment.id)}">Update</button>
        <button class="mini danger" data-environment-action="delete" data-environment-id="${escapeHtml(environment.id)}">Unpair</button>
      </div>
    `,
  );
}

function renderEnvironmentHealth(environment) {
  const health = environment.health || {};
  const values = [
    `checked=${formatRelativeTime(health.lastCheckedAt)}`,
    `reachable=${formatRelativeTime(health.lastReachableAt)}`,
    `snapshot=${health.snapshot ? `${health.snapshot.line1} / ${health.snapshot.line2}` : "none"}`,
  ];
  if (health.lastError) values.push(`error=${health.lastError}`);
  return `<div class="meta">${values.map(escapeHtml).join(" | ")}</div>`;
}

function normalizeT3ThreadOption(thread, projects) {
  const id = thread?.id || thread?.threadId || thread?.sessionId || "";
  const projectId = thread?.projectId || thread?.project?.id || null;
  const project = projects.find((candidate) => candidate.id === projectId);
  const title = thread?.title || thread?.name || thread?.label || id;
  const suffix = project?.title || project?.name || projectId || "";
  return {
    id,
    label: suffix ? `${title} - ${suffix}` : title,
    projectId,
    status: thread?.status || thread?.state || null,
  };
}

async function refreshDevices() {
  const result = await api("/v1/devices");
  state.devices = result.devices;
  const previousDeviceId = els.deviceConfigDevice.value;
  fillSelect(els.deviceConfigDevice, state.devices, "No devices");
  if (previousDeviceId && state.devices.some((device) => device.id === previousDeviceId)) {
    els.deviceConfigDevice.value = previousDeviceId;
  }
  els.deviceList.innerHTML = renderList(
    state.devices,
    (device) => `
      <div class="list-title"><span>${escapeHtml(device.label)}</span><span>${escapeHtml(device.profile)}</span></div>
      <div class="meta">${escapeHtml(device.id)}</div>
      <div class="meta">lastSeen=${escapeHtml(device.lastSeenAt || "never")}</div>
      <div class="meta">env=${escapeHtml(device.config?.environmentId || "unset")}</div>
      <div class="meta">thread=${escapeHtml(device.config?.threadId || "unset")}</div>
      <div class="meta">shell=${escapeHtml(device.config?.shellCommand || "unset")}</div>
      ${renderDeviceStatus(device)}
      <div class="list-actions">
        <select data-device-profile="${escapeHtml(device.id)}">${renderProfileOptions(device.profile)}</select>
        <button class="mini" data-device-action="profile" data-device-id="${escapeHtml(device.id)}">Save profile</button>
        <button class="mini" data-device-action="rotate" data-device-id="${escapeHtml(device.id)}">Rotate secret</button>
        <button class="mini danger" data-device-action="transfer-reset" data-device-id="${escapeHtml(device.id)}">Transfer reset</button>
        <button class="mini danger" data-device-action="revoke" data-device-id="${escapeHtml(device.id)}">Revoke</button>
      </div>
    `,
  );
}

function renderDeviceStatus(device) {
  const status = device.status || {};
  const presence = device.presence || {};
  const heartbeat = status.lastHeartbeatAt || device.lastSeenAt || null;
  const age = heartbeat ? Math.max(0, Date.now() - Date.parse(heartbeat)) : Number.POSITIVE_INFINITY;
  const state = presence.state || (age <= 90_000 ? "online" : "offline");
  const values = [
    `state=${state}`,
    `fw=${status.firmwareVersion || "unknown"}`,
    `hw=${status.hardwareModel || "unknown"}`,
    `ip=${status.ipAddress || "unknown"}`,
    `rssi=${formatStatusNumber(status.wifiRssi, "dBm")}`,
    `heap=${formatStatusNumber(status.freeHeap, "B")}`,
    `uptime=${formatUptime(status.uptimeMs)}`,
  ];
  if (status.batteryPercent !== null && status.batteryPercent !== undefined) {
    values.push(`battery=${formatStatusNumber(status.batteryPercent, "%")}`);
  } else if (status.batteryMv !== null && status.batteryMv !== undefined) {
    values.push(`battery=${formatStatusNumber(status.batteryMv, "mV")}`);
  }
  return `<div class="meta">${values.map(escapeHtml).join(" | ")}</div>`;
}

function formatStatusNumber(value, unit) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "unknown";
  return `${Number(value)} ${unit}`;
}

function formatUptime(value) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "unknown";
  const seconds = Math.floor(Number(value) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h ${remainingMinutes}m`;
}

function formatRelativeTime(value) {
  if (!value) return "never";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const ageSeconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (ageSeconds < 60) return `${ageSeconds}s ago`;
  const ageMinutes = Math.floor(ageSeconds / 60);
  if (ageMinutes < 60) return `${ageMinutes}m ago`;
  const ageHours = Math.floor(ageMinutes / 60);
  if (ageHours < 24) return `${ageHours}h ago`;
  const ageDays = Math.floor(ageHours / 24);
  return `${ageDays}d ago`;
}

async function loadSelectedDeviceConfig() {
  const deviceId = els.deviceConfigDevice.value;
  if (!deviceId || !state.token) {
    els.deviceConfigThread.value = "";
    els.deviceDefaultPrompt.value = "";
    els.deviceShellCommand.value = "";
    return;
  }
  const result = await api(`/v1/devices/${encodeURIComponent(deviceId)}/config`);
  const config = result.config;
  els.deviceConfigEnvironment.value = config.environmentId || "";
  els.deviceConfigThread.value = config.threadId || "";
  els.deviceDefaultPrompt.value = config.defaultPrompt || "";
  els.deviceShellCommand.value = config.shellCommand || "";
  const active = new Set(config.menu || []);
  for (const input of document.querySelectorAll("[data-menu-item]")) {
    input.checked = active.has(input.dataset.menuItem);
  }
}

async function refreshMedia() {
  const result = await api("/v1/media");
  state.media = result.media;
  fillSelect(els.mediaSelect, state.media, "No media");
  els.mediaList.innerHTML = renderList(
    state.media,
    (media) => `
      <div class="list-title"><span>${escapeHtml(media.kind)}</span><span>${media.sizeBytes} B</span></div>
      <div class="meta">${escapeHtml(media.id)}</div>
      <div class="meta">${escapeHtml(media.contentType)}</div>
      <div class="meta">transcript=${media.transcript ? `${media.transcript.length} chars` : "none"}</div>
      <div class="meta">processing=${escapeHtml(formatMediaProcessing(media))}</div>
      <div class="meta">expires=${escapeHtml(media.expiresAt || "manual deletion")}</div>
      <div class="list-actions">
        ${media.kind === "audio" ? `
          <textarea data-media-transcript="${escapeHtml(media.id)}" rows="2" placeholder="Transcript">${escapeHtml(media.transcript || "")}</textarea>
          <button class="mini" data-media-action="transcribe" data-media-id="${escapeHtml(media.id)}">Transcribe</button>
          <button class="mini" data-media-action="transcript" data-media-id="${escapeHtml(media.id)}">Save transcript</button>
        ` : ""}
        <button class="mini danger" data-media-action="delete" data-media-id="${escapeHtml(media.id)}">Delete</button>
      </div>
    `,
  );
}

function formatMediaProcessing(media) {
  const processing = media.processing || {};
  const parts = [processing.transcriptionStatus || "unknown"];
  if (processing.transcriptSource) parts.push(`source=${processing.transcriptSource}`);
  if (processing.lastError) parts.push(`error=${processing.lastError}`);
  return parts.join(" ");
}

async function refreshMacros() {
  const result = await api("/v1/macros");
  state.macros = result.macros;
  els.macroList.innerHTML = renderList(
    state.macros,
    (macro) => `
      <div class="list-title"><span>${escapeHtml(macro.label)}</span><span>${escapeHtml(macro.intent?.type || "intent")}</span></div>
      <div class="meta">${escapeHtml(macro.id)}</div>
      <div class="meta">env=${escapeHtml(macro.environmentId || "selected")}</div>
      <div class="meta">thread=${escapeHtml(macro.threadId || "selected")}</div>
      <div class="list-actions">
        <button class="mini" data-macro-action="run" data-macro-id="${escapeHtml(macro.id)}">Run</button>
        <button class="mini danger" data-macro-action="delete" data-macro-id="${escapeHtml(macro.id)}">Delete</button>
      </div>
    `,
  );
}

async function refreshPrivacy() {
  const result = await api("/v1/settings/privacy");
  els.mediaRetentionDays.value = result.privacy.mediaRetentionDays ?? "";
}

async function refreshCommands() {
  const result = await api("/v1/commands");
  state.commands = result.commands;
  const approvals = state.commands
    .filter((command) => command.status === "approval_required")
    .slice(-12)
    .reverse();
  els.approvalList.innerHTML = renderList(
    approvals,
    (command) => `
      <div class="list-title"><span>${escapeHtml(command.intent?.type || "command")}</span><span>${escapeHtml(command.risk)}</span></div>
      <div class="meta">${escapeHtml(command.id)}</div>
      <div class="meta">${escapeHtml(command.intent?.command || command.intent?.text || command.result?.reason || "")}</div>
      <div class="meta">thread=${escapeHtml(command.threadId || "unset")}</div>
      <div class="list-actions">
        <button class="mini" data-command-action="events" data-command-id="${escapeHtml(command.id)}">Timeline</button>
        <button class="mini" data-command-action="approve" data-command-id="${escapeHtml(command.id)}">Approve</button>
        <button class="mini danger" data-command-action="reject" data-command-id="${escapeHtml(command.id)}">Reject</button>
      </div>
    `,
  );
  const recent = state.commands.slice(-12).reverse();
  els.commandList.innerHTML = renderList(
    recent,
    (command) => `
      <div class="list-title"><span>${escapeHtml(command.intent?.type || "command")}</span><span>${escapeHtml(command.status)}</span></div>
      <div class="meta">${escapeHtml(command.id)}</div>
      <div class="meta">risk=${escapeHtml(command.risk)} | thread=${escapeHtml(command.threadId || "unset")}</div>
      <div class="list-actions">
        <button class="mini" data-command-action="events" data-command-id="${escapeHtml(command.id)}">Timeline</button>
      </div>
    `,
  );
}

function renderCommandTimeline(command, events) {
  els.commandTimeline.innerHTML = renderList(
    events,
    (event) => `
      <div class="list-title"><span>${escapeHtml(event.status)}</span><span>${escapeHtml(formatRelativeTime(event.createdAt))}</span></div>
      <div class="meta">${escapeHtml(event.id)}</div>
      <div class="meta">actor=${escapeHtml(event.actorType)}${event.actorId ? `:${escapeHtml(event.actorId)}` : ""}</div>
      <div class="meta">previous=${escapeHtml(event.previousStatus || "none")} | risk=${escapeHtml(event.risk)}</div>
      <div class="meta">${escapeHtml(renderEventResult(event.result))}</div>
    `,
  );
  if (!events.length) {
    els.commandTimeline.innerHTML = `<div class="list-item meta">No events for ${escapeHtml(command.id)}</div>`;
  }
}

async function refreshAudit() {
  const result = await api("/v1/audit");
  els.auditList.innerHTML = renderList(
    result.events.slice(-24).reverse(),
    (event) => `
      <div class="list-title"><span>${escapeHtml(event.action)}</span><span>${new Date(event.createdAt).toLocaleTimeString()}</span></div>
      <div class="meta">${escapeHtml(event.actorType)} ${escapeHtml(event.actorId || "")}</div>
      <div class="meta">${escapeHtml(event.targetId || "")}</div>
    `,
  );
}

async function refreshDisplay() {
  const result = await api("/v1/display");
  els.displayState.textContent = JSON.stringify(result.display, null, 2);
}

async function api(path, options = {}) {
  try {
    const headers = { "content-type": "application/json" };
    if (options.auth !== false) headers.authorization = `Bearer ${state.token}`;
    const response = await fetch(path, {
      method: options.method || "GET",
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error?.message || `HTTP ${response.status}`);
    }
    return data;
  } catch (error) {
    setStatus("Error");
    logText(error.message);
    throw error;
  }
}

function fillSelect(select, items, emptyLabel) {
  select.innerHTML = "";
  if (items.length === 0) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = emptyLabel;
    select.append(option);
    return;
  }
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.id;
    option.textContent = item.label || item.originalName || item.id;
    select.append(option);
  }
}

function renderList(items, renderItem) {
  if (!items.length) return `<div class="list-item meta">Empty</div>`;
  return items.map((item) => `<div class="list-item">${renderItem(item)}</div>`).join("");
}

function fileToBase64(file) {
  return blobToBase64(file);
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function canvasToBlob(canvas, type) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Unable to capture camera frame."));
    }, type);
  });
}

function normalizeContentType(value) {
  return String(value || "").split(";")[0].trim().toLowerCase();
}

function setStatus(message) {
  els.connectionStatus.textContent = message || (state.token ? `${state.tokenSource || "Token"} loaded` : "No token");
}

function log(value) {
  els.consoleOutput.textContent = JSON.stringify(value, null, 2);
}

function logText(value) {
  els.consoleOutput.textContent = value;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

void boot();

async function boot() {
  await loadAuthConfig();
  await loadDeviceProfiles();
  await initClerkIfAvailable();
  if (!state.token) {
    setStatus("No token");
    return;
  }
  try {
    await refreshAll();
    connectEvents();
  } catch {
    state.token = "";
    state.tokenSource = null;
    localStorage.removeItem("agentControllerToken");
    els.platformToken.value = "";
    setStatus("No token");
  }
}

async function loadDeviceProfiles() {
  try {
    const response = await fetch("/v1/device-profiles");
    const result = await response.json();
    state.deviceProfiles = result.profiles || [];
    if (state.deviceProfiles.length) fillSelect(els.deviceProfile, state.deviceProfiles, "No profiles");
  } catch (error) {
    state.deviceProfiles = [];
    logText(`Device profiles unavailable: ${error.message}`);
  }
}

async function loadAuthConfig() {
  try {
    const response = await fetch("/v1/auth/config");
    state.authConfig = await response.json();
    updateDevTokenUi();
  } catch (error) {
    state.authConfig = null;
    updateDevTokenUi();
    logText(`Auth config unavailable: ${error.message}`);
  }
}

function updateDevTokenUi() {
  const enabled = state.authConfig?.developmentTokens?.enabled !== false;
  els.createTokenButton.disabled = !enabled;
  els.createTokenButton.title = enabled
    ? ""
    : "Development tokens are disabled for this gateway.";
  if (!enabled && !state.token) {
    els.platformToken.placeholder = "Sign in with Clerk to use this gateway.";
  }
}

function renderProfileOptions(selectedProfile) {
  const profiles = state.deviceProfiles.length
    ? state.deviceProfiles
    : [
      { id: "agent-controller", label: "Agent controller" },
      { id: "read-only", label: "Read only" },
      { id: "power-controller", label: "Power controller" },
    ];
  return profiles.map((profile) => {
    const selected = profile.id === selectedProfile ? " selected" : "";
    return `<option value="${escapeHtml(profile.id)}"${selected}>${escapeHtml(profile.label || profile.id)}</option>`;
  }).join("");
}

function renderEventResult(result) {
  if (!result) return "result=none";
  if (typeof result === "string") return result;
  if (typeof result.status === "string") return `result=${result.status}`;
  if (typeof result.reason === "string") return `reason=${result.reason}`;
  return JSON.stringify(result);
}

async function initClerkIfAvailable() {
  const clerkConfig = state.authConfig?.clerk;
  if (!clerkConfig?.enabled || !clerkConfig.publishableKey) {
    updateClerkUi("Disabled");
    return;
  }
  els.clerkControls.hidden = false;
  updateClerkUi("Loading");
  try {
    state.clerk = await loadClerk(clerkConfig.publishableKey);
    state.clerkReady = true;
    state.clerk.addListener?.(() => {
      updateClerkUi();
    });
    updateClerkUi();
    if (!state.token && state.clerk.session) {
      await useClerkSession();
    }
  } catch (error) {
    updateClerkUi("Error");
    logText(`Clerk failed to load: ${error.message}`);
  }
}

async function loadClerk(publishableKey) {
  await loadScript("https://cdn.jsdelivr.net/npm/@clerk/clerk-js@latest/dist/clerk.browser.js", {
    "data-clerk-publishable-key": publishableKey,
  });
  const clerkGlobal = window.Clerk;
  if (!clerkGlobal) throw new Error("Clerk browser SDK did not initialize.");
  if (typeof clerkGlobal.load === "function") {
    await clerkGlobal.load();
    return clerkGlobal;
  }
  if (typeof clerkGlobal === "function") {
    const clerk = new clerkGlobal(publishableKey);
    await clerk.load();
    return clerk;
  }
  throw new Error("Unsupported Clerk browser SDK shape.");
}

function loadScript(src, attributes = {}) {
  const existing = document.querySelector(`script[src="${src}"]`);
  if (existing) {
    return existing.dataset.loaded === "true"
      ? Promise.resolve()
      : new Promise((resolve, reject) => {
        existing.addEventListener("load", resolve, { once: true });
        existing.addEventListener("error", reject, { once: true });
      });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = src;
    script.async = true;
    script.crossOrigin = "anonymous";
    for (const [key, value] of Object.entries(attributes)) {
      script.setAttribute(key, value);
    }
    script.addEventListener("load", () => {
      script.dataset.loaded = "true";
      resolve();
    }, { once: true });
    script.addEventListener("error", () => reject(new Error(`Failed to load ${src}`)), { once: true });
    document.head.append(script);
  });
}

async function signInWithClerk() {
  if (!state.clerkReady) {
    logText("Clerk is not ready.");
    return;
  }
  await state.clerk.openSignIn();
}

async function useClerkSession() {
  if (!state.clerk?.session) {
    updateClerkUi("No session");
    logText("Sign in with Clerk first.");
    return;
  }
  const token = await state.clerk.session.getToken();
  if (!token) {
    updateClerkUi("No token");
    logText("Clerk session token is unavailable.");
    return;
  }
  state.token = token;
  state.tokenSource = "clerk";
  localStorage.removeItem("agentControllerToken");
  els.platformToken.value = "Clerk session token loaded in memory.";
  setStatus("Clerk session");
  connectEvents();
  await refreshAll();
}

async function signOutOfClerk() {
  if (!state.clerkReady) return;
  await state.clerk.signOut();
  if (state.tokenSource === "clerk") {
    state.token = "";
    state.tokenSource = null;
    els.platformToken.value = "";
    if (state.events) state.events.close();
    state.events = null;
  }
  updateClerkUi();
  setStatus();
}

function updateClerkUi(status = null) {
  const clerk = state.clerk;
  if (!els.clerkControls.hidden) {
    const signedIn = Boolean(clerk?.session);
    els.clerkStatus.textContent = status || (signedIn ? "Signed in" : "Signed out");
    els.clerkUser.textContent = signedIn
      ? `${clerk.user?.primaryEmailAddress?.emailAddress || clerk.user?.id || "Signed-in user"}`
      : "No active session.";
    els.clerkUseSessionButton.disabled = !signedIn;
    els.clerkSignOutButton.disabled = !signedIn;
  }
}
