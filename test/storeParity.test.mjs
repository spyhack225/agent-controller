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
