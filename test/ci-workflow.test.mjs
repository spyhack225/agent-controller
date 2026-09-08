import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";

const workflowUrl = new URL("../.github/workflows/ci.yml", import.meta.url);

async function readWorkflow() {
  return await readFile(workflowUrl, "utf8");
}

function jobBlocks(workflow) {
  const jobsOffset = workflow.indexOf("\njobs:\n");
  assert.notEqual(jobsOffset, -1, "workflow must define jobs");
  const source = workflow.slice(jobsOffset + 1);
  const matches = [...source.matchAll(/^  ([a-z0-9-]+):\n/gmu)];
  return new Map(matches.map((match, index) => {
    const end = matches[index + 1]?.index ?? source.length;
    return [match[1], source.slice(match.index, end)];
  }));
}

function assertJobCommands(jobs, jobName, commands) {
  const job = jobs.get(jobName);
  assert.ok(job, `missing ${jobName} job`);
  assert.match(job, /^    runs-on: ubuntu-24\.04$/mu, `${jobName} must use the pinned runner image`);
  assert.match(job, /^    timeout-minutes: [1-9][0-9]*$/mu, `${jobName} must have a timeout`);
  for (const command of commands) {
    assert.ok(job.includes(`run: ${command}`), `${jobName} is missing ${command}`);
  }
}

describe("hermetic GitHub CI workflow", () => {
  it("runs on unprivileged pull requests, pushes, and manual dispatch", async () => {
    const workflow = await readWorkflow();

    assert.match(workflow, /^on:\n  pull_request:\n  push:\n  workflow_dispatch:/mu);
    assert.doesNotMatch(workflow, /pull_request_target/u);
    assert.match(workflow, /^permissions:\n  contents: read$/mu);
    assert.doesNotMatch(workflow, /^\s+(?:actions|checks|deployments|id-token|packages|pull-requests|statuses):\s*write$/mu);
    assert.doesNotMatch(workflow, /\$\{\{\s*secrets\./u);
    assert.doesNotMatch(workflow, /^    environment:/mu, "untrusted CI jobs must not enter a protected deployment environment");
  });

  it("pins every action and does not persist the checkout credential", async () => {
    const workflow = await readWorkflow();
    const uses = [...workflow.matchAll(/^\s+uses:\s+([^\s#]+)/gmu)].map((match) => match[1]);
    const checkouts = [...workflow.matchAll(/uses:\s+actions\/checkout@[a-f0-9]{40}/gu)];
    const nonPersisted = [...workflow.matchAll(/^\s+persist-credentials:\s+false$/gmu)];

    assert.ok(uses.length > 0);
    for (const action of uses) assert.match(action, /^[^@\s]+@[a-f0-9]{40}$/u);
    assert.equal(nonPersisted.length, checkouts.length);
  });

  it("assigns each named hermetic boundary its required commands and timeout", async () => {
    const workflow = await readWorkflow();
    const jobs = jobBlocks(workflow);
    const requirements = new Map([
      ["repository-security", ["npm run security:repo", "npm run check:docs"]],
      ["firmware-contracts", [
        "npm run check:firmware-manifests",
        "node --test test/firmware-build-matrix.test.mjs test/firmware-network-security.test.mjs",
      ]],
      ["frontend", [
        "npm ci --no-audit --no-fund",
        "npm run build:app",
        "npm run check:frontend-performance",
        "npm run typecheck:app",
        "npm run test:app",
      ]],
      ["server", [
        "npm ci --no-audit --no-fund",
        "npm run build:app",
        "npm run typecheck:convex",
        "npm run test:server",
        "npm run test:workflow",
      ]],
      ["cloud-edge", [
        "npm ci --no-audit --no-fund",
        "npm run build:app",
        "npm ci --prefix cloudflare --no-audit --no-fund",
        "npm run typecheck:cloud",
        "npm run test:cloud",
      ]],
      ["cloud-control-plane", [
        "npm ci --no-audit --no-fund",
        "npm ci --prefix cloudflare-control-plane --no-audit --no-fund",
        "npm run typecheck:cloud-control-plane",
        "npm run test:cloud-control-plane",
      ]],
      ["connector", ["npm run test:connector", "npm run pack:connector"]],
      ["container-smoke", ["docker version", "npm run test:container"]],
    ]);

    for (const [jobName, commands] of requirements) assertJobCommands(jobs, jobName, commands);
    for (const [jobName, job] of jobs) {
      assert.match(job, /^    timeout-minutes: [1-9][0-9]*$/mu, `${jobName} must have a timeout`);
    }
  });

  it("contains no deploy, publication, firmware, or live-service command", async () => {
    const workflow = await readWorkflow();
    assert.doesNotMatch(
      workflow,
      /(?:wrangler\s+deploy|convex\s+deploy|npm\s+publish|firmware:publish|pio\s+run|smoke:convex|smoke:local|qualify:staging|staging:(?:preflight|release))/iu,
    );
  });
});
