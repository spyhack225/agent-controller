import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { uploadBinary } from "./api";

type Listener = (event: Event) => void;

class FakeEventTarget {
  private listeners = new Map<string, Set<Listener>>();

  addEventListener(name: string, listener: EventListenerOrEventListenerObject | null) {
    if (typeof listener !== "function") return;
    const listeners = this.listeners.get(name) ?? new Set<Listener>();
    listeners.add(listener as Listener);
    this.listeners.set(name, listeners);
  }

  removeEventListener(name: string, listener: EventListenerOrEventListenerObject | null) {
    if (typeof listener === "function") this.listeners.get(name)?.delete(listener as Listener);
  }

  emit(name: string, event: Event = new Event(name)) {
    for (const listener of [...(this.listeners.get(name) ?? [])]) listener(event);
  }
}

class FakeXMLHttpRequest extends FakeEventTarget {
  static instances: FakeXMLHttpRequest[] = [];

  readonly upload = new FakeEventTarget();
  status = 0;
  response: unknown = null;
  responseText = "";
  responseType: XMLHttpRequestResponseType = "";
  method = "";
  url = "";
  sent: Blob | null = null;
  abortCalls = 0;
  headers = new Map<string, string>();

  constructor() {
    super();
    FakeXMLHttpRequest.instances.push(this);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(name: string, value: string) {
    this.headers.set(name.toLowerCase(), value);
  }

  send(body: Blob) {
    this.sent = body;
  }

  abort() {
    this.abortCalls += 1;
    this.emit("abort");
    this.emit("loadend");
  }
}

const originalXhr = Object.getOwnPropertyDescriptor(globalThis, "XMLHttpRequest");

beforeEach(() => {
  FakeXMLHttpRequest.instances = [];
  Object.defineProperty(globalThis, "XMLHttpRequest", {
    configurable: true,
    writable: true,
    value: FakeXMLHttpRequest,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalXhr) Object.defineProperty(globalThis, "XMLHttpRequest", originalXhr);
  else Reflect.deleteProperty(globalThis, "XMLHttpRequest");
});

describe("uploadBinary lifecycle", () => {
  test("reports bounded byte progress and removes the abort listener when load settles", async () => {
    const body = new Blob(["payload"], { type: "image/png" });
    const abort = new AbortController();
    const removeListener = vi.spyOn(abort.signal, "removeEventListener");
    const onProgress = vi.fn();
    const pending = uploadBinary<{ stored: boolean }>("/v1/media/content", body, {
      token: "token",
      contentType: body.type,
      signal: abort.signal,
      onProgress,
    });
    const request = FakeXMLHttpRequest.instances[0];
    request.upload.emit("progress", new ProgressEvent("progress", {
      loaded: 4,
      total: body.size,
      lengthComputable: true,
    }));
    request.status = 201;
    request.response = { stored: true };
    request.emit("load");
    request.emit("loadend");

    await expect(pending).resolves.toEqual({ stored: true });
    expect(onProgress).toHaveBeenCalledExactlyOnceWith(4, body.size);
    expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(request.method).toBe("PUT");
    expect(request.sent).toBe(body);
  });

  test("an active abort rejects once and ignores late progress or load events", async () => {
    const abort = new AbortController();
    const onProgress = vi.fn();
    const pending = uploadBinary("/v1/media/content", new Blob(["payload"]), {
      token: "token",
      contentType: "image/png",
      signal: abort.signal,
      onProgress,
    });
    const request = FakeXMLHttpRequest.instances[0];
    abort.abort();
    request.upload.emit("progress", new ProgressEvent("progress", { loaded: 7, total: 7 }));
    request.status = 204;
    request.emit("load");

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(request.abortCalls).toBe(1);
    expect(onProgress).not.toHaveBeenCalled();
  });

  test("an already-aborted signal never constructs or sends an XHR", async () => {
    const abort = new AbortController();
    abort.abort();

    await expect(uploadBinary("/v1/media/content", new Blob(["payload"]), {
      token: "token",
      contentType: "image/png",
      signal: abort.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(FakeXMLHttpRequest.instances).toHaveLength(0);
  });
});
