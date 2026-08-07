import { connect as netConnect } from "node:net";
import { connect as tlsConnect } from "node:tls";

// Minimal RESP (Redis serialization protocol) client. src/ carries no runtime dependencies, and
// the rate limiter needs only INCR/PEXPIRE, so speaking the wire protocol directly is cheaper than
// taking on a Redis package.
export function createRespClient({ url, connectTimeoutMs = 5000 } = {}) {
  const target = parseRedisUrl(url);
  let socketPromise = null;

  function openSocket() {
    return new Promise((resolve, reject) => {
      const options = { host: target.host, port: target.port };
      const socket = target.tls
        ? tlsConnect({ ...options, servername: target.host })
        : netConnect(options);

      const timer = setTimeout(() => {
        socket.destroy(new Error(`Redis connect timed out after ${connectTimeoutMs}ms.`));
      }, connectTimeoutMs);

      socket.setNoDelay(true);
      socket.once(target.tls ? "secureConnect" : "connect", () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      socket.once("close", () => {
        // Force the next command to dial again rather than reuse a dead socket.
        if (socketPromise) socketPromise = null;
      });
    });
  }

  async function socket() {
    if (!socketPromise) {
      socketPromise = openSocket().catch((error) => {
        socketPromise = null;
        throw error;
      });
    }
    return socketPromise;
  }

  async function pipeline(commands) {
    const connection = await socket();
    const payload = commands.map(encodeCommand).join("");
    const replies = await sendAndRead(connection, payload, commands.length);
    return replies;
  }

  async function command(...args) {
    const [reply] = await pipeline([args]);
    return reply;
  }

  function close() {
    if (!socketPromise) return;
    const pending = socketPromise;
    socketPromise = null;
    void pending.then((connection) => connection.destroy()).catch(() => {});
  }

  return { pipeline, command, close };
}

function sendAndRead(connection, payload, expectedReplies) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);

    const cleanup = () => {
      connection.off("data", onData);
      connection.off("error", onError);
    };

    const onError = (error) => {
      cleanup();
      reject(error);
    };

    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const replies = [];
      let offset = 0;
      while (replies.length < expectedReplies) {
        const parsed = parseReply(buffer, offset);
        if (!parsed) return; // wait for more bytes
        replies.push(parsed.value);
        offset = parsed.offset;
      }
      cleanup();
      const failure = replies.find((reply) => reply instanceof Error);
      if (failure) reject(failure);
      else resolve(replies);
    };

    connection.on("data", onData);
    connection.on("error", onError);
    connection.write(payload, (error) => {
      if (error) onError(error);
    });
  });
}

function encodeCommand(args) {
  let out = `*${args.length}\r\n`;
  for (const arg of args) {
    const value = String(arg);
    out += `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
  }
  return out;
}

// Returns { value, offset } or null when the buffer does not yet hold a whole reply.
export function parseReply(buffer, offset) {
  if (offset >= buffer.length) return null;
  const type = String.fromCharCode(buffer[offset]);
  const lineEnd = buffer.indexOf("\r\n", offset);
  if (lineEnd === -1) return null;
  const line = buffer.toString("utf8", offset + 1, lineEnd);
  const next = lineEnd + 2;

  switch (type) {
    case "+":
      return { value: line, offset: next };
    case "-":
      return { value: new Error(line), offset: next };
    case ":":
      return { value: Number(line), offset: next };
    case "$": {
      const length = Number(line);
      if (length === -1) return { value: null, offset: next };
      const end = next + length;
      if (buffer.length < end + 2) return null;
      return { value: buffer.toString("utf8", next, end), offset: end + 2 };
    }
    case "*": {
      const count = Number(line);
      if (count === -1) return { value: null, offset: next };
      const items = [];
      let cursor = next;
      for (let index = 0; index < count; index += 1) {
        const parsed = parseReply(buffer, cursor);
        if (!parsed) return null;
        items.push(parsed.value);
        cursor = parsed.offset;
      }
      return { value: items, offset: cursor };
    }
    default:
      return { value: new Error(`Unsupported RESP reply type: ${type}`), offset: next };
  }
}

export function parseRedisUrl(url) {
  if (!url) throw new Error("A Redis URL is required.");
  const parsed = new URL(url);
  const tls = parsed.protocol === "rediss:";
  return {
    host: parsed.hostname || "127.0.0.1",
    port: Number.parseInt(parsed.port || "6379", 10),
    tls,
  };
}
