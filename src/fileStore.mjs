import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { createStore } from "./store.mjs";

export async function createFileStore(filePath, options = {}) {
  const seed = await readState(filePath);
  const store = createStore(seed, options);
  let pending = Promise.resolve();

  store.subscribe((state) => {
    pending = pending.then(() => writeState(filePath, state));
  });

  store.flush = () => pending;
  return store;
}

async function readState(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function writeState(filePath, state) {
  await mkdir(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await rename(tmpPath, filePath);
}
