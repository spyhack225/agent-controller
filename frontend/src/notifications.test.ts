import {
  planApprovalNotifications,
  readApprovalNotificationPreference,
  writeApprovalNotificationPreference,
  type NotificationSupportState,
} from "./notifications";
import type { Command } from "./types";

function approval(id: string, command: string): Command {
  return {
    id,
    status: "approval_required",
    risk: "high",
    intent: { type: "shell_input", command },
    createdAt: "2026-08-07T09:00:00.000Z",
  };
}

function plan(options: {
  pending: Command[];
  seen?: string[];
  enabled?: boolean;
  permission?: NotificationSupportState;
  hidden?: boolean;
}) {
  return planApprovalNotifications({
    pending: options.pending,
    seen: options.seen ?? [],
    enabled: options.enabled ?? true,
    permission: options.permission ?? "granted",
    hidden: options.hidden ?? true,
  });
}

describe("approval notification planning", () => {
  test("announces a newly pending approval while the console is backgrounded", () => {
    const result = plan({ pending: [approval("cmd_1", "rm -rf build")] });

    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0].title).toContain("shell input");
    expect(result.notifications[0].body).toBe("rm -rf build");
    expect(result.notifications[0].url).toBe("/#activity");
    expect(result.seen).toEqual(["cmd_1"]);
  });

  test("stays silent while the tab is in the foreground but still records what was shown", () => {
    const result = plan({ pending: [approval("cmd_1", "npm test")], hidden: false });

    expect(result.notifications).toEqual([]);
    // Recording the id here is what stops a later background switch from replaying
    // approvals the operator has already looked at.
    expect(result.seen).toEqual(["cmd_1"]);
  });

  test("does not repeat an approval that was already announced", () => {
    const pending = [approval("cmd_1", "npm test")];

    expect(plan({ pending, seen: ["cmd_1"] }).notifications).toEqual([]);
  });

  test("collapses a burst of approvals into one summary", () => {
    const result = plan({
      pending: [
        approval("cmd_1", "npm test"),
        approval("cmd_2", "git push"),
        approval("cmd_3", "terraform apply"),
      ],
    });

    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0].title).toBe("3 commands need approval");
    expect(result.seen).toEqual(["cmd_1", "cmd_2", "cmd_3"]);
  });

  test("forgets approvals that are no longer pending so the list cannot grow forever", () => {
    const result = plan({ pending: [approval("cmd_2", "npm test")], seen: ["cmd_1", "cmd_2"] });

    expect(result.seen).toEqual(["cmd_2"]);
  });

  test("never notifies without both an opt-in and a granted permission", () => {
    const pending = [approval("cmd_1", "npm test")];

    expect(plan({ pending, enabled: false }).notifications).toEqual([]);
    expect(plan({ pending, permission: "default" }).notifications).toEqual([]);
    expect(plan({ pending, permission: "denied" }).notifications).toEqual([]);
    expect(plan({ pending, permission: "unsupported" }).notifications).toEqual([]);
  });
});

describe("approval notification preference", () => {
  test("round-trips through localStorage and defaults to off", () => {
    localStorage.clear();
    expect(readApprovalNotificationPreference()).toBe(false);

    writeApprovalNotificationPreference(true);
    expect(readApprovalNotificationPreference()).toBe(true);

    writeApprovalNotificationPreference(false);
    expect(readApprovalNotificationPreference()).toBe(false);
  });
});
