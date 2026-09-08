import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_SCANNED_FILE_BYTES = 1024 * 1024;

const forbiddenPathRules = [
  {
    id: "live-controller-config",
    matches: (path) => /^firmware\/[^/]+\/include\/controller_config[^/]*$/u.test(path)
      && !path.endsWith("/controller_config.example.h"),
  },
  { id: "environment-file", matches: (path) => /(^|\/)\.env(?:\..+)?$/u.test(path) && !path.endsWith(".example") },
  { id: "runtime-data", matches: (path) => /(^|\/)\.data\//u.test(path) },
  { id: "private-key-file", matches: (path) => /\.(?:key|p12|pfx)$/iu.test(path) },
];

const secretContentRules = [
  { id: "private-key-material", pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/u },
  { id: "stripe-live-key", pattern: /\bsk_live_[A-Za-z0-9]{16,}\b/u },
  { id: "github-token", pattern: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/u },
  { id: "slack-bot-token", pattern: /\bxoxb-[A-Za-z0-9-]{20,}\b/u },
  { id: "aws-access-key", pattern: /\bAKIA[A-Z0-9]{16}\b/u },
];

export function scanTrackedPaths(paths) {
  const findings = [];
  for (const path of paths) {
    for (const rule of forbiddenPathRules) {
      if (rule.matches(path)) findings.push({ path, rule: rule.id });
    }
  }
  return findings;
}

export function scanText(path, text) {
  return secretContentRules
    .filter((rule) => rule.pattern.test(text))
    .map((rule) => ({ path, rule: rule.id }));
}

async function listTrackedPaths() {
  const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
    cwd: process.cwd(),
    encoding: "buffer",
    maxBuffer: 16 * 1024 * 1024,
    timeout: 15_000,
  });
  return stdout.toString("utf8").split("\0").filter(Boolean);
}

async function main() {
  let paths;
  try {
    paths = await listTrackedPaths();
  } catch {
    console.error("Repository secret scan could not enumerate tracked files; failing closed.");
    process.exitCode = 2;
    return;
  }

  const findings = scanTrackedPaths(paths);
  for (const path of paths) {
    let bytes;
    try {
      bytes = await readFile(path);
    } catch {
      continue;
    }
    if (bytes.length > MAX_SCANNED_FILE_BYTES || bytes.includes(0)) continue;
    findings.push(...scanText(path, bytes.toString("utf8")));
  }

  const unique = [...new Map(findings.map((finding) => [`${finding.path}:${finding.rule}`, finding])).values()];
  if (unique.length === 0) {
    console.log(`Repository secret scan passed (${paths.length} tracked files).`);
    return;
  }
  console.error(`Repository secret scan found ${unique.length} blocked tracked path or high-confidence signature(s):`);
  for (const finding of unique) console.error(`- ${finding.path} [${finding.rule}]`);
  console.error("Matched values are intentionally never printed. Remove the file from tracking and rotate exposed credentials outside the repository.");
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
