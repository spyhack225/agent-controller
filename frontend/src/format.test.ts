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

  test("renders result reasons before falling back to JSON", () => {
    expect(renderEventResult({ reason: "Policy denied" })).toBe("Policy denied");
  });

  test("handles missing relative timestamps", () => {
    expect(formatRelativeTime(null)).toBe("never");
  });
});
