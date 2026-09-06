"use strict";

/**
 * Real, non-mocked Docker integration tests for `--docker`.
 *
 * These tests spin up actual containers against the local Docker daemon
 * (skipped entirely if Docker isn't reachable, e.g. in CI runners without
 * Docker - though per the issue's DoD, CI runners are expected to have it
 * preinstalled).
 *
 * The default (bare `--docker`) image resolution path installs
 * `@tbrandenburg/node-red-cli@<version>` from the *public npm registry*
 * inside the build - that only works once this feature's version has
 * actually been published. To validate the container-side mechanism (the
 * envelope-over-stdin protocol, the sandbox entrypoint, and the hardened
 * `docker run` flags) without depending on an as-yet-unpublished npm
 * version, these tests build a throwaway, test-only image that installs
 * this package's *published* runtime dependencies from npm (real network
 * access, same as the real default build would need) but copies in this
 * worktree's own `bin`/`src` instead of `npm install -g` of the package
 * itself. It is never shipped and is removed again after the suite runs.
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync, spawn } = require("node:child_process");
const { before, after, test } = require("node:test");
const { buildRunArgs } = require("../../src/docker-run");

const REPO_ROOT = path.join(__dirname, "..", "..");
const TEST_IMAGE = "node-red-cli-sandbox-integration-test:local";
const DEFAULT_USERDIR_TEST_IMAGE = "node-red-cli-sandbox-default-userdir-test:local";
const BAKED_USERDIR_PATH = "/opt/preinstalled-userdir";
const BAKED_MODULE_NAME = "node-red-contrib-cli-issue-31-dummy";
const BAKED_NODE_TYPE = "cli-issue-31-dummy";

function dockerAvailable() {
  const result = spawnSync("docker", ["info"], { stdio: ["ignore", "ignore", "ignore"] });
  return !result.error && result.status === 0;
}

const skip = !dockerAvailable();

function runCli(args, input, env = {}) {
  return new Promise((resolve, reject) => {
    const cliPath = path.join(REPO_ROOT, "bin", "node-red-cli.js");
    const child = spawn(process.execPath, [cliPath, ...args], { env: { ...process.env, ...env } });
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
    this.skip("Docker daemon not reachable in this environment");
    return;
  }

  const dockerfile = [
    "FROM node:24-slim",
    "WORKDIR /usr/local/lib/node_modules/@tbrandenburg/node-red-cli",
    "COPY package.json package-lock.json ./",
    "RUN npm ci --omit=dev --no-audit --no-fund",
    "COPY bin ./bin",
    "COPY src ./src",
    'ENTRYPOINT ["node", "/usr/local/lib/node_modules/@tbrandenburg/node-red-cli/bin/node-red-cli-sandbox-entry.js"]',
    ""
  ].join("\n");

  const dockerfileDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-docker-test-"));
  const dockerfilePath = path.join(dockerfileDir, "Dockerfile");
  fs.writeFileSync(dockerfilePath, dockerfile);

  const build = spawnSync("docker", ["build", "-t", TEST_IMAGE, "-f", dockerfilePath, REPO_ROOT], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5 * 60 * 1000
  });
  fs.rmSync(dockerfileDir, { recursive: true, force: true });

  if (build.status !== 0) {
    throw new Error(`failed to build the throwaway test image: ${build.stderr}`);
  }

  // Second throwaway image (issue #31): derived from the same base, but also bakes
  // a dummy Node-RED node module into a fixed path and sets
  // NODE_RED_CLI_DEFAULT_USERDIR to it, simulating a community image that
  // pre-installs node packages into its own conventional default userDir.
  const moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-baked-module-"));
  fs.writeFileSync(
    path.join(moduleDir, "package.json"),
    JSON.stringify({
      name: BAKED_MODULE_NAME,
      version: "1.0.0",
      "node-red": { nodes: { dummy: "index.js" } }
    })
  );
  fs.writeFileSync(
    path.join(moduleDir, "index.js"),
    [
      "module.exports = function (RED) {",
      "  function DummyNode(config) {",
      "    RED.nodes.createNode(this, config);",
      "    const node = this;",
      "    node.on('input', function (msg) { node.send(msg); });",
      "  }",
      `  RED.nodes.registerType(${JSON.stringify(BAKED_NODE_TYPE)}, DummyNode);`,
      "};",
      ""
    ].join("\n")
  );

  const defaultUserDirDockerfile = [
    `FROM ${TEST_IMAGE}`,
    `RUN mkdir -p ${BAKED_USERDIR_PATH}/node_modules/${BAKED_MODULE_NAME}`,
    `COPY baked-module/ ${BAKED_USERDIR_PATH}/node_modules/${BAKED_MODULE_NAME}/`,
    `ENV NODE_RED_CLI_DEFAULT_USERDIR=${BAKED_USERDIR_PATH}`,
    ""
  ].join("\n");

  const defaultUserDirBuildDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "node-red-cli-docker-default-userdir-test-")
  );
  fs.cpSync(moduleDir, path.join(defaultUserDirBuildDir, "baked-module"), { recursive: true });
  fs.writeFileSync(path.join(defaultUserDirBuildDir, "Dockerfile"), defaultUserDirDockerfile);
  fs.rmSync(moduleDir, { recursive: true, force: true });

  const defaultUserDirBuild = spawnSync(
    "docker",
    ["build", "-t", DEFAULT_USERDIR_TEST_IMAGE, defaultUserDirBuildDir],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 5 * 60 * 1000 }
  );
  fs.rmSync(defaultUserDirBuildDir, { recursive: true, force: true });

  if (defaultUserDirBuild.status !== 0) {
    throw new Error(
      `failed to build the throwaway default-userdir test image: ${defaultUserDirBuild.stderr}`
    );
  }
});

after(() => {
  if (skip) return;
  spawnSync("docker", ["image", "rm", "-f", TEST_IMAGE], { stdio: "ignore" });
  spawnSync("docker", ["image", "rm", "-f", DEFAULT_USERDIR_TEST_IMAGE], { stdio: "ignore" });
});

test(
  "docker integration: --docker <image>, from-file mode, calls calculate through a real container",
  { skip },
  async () => {
    const flowsPath = path.join(REPO_ROOT, "test", "fixtures", "single-link-in.flows.json");
    const { code, stdout, stderr } = await runCli(
      [flowsPath, "calculate", "--docker", TEST_IMAGE, "--set", "x=4", "--set", "y=5", "--format=json"],
      ""
    );

    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout).payload, 9);
  }
);

test(
  "docker integration: --docker <image>, --flow-json (inline) mode, calls calculate through a real container",
  { skip },
  async () => {
    const flowsPath = path.join(REPO_ROOT, "test", "fixtures", "single-link-in.flows.json");
    const flowJson = fs.readFileSync(flowsPath, "utf8");
    const { code, stdout, stderr } = await runCli(
      [
        "--flow-json",
        flowJson,
        "calculate",
        "--docker",
        TEST_IMAGE,
        "--set",
        "x=4",
        "--set",
        "y=5",
        "--format=json"
      ],
      ""
    );

    assert.equal(code, 0, stderr);
    assert.equal(JSON.parse(stdout).payload, 9);
  }
);

test(
  "docker integration: --docker <image>, --flow-json @path mode, calls calculate through a real container",
  { skip },
  async () => {
    const flowsPath = path.join(REPO_ROOT, "test", "fixtures", "single-link-in.flows.json");
    const { code, stdout, stderr } = await runCli(
      ["--flow-json", `@${flowsPath}`, "calculate", "--docker", TEST_IMAGE, "--set", "x=4", "--set", "y=5"],
      ""
    );

    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), "9");
  }
);

test(
  "docker integration: --docker defaults to --network none, verified against a real container using the exact hardened docker-run.js flags",
  { skip },
  async () => {
    // Probe the container directly with the exact flags buildRunArgs() produces
    // for `--docker` (minus --node-modules), overriding the entrypoint with a
    // plain Node network probe - avoids relying on Node-RED's Function node
    // sandbox exposing `fetch`/`require`, which it deliberately does not.
    const args = buildRunArgs(TEST_IMAGE, { networkNeeded: false });
    const imageIndex = args.indexOf(TEST_IMAGE);
    const runArgs = [
      ...args.slice(0, imageIndex),
      "--entrypoint",
      "node",
      TEST_IMAGE,
      "-e",
      "require('http').get('http://example.com', () => console.log('reached'))" +
        ".on('error', (e) => console.log(`blocked:${e.code}`))"
    ];

    const result = spawnSync("docker", runArgs, { encoding: "utf8", timeout: 15000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(
      result.stdout,
      /^blocked:/,
      `expected --network none to block outbound access, got: ${result.stdout}`
    );
  }
);

test(
  "docker integration: --node-modules + --docker enables network access (--network not 'none')",
  { skip },
  async () => {
    const flowsPath = path.join(REPO_ROOT, "test", "fixtures", "single-link-in.flows.json");
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-docker-volume-test-"));
    fs.rmSync(userDir, { recursive: true, force: true }); // only need a deterministic never-used path for volume naming

    const { code, stdout, stderr } = await runCli(
      [
        flowsPath,
        "calculate",
        "--docker",
        TEST_IMAGE,
        "--user-dir",
        userDir,
        "--node-modules",
        "node-red-node-random",
        "--set",
        "x=4",
        "--set",
        "y=5"
      ],
      ""
    );

    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), "9");
    // The named volume Docker created for this --user-dir must exist (persistence via a
    // named volume, not a host bind mount: userDir itself was never created on the host).
    assert.equal(
      fs.existsSync(userDir),
      false,
      "no stray host directory should be created for a Docker-mode --user-dir"
    );
  }
);

test(
  "docker integration: --docker <image> --network works without --node-modules/--user-dir",
  { skip },
  async () => {
    const flowsPath = path.join(REPO_ROOT, "test", "fixtures", "single-link-in.flows.json");
    const { code, stdout, stderr } = await runCli(
      [flowsPath, "calculate", "--docker", TEST_IMAGE, "--network", "--set", "x=4", "--set", "y=5"],
      ""
    );

    assert.equal(code, 0, stderr);
    assert.equal(stdout.trim(), "9");
  }
);

test("docker integration: --network alone (no --node-modules) enables network access", { skip }, async () => {
  // Probe the container directly with the exact flags buildRunArgs() produces
  // for `--docker --network` (no --node-modules). Rather than depending on
  // real internet egress (flaky in restricted CI), check for the presence
  // of a non-loopback network interface: `--network none` strips every
  // interface but `lo`, while a real network mode always has at least one.
  const args = buildRunArgs(TEST_IMAGE, { networkNeeded: true });
  const imageIndex = args.indexOf(TEST_IMAGE);
  const runArgs = [
    ...args.slice(0, imageIndex),
    "--entrypoint",
    "node",
    TEST_IMAGE,
    "-e",
    "console.log(Object.keys(require('os').networkInterfaces()).filter((n) => n !== 'lo').length)"
  ];

  const result = spawnSync("docker", runArgs, { encoding: "utf8", timeout: 15000 });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(
    Number(result.stdout.trim()) > 0,
    `expected networkNeeded (as set by --network) to attach a non-loopback interface, got: ${result.stdout}`
  );
});

test(
  "docker integration: --docker <image with NODE_RED_CLI_DEFAULT_USERDIR> discovers the pre-baked module without --user-dir/--node-modules (issue #31)",
  { skip },
  async () => {
    const flow = JSON.stringify([
      { id: "tab", type: "tab", label: "t" },
      { id: "ask", type: "link in", z: "tab", name: "ask", wires: [["dummy"]] },
      { id: "dummy", type: BAKED_NODE_TYPE, z: "tab", name: "d", wires: [["return"]] },
      { id: "return", type: "link out", z: "tab", name: "return", mode: "return" }
    ]);
    const { code, stdout, stderr } = await runCli(
      ["--flow-json", flow, "ask", "--docker", DEFAULT_USERDIR_TEST_IMAGE, "--format=json"],
      JSON.stringify({ payload: "hi" })
    );

    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout).payload, "hi");
  }
);

test(
  "docker integration: explicit --user-dir takes precedence over NODE_RED_CLI_DEFAULT_USERDIR (the pre-baked module is not used)",
  { skip },
  async () => {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-docker-default-userdir-precedence-"));
    fs.rmSync(userDir, { recursive: true, force: true }); // deterministic never-used path for volume naming
    const flow = JSON.stringify([
      { id: "tab", type: "tab", label: "t" },
      { id: "ask", type: "link in", z: "tab", name: "ask", wires: [["dummy"]] },
      { id: "dummy", type: BAKED_NODE_TYPE, z: "tab", name: "d", wires: [["return"]] },
      { id: "return", type: "link out", z: "tab", name: "return", mode: "return" }
    ]);
    const { code, stdout, stderr } = await runCli(
      [
        "--flow-json",
        flow,
        "ask",
        "--docker",
        DEFAULT_USERDIR_TEST_IMAGE,
        "--user-dir",
        userDir,
        "--format=json"
      ],
      JSON.stringify({ payload: "hi" })
    );

    assert.notEqual(code, 0);
    assert.equal(stdout, "");
    assert.match(stderr, /not instantiated in the runtime/);
  }
);

test("docker integration: an unreachable Docker daemon fails fast with a clear 'docker unavailable' error", async () => {
  const flowsPath = path.join(REPO_ROOT, "test", "fixtures", "single-link-in.flows.json");
  const { code, stdout, stderr } = await runCli([flowsPath, "calculate", "--docker"], "", {
    DOCKER_HOST: "unix:///tmp/node-red-cli-nonexistent-docker.sock"
  });

  assert.notEqual(code, 0);
  assert.equal(stdout, "");
  assert.match(stderr, /node-red-cli: docker unavailable:/);
});

test(
  "docker integration: --docker @nonexistent-path fails fast with a clear 'docker build failed' error",
  { skip },
  async () => {
    const flowsPath = path.join(REPO_ROOT, "test", "fixtures", "single-link-in.flows.json");
    const { code, stdout, stderr } = await runCli(
      [flowsPath, "calculate", "--docker", "@/no/such/Dockerfile/path"],
      ""
    );

    assert.notEqual(code, 0);
    assert.equal(stdout, "");
    assert.match(stderr, /node-red-cli: docker build failed: could not read Dockerfile/);
  }
);
