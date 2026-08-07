import "@testing-library/jest-dom/vitest";

// Node 22+ exposes an experimental `globalThis.localStorage` that resolves to undefined
// unless the runtime was started with --localstorage-file, and it shadows the jsdom one.
// The console only ever uses storage for preferences, so an in-memory shim is enough.
if (typeof globalThis.localStorage === "undefined") {
  const entries = new Map<string, string>();
  const storage: Storage = {
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(String(key)) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => {
      entries.delete(String(key));
    },
    setItem: (key: string, value: string) => {
      entries.set(String(key), String(value));
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    writable: true,
    value: storage,
  });
}
