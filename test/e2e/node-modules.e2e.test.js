"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { test } = require("node:test");

/** Run the CLI as a subprocess, piping `input` to stdin and collecting output. */
function runCli(args, input = "", envOverrides = {}) {
  return new Promise((resolve, reject) => {
    const cliPath = path.join(__dirname, "..", "..", "bin", "node-red-cli.js");
    const child = spawn(process.execPath, [cliPath, ...args], { env: { ...process.env, ...envOverrides } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

const flowsPath = path.join(__dirname, "..", "fixtures", "flows.json");

function tmpUserDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-nm-e2e-"));
}

test("e2e: --node-modules without --user-dir is rejected before any npm process is spawned", async () => {
  const { code, stderr } = await runCli([
    flowsPath,
    "calculate",
    "--node-modules",
    "node-red-node-random",
    "--set",
    "x=1",
    "--set",
    "y=2"
  ]);
  assert.equal(code, 1);
  assert.match(stderr, /--node-modules requires an explicit --user-dir/);
});

test("e2e: a malformed --node-modules value is rejected before any npm process is spawned", async () => {
  const userDir = tmpUserDir();
  const { code, stderr } = await runCli([
    flowsPath,
    "calculate",
    "--user-dir",
    userDir,
    "--node-modules",
    "foo,",
    "--set",
    "x=1",
    "--set",
    "y=2"
  ]);
  assert.equal(code, 1);
  assert.match(stderr, /empty module name/);
  assert.equal(fs.existsSync(path.join(userDir, "node_modules")), false);
  fs.rmSync(userDir, { recursive: true, force: true });
});

test("e2e: a denylisted module name is rejected, no npm process runs", async () => {
  const userDir = tmpUserDir();
  const { code, stderr } = await runCli(
    [
      flowsPath,
      "calculate",
      "--user-dir",
      userDir,
      "--node-modules",
      "node-red-contrib-e2e-denied",
      "--set",
      "x=1",
      "--set",
      "y=2"
    ],
    "",
    { NODE_RED_CLI_DENY_MODULES: "node-red-contrib-e2e-denied" }
  );
  assert.equal(code, 1);
  assert.match(stderr, /not allowed/);
  assert.equal(fs.existsSync(path.join(userDir, "node_modules")), false);
  fs.rmSync(userDir, { recursive: true, force: true });
});

test("e2e: no --node-modules given means no network/npm access even with --user-dir set", async () => {
  const userDir = tmpUserDir();
  const { code } = await runCli(
    [flowsPath, "calculate", "--user-dir", userDir, "--set", "x=4", "--set", "y=5"],
    ""
  );
  assert.equal(code, 0);
  // Node-RED itself creates an empty node_modules/ dir at RED.init() time
  // regardless of --node-modules; assert it stayed empty, i.e. no npm
  // install ever ran.
  const nodeModulesDir = path.join(userDir, "node_modules");
  const entries = fs.existsSync(nodeModulesDir) ? fs.readdirSync(nodeModulesDir) : [];
  assert.deepEqual(entries, []);
  fs.rmSync(userDir, { recursive: true, force: true });
});

test("e2e: --user-dir makes the userDir persistent across two runs, --node-modules installs once and the second run skips it", async () => {
  const userDir = tmpUserDir();
  const args = [
    flowsPath,
    "calculate",
    "--user-dir",
    userDir,
    "--node-modules",
    "node-red-node-random",
    "--set",
    "x=4",
    "--set",
    "y=5"
  ];

  const first = await runCli(args, "");
  assert.equal(first.code, 0, first.stderr);
  assert.equal(
    fs.existsSync(path.join(userDir, "node_modules", "node-red-node-random", "package.json")),
    true
  );
  const installedAt = fs.statSync(
    path.join(userDir, "node_modules", "node-red-node-random", "package.json")
  ).mtimeMs;

  const second = await runCli(args, "");
  assert.equal(second.code, 0, second.stderr);
  assert.equal(
    fs.statSync(path.join(userDir, "node_modules", "node-red-node-random", "package.json")).mtimeMs,
    installedAt,
    "second run must not reinstall an already-present module"
  );

  fs.rmSync(userDir, { recursive: true, force: true });
});
