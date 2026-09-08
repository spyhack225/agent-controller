import { beforeEach, describe, expect, test } from "vitest";

import { clearCompanionCode, readCompanionCode } from "./companionLink";

beforeEach(() => {
  sessionStorage.clear();
  window.history.replaceState(null, "", "/#/media");
});

describe("companion handoff links", () => {
  test("reads the fragment bearer and removes it from the visible URL", () => {
    const code = "abcdefghijklmnopqrstuvwxyzABCDEF";
    window.history.replaceState(null, "", `/#/media?handoff=${code}`);
    expect(readCompanionCode()).toBe(code);
    expect(window.location.hash).toBe("#/media");
  });

  test("survives an authentication redirect only in session storage", () => {
    const code = "0123456789abcdefghijklmnopqrstuv";
    window.history.replaceState(null, "", `/#/media?handoff=${code}`);
    readCompanionCode();
    window.history.replaceState(null, "", "/#/media");
    expect(readCompanionCode()).toBe(code);
    clearCompanionCode();
    expect(readCompanionCode()).toBeNull();
  });

  test("ignores malformed and unrelated fragments", () => {
    window.history.replaceState(null, "", "/#/operate?handoff=abcdefghijklmnopqrstuvwxyzABCDEF");
    expect(readCompanionCode()).toBeNull();
    window.history.replaceState(null, "", "/#/media?handoff=short");
    expect(readCompanionCode()).toBeNull();
  });
});
