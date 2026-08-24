import { commandSummary, formatRelativeTime, formatUptime, renderEventResult } from "./format";

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
});
