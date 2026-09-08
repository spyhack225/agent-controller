import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { createStore } from "./store.mjs";

export async function createFileStore(filePath, options = {}) {
  const seed = await readState(filePath);
  const store = createStore(seed, options);
  let pending = Promise.resolve();

  store.subscribe((state) => {
    pending = pending.then(() => writeState(filePath, state));
  });

  // The app awaits this method before policy or T3 dispatch. Do not let that await resolve until
  // the receipt has crossed the atomic file rename boundary; otherwise a process restart in the
  // small gap between the in-memory claim and the queued write could admit the same turn again.
  const claimCommandRequest = store.claimCommandRequest;
  store.claimCommandRequest = async (input) => {
    const result = claimCommandRequest(input);
    await pending;
    return result;
  };

  // Likewise, do not acknowledge a terminal receipt to the client until its command reference and
  // all preceding queued state writes are durable. Otherwise the browser could clear its recovery
  // journal, the process could restart, and the receipt would remain stuck at `processing`.
  const settleCommandRequest = store.settleCommandRequest;
  store.settleCommandRequest = async (input) => {
    const result = settleCommandRequest(input);
    await pending;
    return result;
  };

  // Inbox state and worker-health evidence are acknowledged only after the atomic rename. A
  // notification shown as read/dismissed, or a scheduler shown as healthy, must survive the next
  // process restart rather than living only in the in-memory write queue.
  for (const method of [
    "createNotification",
    "markNotificationRead",
    "dismissNotification",
    "dismissNotificationByDedupe",
    "markAllNotificationsRead",
    "recordBackgroundLiveness",
    "archiveEnvironment",
    "restoreEnvironment",
    "purgeEnvironment",
    "upsertPushSubscription",
    "revokePushSubscription",
    "revokePushSubscriptionByEndpoint",
    "enqueuePushDeliveries",
    "claimPushDeliveries",
    "settlePushDelivery",
    "createCompanionHandoff",
    "claimCompanionHandoff",
    "cancelCompanionHandoff",
    "completeCompanionHandoff",
    "createMediaUploadSession",
    "markMediaUploadSessionUploaded",
    "finalizeMediaUploadSession",
    "abortMediaUploadSession",
    "createReleaseRollout",
    "transitionReleaseRollout",
    "upsertRolloutAssignment",
    "claimDevice",
    "revokeDevice",
    "rotateDeviceSecret",
    "resetDeviceForTransfer",
    "stageDeviceSecret",
    "acknowledgeDeviceSecret",
    "revokeConnectorByCredential",
  ]) {
    const mutate = store[method];
    store[method] = async (input) => {
      const result = mutate(input);
      await pending;
      return result;
    };
  }

  store.flush = () => pending;
  return store;
}

async function readState(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function writeState(filePath, state) {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmpPath, filePath);
}
