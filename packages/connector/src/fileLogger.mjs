import { appendFile, chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";
import { redact } from "./redact.mjs";

export function createBoundedFileLogger(path, { maxBytes = 1024 * 1024, secrets = [] } = {}) {
  let queue = Promise.resolve();
  const write = (level, values) => {
    queue = queue.then(async () => {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const rawLine = `${new Date().toISOString()} ${level} ${sanitize(values, secrets)}\n`;
      const bytes = Buffer.from(rawLine, "utf8");
      const line = bytes.byteLength <= 16 * 1024 ? rawLine : `${bytes.subarray(0, 16 * 1024 - 32).toString("utf8")} [TRUNCATED]\n`;
      let size = 0;
      try { size = (await stat(path)).size; } catch (error) { if (error?.code !== "ENOENT") throw error; }
      if (size + Buffer.byteLength(line) > maxBytes) {
        await rm(`${path}.1`, { force: true });
        try { await rename(path, `${path}.1`); } catch (error) { if (error?.code !== "ENOENT") throw error; }
      }
      await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
      await chmod(path, 0o600);
    }).catch(() => {});
  };
  return {
    log: (...values) => write("INFO", values),
    error: (...values) => write("ERROR", values),
    async flush() { await queue; },
  };
}

function sanitize(values, secrets) {
  let output = values.map((value) => typeof value === "string" ? value : JSON.stringify(redact(value))).join(" ");
  for (const secret of secrets) if (secret) output = output.split(secret).join("[REDACTED]");
  return String(redact(output));
}
