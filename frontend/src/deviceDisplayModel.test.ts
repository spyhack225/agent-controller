import { describe, expect, test } from "vitest";

import {
  buildControllerActionsDisplay,
  buildControllerResponseDisplay,
  buildControllerRootDisplay,
  buildControllerThreadsDisplay,
} from "./deviceDisplayModel";

describe("CrowPanel Actions display model", () => {
  test("keeps the root menu free of reusable actions", () => {
    const display = buildControllerRootDisplay({ threadCount: 4, selectedIndex: 1 });

    expect(display.totalCount).toBe(3);
    expect(display.title).toBe("AC//MENU 2/3");
    expect(display.allRows.map((row) => row.label)).toEqual(["Threads", "Gateway", "Firmware"]);
  });

  test("shows assigned reusable actions only inside an opened thread", () => {
    const display = buildControllerActionsDisplay({
      controls: {
        revision: 2,
        items: [
          { id: "status", kind: "status", label: "Status", enabled: true },
          { id: "continue", kind: "remote_action", label: "Continue task", enabled: true, requiresThread: true, requiresConfirmation: true },
          { id: "tests", kind: "remote_action", label: "Run tests", enabled: true, requiresThread: true, requiresConfirmation: true },
          { id: "continue_test", kind: "remote_action", label: "Continue + test", enabled: true, requiresThread: true, requiresConfirmation: true },
          { id: "inspect", kind: "capture_image", label: "Inspect image", enabled: false, reason: "No camera" },
          { id: "stop", kind: "stop", label: "Stop run", enabled: true, requiresThread: true, requiresConfirmation: true },
        ],
      },
      threadId: "thread_1",
      selectedIndex: 3,
    });

    expect(display.totalCount).toBe(7);
    expect(display.assignedCount).toBe(6);
    expect(display.pageCount).toBe(3);
    expect(display.title).toBe("T//ACTIONS 4/7");
    expect(display.allRows.map((row) => row.label)).toEqual([
      "Latest response", "Status", "Continue task", "Run tests", "Continue + test", "Inspect image", "Stop run",
    ]);
    expect(display.rows.map((row) => [row.label, row.meta])).toEqual([
      ["Run tests", "CONFIRM"], ["Continue + test", "CONFIRM"], ["Inspect image", "LOCK"],
    ]);
  });

  test("uses the same fail-closed thread and availability markers as firmware", () => {
    const display = buildControllerActionsDisplay({
      controls: {
        revision: 1,
        items: [
          { kind: "status", label: "Status", enabled: true },
          { kind: "remote_action", label: "Continue task", enabled: true, requiresThread: true, requiresConfirmation: true },
          { kind: "capture_image", label: "Inspect image", enabled: false },
          { kind: "stop", label: "Stop run", enabled: true, requiresThread: true, requiresConfirmation: true },
        ],
      },
    });

    expect(display.allRows.find((row) => row.label === "Status")?.meta).toBe("VIEW");
    expect(display.allRows.find((row) => row.label === "Continue task")).toMatchObject({ meta: "THREAD", disabled: true });
    expect(display.allRows.find((row) => row.label === "Inspect image")).toMatchObject({ meta: "LOCK", disabled: true });
    expect(display.allRows.find((row) => row.label === "Stop run")).toMatchObject({ meta: "THREAD", disabled: true });
  });

  test("shows a release only in the root Firmware row", () => {
    const display = buildControllerRootDisplay({
      firmware: { channel: "stable", updateMode: "notify", currentVersion: "0.2.5", latestVersion: "0.2.6" },
      selectedIndex: 99,
    });

    expect(display.selectedIndex).toBe(2);
    expect(display.allRows[2]).toMatchObject({ label: "Update 0.2.6", meta: "READY", selected: true });
  });

  test("represents a selectable thread list before opening its actions", () => {
    const display = buildControllerThreadsDisplay([
      { id: "thread_1", label: "Firmware navigation", status: "idle", active: true },
      { id: "thread_2", label: "Dashboard polish", status: "running" },
    ], 1);

    expect(display.title).toBe("AC//THREADS 2/2");
    expect(display.state).toBe("SELECT");
    expect(display.allRows).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "Firmware navigation", meta: "ACTIVE" }),
      expect.objectContaining({ label: "Dashboard polish", meta: "RUNNING", selected: true }),
    ]));
  });

  test("pages the latest agent response and validates suggested assigned actions", () => {
    const display = buildControllerResponseDisplay({
      id: "thread_1",
      label: "Firmware navigation",
      messages: [{
        id: "message_1",
        role: "assistant",
        text: "The firmware response reader is implemented and ready for verification. <!--AC_FOLLOWUPS:[\"tests\",\"invented\"]-->",
      }],
    }, {
      revision: 1,
      items: [{ actionId: "tests", kind: "remote_action", label: "Run tests", enabled: true, requiresConfirmation: true }],
    });

    expect(display.title).toMatch(/^AGENT\/\/RESPONSE 1\//u);
    expect(display.lines).toHaveLength(3);
    expect(display.lines.every((line) => line.length <= 31)).toBe(true);
    expect(display.suggestions.map((row) => row.label)).toEqual(["Run tests"]);
    expect(display.allLines.join(" ")).not.toContain("AC_FOLLOWUPS");
  });
});
