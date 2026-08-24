import { ApiError } from "./api";
import {
  T3_SNAPSHOT_UNAVAILABLE_MESSAGE,
  dedupeEnvironments,
  isT3SnapshotUnavailableError,
  normalizeThread,
} from "./controller";

test("identifies only the T3 snapshot failure that needs recovery guidance", () => {
  expect(isT3SnapshotUnavailableError(
    new ApiError(502, T3_SNAPSHOT_UNAVAILABLE_MESSAGE),
  )).toBe(true);
  expect(isT3SnapshotUnavailableError(new ApiError(502, "T3 dispatch failed."))).toBe(false);
  expect(isT3SnapshotUnavailableError(new Error("Request failed with HTTP 500."))).toBe(false);
});

test("deduplicates repeated pairings while preserving the original environment identity", () => {
  const environments = dedupeEnvironments([
    {
      id: "env_duplicate",
      label: "Macbook Air T3 Code",
      baseUrl: "http://127.0.0.1:3773/",
      status: "paired",
      createdAt: "2026-08-08T17:39:00.000Z",
    },
    {
      id: "env_original",
      label: "Macbook Air T3 Code",
      baseUrl: "http://127.0.0.1:3773",
      status: "reachable",
      createdAt: "2026-07-24T12:00:00.000Z",
    },
  ]);

  expect(environments).toHaveLength(1);
  expect(environments[0]?.id).toBe("env_original");
});

test("normalizes the messages that belong to a T3 thread", () => {
  const thread = normalizeThread({
    id: "thread_1",
    title: "Review branch",
    projectId: "project_1",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    messages: [
      { id: "message_1", role: "user", text: "Review this branch", createdAt: "2026-08-08T19:00:00.000Z" },
      { id: "message_2", role: "assistant", content: [{ type: "text", text: "The branch is ready." }] },
    ],
  }, [{ id: "project_1", title: "Tacs" }]);

  expect(thread?.label).toBe("Review branch — Tacs");
  expect(thread?.modelSelection).toEqual({ instanceId: "codex", model: "gpt-5.4" });
  expect(thread?.messages).toEqual([
    expect.objectContaining({ id: "message_1", role: "user", text: "Review this branch" }),
    expect.objectContaining({ id: "message_2", role: "assistant", text: "The branch is ready." }),
  ]);
});
