"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test, beforeEach, afterEach } = require("node:test");
const { resolveDefaultUserDir } = require("../../src/run-envelope");

const ENV_VAR = "NODE_RED_CLI_DEFAULT_USERDIR";
let originalEnvValue;

beforeEach(() => {
  originalEnvValue = process.env[ENV_VAR];
  delete process.env[ENV_VAR];
});

afterEach(() => {
  if (originalEnvValue === undefined) {
    delete process.env[ENV_VAR];
  } else {
    process.env[ENV_VAR] = originalEnvValue;
  }
});

/**
 * Unit coverage for issue #31's `resolveDefaultUserDir` helper -- the
 * env-var-driven fallback that lets a Docker image's own pre-populated
 * default userDir be discovered by `runFlowInvocation` when `--user-dir`
 * isn't given. Full precedence/non-deletion behavior of `runFlowInvocation`
 * itself is covered at the integration level (real Node-RED runtime boot
 * required), since `runFlowInvocation` isn't feasibly unit-testable against
 * a fake runtime without mocking the `node-red` module.
 */
test("unit: resolveDefaultUserDir returns undefined when NODE_RED_CLI_DEFAULT_USERDIR is unset", () => {
  assert.equal(resolveDefaultUserDir(), undefined);
});

test("unit: resolveDefaultUserDir returns the path when it exists and is a directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-default-userdir-"));
  try {
    process.env[ENV_VAR] = dir;
    assert.equal(resolveDefaultUserDir(), dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("unit: resolveDefaultUserDir falls back to undefined and warns when the path doesn't exist", () => {
  const missingPath = path.join(os.tmpdir(), "node-red-cli-does-not-exist-", String(Date.now()));
  process.env[ENV_VAR] = missingPath;

  const originalConsoleError = console.error;
  const warnings = [];
  console.error = (msg) => warnings.push(msg);
  try {
    assert.equal(resolveDefaultUserDir(), undefined);
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /NODE_RED_CLI_DEFAULT_USERDIR='.*' is not usable/);
  assert.match(warnings[0], /falling back to an ephemeral userDir/);
});

test("unit: resolveDefaultUserDir falls back to undefined and warns when the path is a file, not a directory", () => {
  const filePath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-default-userdir-file-")),
    "not-a-dir"
  );
  fs.writeFileSync(filePath, "");
  process.env[ENV_VAR] = filePath;

  const originalConsoleError = console.error;
  const warnings = [];
  console.error = (msg) => warnings.push(msg);
  try {
    assert.equal(resolveDefaultUserDir(), undefined);
  } finally {
    console.error = originalConsoleError;
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /not a directory/);
});
