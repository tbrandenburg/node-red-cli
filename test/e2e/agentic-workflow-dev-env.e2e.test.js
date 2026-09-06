"use strict";

/**
 * Real, non-mocked e2e coverage for issue #33's `/data` auto-probe against
 * the actual motivating image,
 * ghcr.io/tbrandenburg/agentic-workflow-dev-env, which sets
 * `NODE_RED_HOME=/data` and pre-installs `@tbrandenburg/node-red-agents`
 * there -- exactly the real-world case `NODE_RED_CLI_DEFAULT_USERDIR` (see
 * #31/#32) was reverted for being dead-on-arrival against.
 *
 * `--docker <image>`'s normal resolution path derives a sandbox image via
 * `npm install -g @tbrandenburg/node-red-cli@<published version>` (see
 * `src/docker-image.js`), which can't yet reflect this worktree's
 * unreleased code. Consistent with `test/integration/docker.integration.test.js`'s
 * own documented workaround, this builds a throwaway derived image
 * (`FROM ghcr.io/tbrandenburg/agentic-workflow-dev-env:latest` + this
 * worktree's own `bin`/`src` copied in directly, no npm install) so the
 * actual code under test runs against the actual image, and removes it
 * again after the suite runs.
 *
 * Skipped entirely if Docker isn't reachable, or if the real image can't be
 * pulled (no network egress to ghcr.io in this environment) -- never
 * mocked.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");
const { before, after, test } = require("node:test");

const REPO_ROOT = path.join(__dirname, "..", "..");
const BASE_IMAGE = "ghcr.io/tbrandenburg/agentic-workflow-dev-env:latest";
const DERIVED_IMAGE = "node-red-cli-agentic-dev-env-e2e-test:local";

function dockerAvailable() {
  const result = spawnSync("docker", ["info"], { stdio: ["ignore", "ignore", "ignore"] });
  return !result.error && result.status === 0;
}

function baseImagePullable() {
  const result = spawnSync("docker", ["pull", BASE_IMAGE], {
    stdio: ["ignore", "ignore", "ignore"],
    timeout: 2 * 60 * 1000
  });
  return !result.error && result.status === 0;
}

let skip = !dockerAvailable();
let skipReason = "Docker daemon not reachable in this environment";
if (!skip && !baseImagePullable()) {
  skip = true;
  skipReason = `could not pull ${BASE_IMAGE} (no network egress to ghcr.io in this environment)`;
}

function runCli(args, input) {
  return new Promise((resolve, reject) => {
    const cliPath = path.join(REPO_ROOT, "bin", "node-red-cli.js");
    const child = spawn(process.execPath, [cliPath, ...args], { env: process.env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

before(async function () {
  if (skip) {
    this.skip(skipReason);
    return;
  }

  const dockerfile = [
    `FROM ${BASE_IMAGE}`,
    "USER root",
    "WORKDIR /usr/local/lib/node_modules/@tbrandenburg/node-red-cli",
    "COPY package.json package-lock.json ./",
    "RUN npm ci --omit=dev --no-audit --no-fund",
    "COPY bin ./bin",
    "COPY src ./src",
    'ENTRYPOINT ["node", "/usr/local/lib/node_modules/@tbrandenburg/node-red-cli/bin/node-red-cli-sandbox-entry.js"]',
    ""
  ].join("\n");

  const dockerfileDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-agentic-e2e-"));
  const dockerfilePath = path.join(dockerfileDir, "Dockerfile");
  fs.writeFileSync(dockerfilePath, dockerfile);

  const build = spawnSync("docker", ["build", "-t", DERIVED_IMAGE, "-f", dockerfilePath, REPO_ROOT], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5 * 60 * 1000
  });
  fs.rmSync(dockerfileDir, { recursive: true, force: true });

  if (build.status !== 0) {
    throw new Error(
      `failed to build the throwaway agentic-workflow-dev-env-derived test image: ${build.stderr}`
    );
  }
});

after(() => {
  if (skip) return;
  spawnSync("docker", ["image", "rm", "-f", DERIVED_IMAGE], { stdio: "ignore" });
});

test(
  "e2e: --docker <agentic-workflow-dev-env-derived image> discovers the real @tbrandenburg/node-red-agents module via the /data auto-probe, no flags needed (issue #33)",
  { skip },
  async () => {
    // The 'agent' node is deployed unwired (alongside a plain ask->return
    // link pair) purely to force Node-RED to load
    // @tbrandenburg/node-red-agents from userDir -- which only succeeds if
    // the /data auto-probe actually picked /data as userDir. Node-RED
    // refuses to start *any* flow if *any* referenced node type isn't
    // registered (see src/run-envelope.js's waitForFlowsSettled doc
    // comment), so a successful ask/return round trip here is proof the
    // real module was discovered and loaded -- without needing to actually
    // invoke the agent (which would need a real coding-agent API key).
    const flow = JSON.stringify([
      { id: "tab", type: "tab", label: "t" },
      { id: "ask", type: "link in", z: "tab", name: "ask", wires: [["return"]] },
      { id: "return", type: "link out", z: "tab", name: "return", mode: "return" },
      {
        id: "unused-agent",
        type: "agent",
        z: "tab",
        name: "unused-agent",
        agent: "opencode",
        runtime: "direct",
        prompt: "payload",
        promptType: "msg",
        wires: [[], []]
      }
    ]);

    const { code, stdout, stderr } = await runCli(
      ["--flow-json", flow, "ask", "--docker", DERIVED_IMAGE, "--format=json"],
      JSON.stringify({ payload: "hi" })
    );

    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout).payload, "hi");
  }
);
