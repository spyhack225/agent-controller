import { describe, expect, it } from "vitest";

import {
  commandActivity,
  connectionActivity,
  mediaJobActivity,
  recordingActivity,
  refreshActivity,
  streamingActivity,
  workspaceSyncActivity,
} from "./activity";

describe("commandActivity", () => {
  it("keeps a dispatched command animated, because T3 accepting it is not the agent replying", () => {
    expect(commandActivity("dispatched")).toEqual({ state: "working", label: "Agent is working" });
  });

  it("separates shell work from prompt work, the way every other surface already does", () => {
    expect(commandActivity("running", "shell_input")?.state).toBe("solving");
    expect(commandActivity("running", "agent_prompt")?.state).toBe("working");
  });

  it("holds the frame while a command waits on the owner instead of looking busy", () => {
    const activity = commandActivity("approval_required");
    expect(activity?.paused).toBe(true);
    expect(activity?.label).toBe("Waiting for your decision");
  });

  it("animates nothing once the command is finished", () => {
    for (const status of ["completed", "failed", "rejected", "expired", undefined]) {
      expect(commandActivity(status)).toBeNull();
    }
  });
});

describe("mediaJobActivity", () => {
  it("only calls it listening while audio is actually being read", () => {
    expect(mediaJobActivity("transcribing")?.state).toBe("listening");
  });

  it("uses the shape-preserving state for the stage that may not change letters", () => {
    expect(mediaJobActivity("normalizing")?.state).toBe("shaping");
  });

  it("pauses both stages that are blocked on a person, not on a worker", () => {
    expect(mediaJobActivity("review_required")?.paused).toBe(true);
    expect(mediaJobActivity("ready")?.paused).toBe(true);
  });

  it("stops at the terminal stages", () => {
    expect(mediaJobActivity("dispatched")).toBeNull();
    expect(mediaJobActivity("failed")).toBeNull();
  });
});

describe("connectionActivity", () => {
  it("animates the transitions and leaves an open stream still", () => {
    expect(connectionActivity("connecting")?.state).toBe("connecting");
    expect(connectionActivity("reconnecting")?.speed).toBeGreaterThan(1);
    expect(connectionActivity("live")).toBeNull();
    expect(connectionActivity("connected")).toBeNull();
    expect(connectionActivity("error")).toBeNull();
  });
});

describe("the remaining single-condition mappings", () => {
  it("resolves to null whenever the condition is false", () => {
    expect(workspaceSyncActivity("loaded")).toBeNull();
    expect(workspaceSyncActivity("failed")).toBeNull();
    expect(streamingActivity(false)).toBeNull();
    expect(refreshActivity(false)).toBeNull();
    expect(recordingActivity(false)).toBeNull();
  });

  it("names the work when the condition holds", () => {
    expect(workspaceSyncActivity("loading")?.state).toBe("searching");
    expect(streamingActivity(true)?.state).toBe("composing");
    expect(refreshActivity(true)?.state).toBe("weaving");
    expect(recordingActivity(true)?.state).toBe("listening");
  });
});
