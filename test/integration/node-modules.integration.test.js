"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const {
  installMissingNodeModules,
  isModuleInstalled,
  checkNpmAvailable
} = require("../../src/node-modules-install");

function tmpUserDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-nm-integration-"));
}

// A tiny, real Node-RED node module (single JS node, no dependencies) used
// to exercise a genuine npm install end to end, per this repo's
// avoid-mocks testing philosophy.
const REAL_MODULE = "node-red-node-random";

test("integration: happy path - installs a missing real module and it becomes discoverable on disk", async () => {
  const userDir = tmpUserDir();
  await installMissingNodeModules(userDir, [{ name: REAL_MODULE, version: undefined }]);
  assert.equal(isModuleInstalled(userDir, REAL_MODULE), true);
  fs.rmSync(userDir, { recursive: true, force: true });
});

test("integration: already-installed modules are skipped (no reinstall)", async () => {
  const userDir = tmpUserDir();
  await installMissingNodeModules(userDir, [{ name: REAL_MODULE, version: undefined }]);
  const pkgPath = path.join(userDir, "node_modules", REAL_MODULE, "package.json");
  const before = fs.statSync(pkgPath).mtimeMs;

  const result = await installMissingNodeModules(userDir, [{ name: REAL_MODULE, version: undefined }]);
  assert.deepEqual(result.installed, []);
  assert.equal(fs.statSync(pkgPath).mtimeMs, before);
  fs.rmSync(userDir, { recursive: true, force: true });
});

test("integration: npm install failure for a non-existent module fails fast with a clear error identifying the module", async () => {
  const userDir = tmpUserDir();
  await assert.rejects(
    installMissingNodeModules(userDir, [
      { name: "node-red-cli-definitely-does-not-exist-xyz", version: undefined }
    ]),
    /node-red-cli-definitely-does-not-exist-xyz/
  );
  fs.rmSync(userDir, { recursive: true, force: true });
});

test("integration: installing a real package that is not a Node-RED node module fails clearly (no 'node-red' key)", async () => {
  const userDir = tmpUserDir();
  await assert.rejects(
    installMissingNodeModules(userDir, [{ name: "left-pad", version: "1.3.0" }]),
    /not a valid Node-RED node module/
  );
  fs.rmSync(userDir, { recursive: true, force: true });
});

test("integration: a previous partial/interrupted install (module dir without package.json) is detected and re-installed", async () => {
  const userDir = tmpUserDir();
  fs.mkdirSync(path.join(userDir, "node_modules", REAL_MODULE), { recursive: true });
  // Deliberately no package.json inside - simulates a process killed mid-install.
  await installMissingNodeModules(userDir, [{ name: REAL_MODULE, version: undefined }]);
  assert.equal(isModuleInstalled(userDir, REAL_MODULE), true);
  fs.rmSync(userDir, { recursive: true, force: true });
});

test("integration: an unreachable npm registry fails clearly instead of hanging forever", async () => {
  const userDir = tmpUserDir();
  const previousRegistry = process.env.npm_config_registry;
  process.env.npm_config_registry = "http://127.0.0.1:1/";
  try {
    await assert.rejects(
      installMissingNodeModules(userDir, [{ name: REAL_MODULE, version: undefined }], { timeoutMs: 5000 }),
      /timed out|failed to install/
    );
  } finally {
    if (previousRegistry === undefined) delete process.env.npm_config_registry;
    else process.env.npm_config_registry = previousRegistry;
  }
  fs.rmSync(userDir, { recursive: true, force: true });
});

test("integration: an unwritable userDir fails clearly, not with an unhandled exception", async () => {
  const parent = tmpUserDir();
  const userDir = path.join(parent, "locked");
  fs.mkdirSync(userDir);
  fs.chmodSync(userDir, 0o400);
  try {
    await assert.rejects(installMissingNodeModules(userDir, [{ name: REAL_MODULE, version: undefined }]));
  } finally {
    fs.chmodSync(userDir, 0o700);
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test("integration: checkNpmAvailable resolves when the bundled npm CLI is usable", async () => {
  await assert.doesNotReject(checkNpmAvailable());
});

test("integration: checkNpmAvailable rejects clearly when npm is not usable (simulated - real npm binary can't practically be removed in this sandbox)", async () => {
  // Exception to the avoid-mocks rule: making the bundled npm CLI itself
  // unusable isn't practical without breaking the whole test run's
  // package manager, so this narrowly mocks child_process.execFile to
  // simulate the ENOENT node-red's own installer.js checkPrereq() guards
  // against.
  const cp = require("node:child_process");
  const original = cp.execFile;
  cp.execFile = (...args) => {
    const cb = args[args.length - 1];
    cb(new Error("spawn npm-cli.js ENOENT"));
  };
  try {
    await assert.rejects(checkNpmAvailable(), /npm is not available/);
  } finally {
    cp.execFile = original;
  }
});
