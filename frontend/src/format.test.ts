import {
  commandSummary,
  formatMediaExpiry,
  formatRelativeTime,
  formatUptime,
  renderEventResult,
} from "./format";

describe("format helpers", () => {
  test("summarizes commands from their operational payload", () => {
    expect(commandSummary({
      id: "cmd_1",
      status: "queued",
      intent: { type: "shell_input", command: "npm test" },
    })).toBe("npm test");
  });

  test("formats uptime without losing the remaining minutes", () => {
    expect(formatUptime(7_500_000)).toBe("2h 5m");
  });

  test("renders result reasons without falling back to JSON", () => {
    expect(renderEventResult({ reason: "Policy denied" })).toBe("Policy denied");
    expect(renderEventResult({ response: "The branch is ready." })).toBe("The branch is ready.");
    expect(renderEventResult({ createThread: { sequence: 2 }, startTurn: { sequence: 4 } }))
      .toBe("Sent to T3 Code");
    expect(renderEventResult({ accepted: true })).toBe("Result received");
  });

  test("handles missing relative timestamps", () => {
    expect(formatRelativeTime(null)).toBe("never");
  });

  test("reads a past timestamp as an age", () => {
    const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
    expect(formatRelativeTime(twoMinutesAgo)).toBe("2m ago");
  });

  // The bug this covers: the old clamp turned every future instant into "0s ago", so a clip
  // uploaded seconds earlier under a 30-day retention claimed to have already expired.
  test("reads a future timestamp as a deadline rather than clamping it to zero", () => {
    const inThirtyDays = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000 + 60_000).toISOString();
    expect(formatRelativeTime(inThirtyDays)).toBe("in 30d");
    expect(formatRelativeTime(new Date(Date.now() + 90 * 1000).toISOString())).toBe("in 1m");
  });

  test("describes media retention in the tense that matches the fact", () => {
    // What the gateway writes for a clip uploaded now under the default 30-day retention.
    const justUploaded = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000 + 60_000).toISOString();
    expect(formatMediaExpiry(justUploaded)).toBe("Expires in 30d");
    expect(formatMediaExpiry(new Date(Date.now() - 2 * 24 * 60 * 60 * 1000 - 60_000).toISOString()))
      .toBe("Expired 2d ago");
    expect(formatMediaExpiry(null)).toBe("Expires only when manually deleted");
  });
});
