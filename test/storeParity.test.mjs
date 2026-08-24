import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Guard tests for logic that has to exist twice.
//
// The storage layer has three implementations and the memory store is the reference, but Convex
// runs its own copy inside the deployment and cannot import the .mjs one — its tsconfig sets
// allowJs:false and only covers convex/. Every test in this suite drives createApp(), which uses
// the memory store, so a Convex-only divergence would ship unnoticed.
//
// These compare the two sources directly. Same idea as the await guard in rateLimit.test.mjs:
// cheaper than standing up a deployment, and it fails at the moment the copies drift rather than
// when a user hits the difference.

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Extracts a top-level `function name(...) { ... }` body by brace matching. */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name}() not found — did it get renamed?`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`${name}() has unbalanced braces.`);
}

/** Strips comments, TypeScript annotations, and formatting so only the logic is compared. */
function normalize(body) {
  return body
    .replaceAll(/\/\*[\s\S]*?\*\//gu, "")
    .replaceAll(/\/\/[^\n]*/gu, "")
    .replaceAll(/:\s*any\b/gu, "")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

test("deviceActions() agrees between the memory store and the Convex function", async () => {
  const [memory, convex] = await Promise.all([
    readFile(join(ROOT, "src", "store.mjs"), "utf8"),
    readFile(join(ROOT, "convex", "gatewayStore.ts"), "utf8"),
  ]);

  const memoryBody = normalize(extractFunction(memory, "deviceActions"));
  const convexBody = normalize(extractFunction(convex, "deviceActions"));

  assert.equal(
    convexBody,
    memoryBody,
    "deviceActions() has drifted between src/store.mjs and convex/gatewayStore.ts. A client that "
      + "trusts device.actions must get the same answer from either backend, so both copies have to "
      + "state the same rules.",
  );
});

test("every action deviceActions() reports is one a store method actually guards", async () => {
  const memory = await readFile(join(ROOT, "src", "store.mjs"), "utf8");
  const body = extractFunction(memory, "deviceActions");

  // The declaration is only worth trusting if each key corresponds to a real method. A key naming
  // a method that no longer exists would advertise a capability nothing enforces.
  const declared = [...body.matchAll(/^\s*(\w+):/gmu)].map((match) => match[1]);
  assert.ok(declared.length > 0, "deviceActions() declared no actions.");

  const methods = {
    rotateSecret: "rotateDeviceSecret",
    transferReset: "resetDeviceForTransfer",
    updateConfig: "updateDeviceConfig",
    updateProfile: "updateDeviceProfile",
    revoke: "revokeDevice",
    delete: "deleteDevice",
  };
  for (const action of declared) {
    const method = methods[action];
    assert.ok(method, `deviceActions() declares "${action}" with no known store method behind it.`);
    assert.match(
      memory,
      new RegExp(`function ${method}\\(`, "u"),
      `deviceActions() declares "${action}" but ${method}() is gone.`,
    );
  }
});

/** Brace-matches a body starting at `open`, which must index a `{`. */
function matchBraces(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error("Unbalanced braces.");
}

/** Like extractFunction, but tolerates a destructured parameter list. */
function extractFunctionWithParams(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name}() not found — did it get renamed?`);
  let depth = 0;
  for (let index = source.indexOf("(", start); index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) return matchBraces(source, source.indexOf("{", index));
    }
  }
  throw new Error(`${name}() has an unbalanced parameter list.`);
}

/** Extracts an `export const name = wrapper({ ... })` body by brace matching. */
function extractConvexHandler(source, name) {
  const start = source.indexOf(`export const ${name} = `);
  assert.notEqual(start, -1, `${name} not found in convex/gatewayStore.ts — did it get renamed?`);
  return matchBraces(source, source.indexOf("{", start));
}

test("deleteEnvironment repairs the same dependencies in both store implementations", async () => {
  const [memory, convex] = await Promise.all([
    readFile(join(ROOT, "src", "store.mjs"), "utf8"),
    readFile(join(ROOT, "convex", "gatewayStore.ts"), "utf8"),
  ]);

  const memoryBody = extractFunctionWithParams(memory, "deleteEnvironment");
  const convexBody = extractConvexHandler(convex, "deleteEnvironment");

  // The summary keys are the contract: an owner who removes an environment is told exactly what
  // was cleared, and a backend that repairs one fewer thing leaves an orphan behind.
  const summaryKeys = (body) => [...new Set([...body.matchAll(/removed\.(\w+)/gu)].map((match) => match[1]))].sort();
  assert.deepEqual(summaryKeys(memoryBody), ["actions", "devices", "macros", "onboarding"]);
  assert.deepEqual(
    summaryKeys(convexBody),
    summaryKeys(memoryBody),
    "deleteEnvironment() reports a different removal summary from src/store.mjs and "
      + "convex/gatewayStore.ts. Both backends must repair — and report — the same dependencies.",
  );

  for (const [label, body] of [["memory", memoryBody], ["convex", convexBody]]) {
    assert.match(body, /ENVIRONMENT_REMOVED_REASON/u, `${label} deleteEnvironment() no longer disables orphans.`);
    assert.match(body, /targetMode\s*[:=]\s*"device-current"/u, `${label} deleteEnvironment() leaves a fixed action without a target.`);
    assert.match(body, /firstThreadId: null/u, `${label} deleteEnvironment() no longer clears the onboarding selection.`);
  }
});
