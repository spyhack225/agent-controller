// Node.js 22 (the connector's minimum supported runtime, and the CI runner) has no global
// `CloseEvent`; it arrived in Node.js 23. The fake sockets in these tests dispatch one, so give
// older runtimes the same minimal shape the WHATWG event carries. Real runtimes keep their own.
if (typeof globalThis.CloseEvent !== "function") {
  globalThis.CloseEvent = class CloseEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.code = init.code ?? 0;
      this.reason = init.reason ?? "";
      this.wasClean = init.wasClean ?? false;
    }
  };
}
