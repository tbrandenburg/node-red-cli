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
const DATA_PROBE_TEST_IMAGE = "node-red-cli-sandbox-data-probe-test:local";
const DATA_PROBE_NEGATIVE_TEST_IMAGE = "node-red-cli-sandbox-data-probe-negative-test:local";
const DOCKER_USERDIR_TEST_IMAGE = "node-red-cli-sandbox-docker-userdir-test:local";
const DOCKER_USERDIR_PATH = "/opt/preinstalled-userdir";
const BAKED_MODULE_NAME = "@test/cli-issue-33-dummy";
const BAKED_NODE_TYPE = "cli-issue-33-dummy";

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

  // Fake Node-RED node package module baked into each of the three
  // throwaway images below (issue #33), shared as a single directory tree.
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

  // Image 1 (issue #33): bakes the module into /data/node_modules/@test/*,
  // simulating a community image (like the motivating
  // ghcr.io/tbrandenburg/agentic-workflow-dev-env) whose own conventional
  // default userDir the /data auto-probe should discover, with no
  // --user-dir/--docker-userdir/--node-modules given at all.
  const dataProbeDockerfile = [
    `FROM ${TEST_IMAGE}`,
    `RUN mkdir -p /data/node_modules/${BAKED_MODULE_NAME}`,
    `COPY baked-module/ /data/node_modules/${BAKED_MODULE_NAME}/`,
    ""
  ].join("\n");
  const dataProbeBuildDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-docker-data-probe-test-"));
  fs.cpSync(moduleDir, path.join(dataProbeBuildDir, "baked-module"), { recursive: true });
  fs.writeFileSync(path.join(dataProbeBuildDir, "Dockerfile"), dataProbeDockerfile);

  const dataProbeBuild = spawnSync("docker", ["build", "-t", DATA_PROBE_TEST_IMAGE, dataProbeBuildDir], {
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 5 * 60 * 1000
  });
  fs.rmSync(dataProbeBuildDir, { recursive: true, force: true });
  if (dataProbeBuild.status !== 0) {
    throw new Error(`failed to build the throwaway /data auto-probe test image: ${dataProbeBuild.stderr}`);
  }

  // Image 2 (issue #33): /data exists but contains no valid Node-RED
  // package -- the auto-probe must reject it and fall through to the
  // normal ephemeral default instead of misidentifying an unrelated /data.
  const dataProbeNegativeDockerfile = [
    `FROM ${TEST_IMAGE}`,
    "RUN mkdir -p /data/node_modules/some-unrelated-package",
    'RUN echo \'{"name":"some-unrelated-package"}\' > /data/node_modules/some-unrelated-package/package.json',
    ""
  ].join("\n");
  const dataProbeNegativeBuildDir = fs.mkdtempSync(
    path.join(os.tmpdir(), "node-red-cli-docker-data-probe-negative-test-")
  );
  fs.writeFileSync(path.join(dataProbeNegativeBuildDir, "Dockerfile"), dataProbeNegativeDockerfile);

  const dataProbeNegativeBuild = spawnSync(
    "docker",
    ["build", "-t", DATA_PROBE_NEGATIVE_TEST_IMAGE, dataProbeNegativeBuildDir],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 5 * 60 * 1000 }
  );
  fs.rmSync(dataProbeNegativeBuildDir, { recursive: true, force: true });
  if (dataProbeNegativeBuild.status !== 0) {
    throw new Error(
      `failed to build the throwaway /data auto-probe negative test image: ${dataProbeNegativeBuild.stderr}`
    );
  }

  // Image 3 (issue #33): bakes the module into a non-/data path, exercising
  // the explicit --docker-userdir override rather than the /data auto-probe.
  const dockerUserDirDockerfile = [
    `FROM ${TEST_IMAGE}`,
    `RUN mkdir -p ${DOCKER_USERDIR_PATH}/node_modules/${BAKED_MODULE_NAME}`,
    `COPY baked-module/ ${DOCKER_USERDIR_PATH}/node_modules/${BAKED_MODULE_NAME}/`,
    ""
  ].join("\n");
  const dockerUserDirBuildDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-docker-userdir-test-"));
  fs.cpSync(moduleDir, path.join(dockerUserDirBuildDir, "baked-module"), { recursive: true });
  fs.writeFileSync(path.join(dockerUserDirBuildDir, "Dockerfile"), dockerUserDirDockerfile);
  fs.rmSync(moduleDir, { recursive: true, force: true });

  const dockerUserDirBuild = spawnSync(
    "docker",
    ["build", "-t", DOCKER_USERDIR_TEST_IMAGE, dockerUserDirBuildDir],
    { stdio: ["ignore", "pipe", "pipe"], timeout: 5 * 60 * 1000 }
  );
  fs.rmSync(dockerUserDirBuildDir, { recursive: true, force: true });
  if (dockerUserDirBuild.status !== 0) {
    throw new Error(
      `failed to build the throwaway --docker-userdir test image: ${dockerUserDirBuild.stderr}`
    );
  }
});

after(() => {
  if (skip) return;
  spawnSync("docker", ["image", "rm", "-f", TEST_IMAGE], { stdio: "ignore" });
  spawnSync("docker", ["image", "rm", "-f", DATA_PROBE_TEST_IMAGE], { stdio: "ignore" });
  spawnSync("docker", ["image", "rm", "-f", DATA_PROBE_NEGATIVE_TEST_IMAGE], { stdio: "ignore" });
  spawnSync("docker", ["image", "rm", "-f", DOCKER_USERDIR_TEST_IMAGE], { stdio: "ignore" });
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
  "docker integration: --docker <image with a valid /data node-red package> discovers it via the auto-probe, no flags needed (issue #33)",
  { skip },
  async () => {
    const flow = JSON.stringify([
      { id: "tab", type: "tab", label: "t" },
      { id: "ask", type: "link in", z: "tab", name: "ask", wires: [["dummy"]] },
      { id: "dummy", type: BAKED_NODE_TYPE, z: "tab", name: "d", wires: [["return"]] },
      { id: "return", type: "link out", z: "tab", name: "return", mode: "return" }
    ]);
    const { code, stdout, stderr } = await runCli(
      ["--flow-json", flow, "ask", "--docker", DATA_PROBE_TEST_IMAGE, "--format=json"],
      JSON.stringify({ payload: "hi" })
    );

    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout).payload, "hi");
  }
);

test(
  "docker integration: --docker <image with an invalid /data> falls through to the ephemeral default (issue #33)",
  { skip },
  async () => {
    const flowsPath = path.join(REPO_ROOT, "test", "fixtures", "single-link-in.flows.json");
    const { code, stdout, stderr } = await runCli(
      [
        flowsPath,
        "calculate",
        "--docker",
        DATA_PROBE_NEGATIVE_TEST_IMAGE,
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
  "docker integration: --docker-userdir <path> discovers a pre-baked module at a non-/data path (issue #33)",
  { skip },
  async () => {
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
        DOCKER_USERDIR_TEST_IMAGE,
        "--docker-userdir",
        DOCKER_USERDIR_PATH,
        "--format=json"
      ],
      JSON.stringify({ payload: "hi" })
    );

    assert.equal(code, 0, stderr);
    assert.deepEqual(JSON.parse(stdout).payload, "hi");
  }
);

test(
  "docker integration: explicit --user-dir takes precedence over --docker-userdir (the pre-baked module is not used)",
  { skip },
  async () => {
    const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-docker-userdir-precedence-"));
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
        DOCKER_USERDIR_TEST_IMAGE,
        "--docker-userdir",
        DOCKER_USERDIR_PATH,
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
