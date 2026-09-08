import { deleteStagedMedia, deleteStoredMediaRecord } from "./mediaStore.mjs";

const DEFAULT_LIMIT = 100;

// Retention is user-scoped because the Store deliberately exposes no cross-tenant media scan.
// A cloud Cron/Workflow supplies the user id from its durable fan-out; local owner routes call the
// same function. Object deletion is idempotent and the metadata mutation re-checks ownership.
export function createMediaRetentionRunner({ store, config = null, limit = DEFAULT_LIMIT, now = () => Date.now() } = {}) {
  if (!store) throw new Error("A Store is required for media retention.");

  async function runOnce({ userId, checkedAt = new Date(now()).toISOString() } = {}) {
    if (typeof userId !== "string" || !userId) throw terminalError("media_retention_user_required");
    const expired = await store.listExpiredMediaUploads({ userId, now: checkedAt });
    const purged = [];
    for (const media of (expired ?? []).slice(0, normalizeLimit(limit))) {
      await deleteStoredMediaRecord({ store, userId, media, config });
      const deleted = await store.deleteMediaUpload({ userId, mediaId: media.id, reason: "retention_expired" });
      if (deleted) purged.push(deleted);
    }
    const abandoned = [];
    const uploadSessions = await store.listExpiredMediaUploadSessions?.({ userId, now: checkedAt }) ?? [];
    for (const session of uploadSessions.slice(0, normalizeLimit(limit))) {
      await deleteStagedMedia(session, config);
      const expiredSession = await store.abortMediaUploadSession({
        userId,
        sessionId: session.id,
        status: "expired",
        at: checkedAt,
      });
      if (expiredSession) abandoned.push(expiredSession);
    }
    return {
      purged,
      count: purged.length,
      abandoned,
      abandonedCount: abandoned.length,
      hasMore: (expired?.length ?? 0) > normalizeLimit(limit)
        || uploadSessions.length > normalizeLimit(limit),
      checkedAt,
    };
  }

  return { runOnce };
}

function normalizeLimit(value) {
  return Number.isSafeInteger(value) ? Math.max(1, Math.min(500, value)) : DEFAULT_LIMIT;
}

function terminalError(code) {
  return Object.assign(new Error(code), { code, retryable: false });
}
