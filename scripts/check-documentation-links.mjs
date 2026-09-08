import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
export const DEFAULT_REPOSITORY_ROOT = resolve(dirname(scriptPath), "..");

const primaryFiles = [
  "README.md",
  "AGENTS.md",
  "CLAUDE.md",
  "packages/connector/README.md",
  "cloudflare/README.md",
  "cloudflare-control-plane/README.md",
];
const primaryDirectories = ["docs", "roadmap"];
const boardDocumentationNames = ["README.md", "include/README.md", "docs/README.md"];

function repositoryPath(root, path) {
  return relative(root, path).split(sep).join("/");
}

function isInside(root, path) {
  const offset = relative(root, path);
  return offset === "" || (!offset.startsWith(`..${sep}`) && offset !== ".." && !offset.startsWith(sep));
}

async function existingFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function collectMarkdownDirectory(root, directory) {
  const paths = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) paths.push(...await collectMarkdownDirectory(root, path));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) paths.push(repositoryPath(root, path));
  }
  return paths;
}

export async function collectDocumentationFiles(root = DEFAULT_REPOSITORY_ROOT) {
  const documents = [];
  for (const path of primaryFiles) {
    if (await existingFile(resolve(root, path))) documents.push(path);
  }
  for (const directory of primaryDirectories) {
    documents.push(...await collectMarkdownDirectory(root, resolve(root, directory)));
  }

  const firmwareRoot = resolve(root, "firmware");
  for (const board of await readdir(firmwareRoot, { withFileTypes: true })) {
    if (!board.isDirectory() || board.name.startsWith(".")) continue;
    for (const name of boardDocumentationNames) {
      const path = resolve(firmwareRoot, board.name, name);
      if (await existingFile(path)) documents.push(repositoryPath(root, path));
    }
  }
  return [...new Set(documents)].sort();
}

function withoutCode(markdown) {
  const lines = markdown.split("\n");
  let fence = null;
  const visible = lines.map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    if (marker && fence === null) {
      fence = { character: marker[0], length: marker.length };
      return "";
    }
    if (fence !== null) {
      if (marker?.[0] === fence.character && marker.length >= fence.length) fence = null;
      return "";
    }
    return line.replace(/(`+)(?:[^`]|`(?!\1))*?\1/gu, "");
  }).join("\n");
  return visible.replace(/<!--[\s\S]*?-->/gu, (comment) => comment.replace(/[^\n]/gu, ""));
}

function lineAt(text, offset) {
  let line = 1;
  for (let index = 0; index < offset; index += 1) {
    if (text.charCodeAt(index) === 10) line += 1;
  }
  return line;
}

export function extractDocumentationTargets(markdown) {
  const visible = withoutCode(markdown);
  const targets = [];
  const patterns = [
    /!?\[[^\]]*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^)]*["'])?\s*\)/gu,
    /^[ \t]*\[[^\]]+\]:[ \t]*(?:<([^>]+)>|(\S+))/gmu,
  ];
  for (const pattern of patterns) {
    for (const match of visible.matchAll(pattern)) {
      targets.push({ target: match[1] ?? match[2], line: lineAt(visible, match.index) });
    }
  }
  return targets;
}

function localPathFromTarget(target) {
  if (!target || target.startsWith("#") || target.startsWith("/") || target.startsWith("//")) return null;
  if (/^[a-z][a-z0-9+.-]*:/iu.test(target)) return null;
  const path = target.split(/[?#]/u, 1)[0];
  if (!path) return null;
  try {
    return { path: decodeURIComponent(path).replace(/\\([ ()])/gu, "$1") };
  } catch {
    return { error: "invalid-url-encoding" };
  }
}

export async function validateDocumentationLinks({ root = DEFAULT_REPOSITORY_ROOT, documents } = {}) {
  const selected = documents ?? await collectDocumentationFiles(root);
  const findings = [];
  let links = 0;
  for (const document of selected) {
    const documentPath = resolve(root, document);
    const markdown = await readFile(documentPath, "utf8");
    for (const entry of extractDocumentationTargets(markdown)) {
      const local = localPathFromTarget(entry.target);
      if (local === null) continue;
      links += 1;
      if (local.error) {
        findings.push({ document, line: entry.line, target: entry.target, reason: local.error });
        continue;
      }
      const destination = resolve(dirname(documentPath), local.path);
      if (!isInside(root, destination)) {
        findings.push({ document, line: entry.line, target: entry.target, reason: "outside-repository" });
      } else {
        try {
          await stat(destination);
        } catch {
          findings.push({ document, line: entry.line, target: entry.target, reason: "missing-target" });
        }
      }
    }
  }
  return { documents: selected.length, links, findings };
}

async function main() {
  const result = await validateDocumentationLinks();
  if (result.findings.length === 0) {
    console.log(`Documentation link check passed (${result.documents} documents, ${result.links} local links).`);
    return;
  }
  console.error(`Documentation link check found ${result.findings.length} invalid local link(s):`);
  for (const finding of result.findings) {
    console.error(`- ${finding.document}:${finding.line} -> ${finding.target} [${finding.reason}]`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
