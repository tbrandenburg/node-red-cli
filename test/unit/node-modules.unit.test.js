"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const {
  parseNodeModulesParam,
  resolveUserDir,
  defaultCacheDir,
  isDenied
} = require("../../src/node-modules");
const childProcess = require("node:child_process");
const { isModuleInstalled, diffMissingModules, npmInstall } = require("../../src/node-modules-install");

test("unit: parseNodeModulesParam parses a single name without version", () => {
  assert.deepEqual(parseNodeModulesParam(["foo"]), [{ name: "foo", version: undefined }]);
});

test("unit: parseNodeModulesParam parses name@version", () => {
  assert.deepEqual(parseNodeModulesParam(["foo@1.2.3"]), [{ name: "foo", version: "1.2.3" }]);
});

test("unit: parseNodeModulesParam parses scoped packages with and without version", () => {
  assert.deepEqual(parseNodeModulesParam(["@scope/foo"]), [{ name: "@scope/foo", version: undefined }]);
  assert.deepEqual(parseNodeModulesParam(["@scope/foo@2.0.0"]), [{ name: "@scope/foo", version: "2.0.0" }]);
});

test("unit: parseNodeModulesParam supports comma-separated entries in a single value", () => {
  assert.deepEqual(parseNodeModulesParam(["foo,bar@1.0.0"]), [
    { name: "foo", version: undefined },
    { name: "bar", version: "1.0.0" }
  ]);
});

test("unit: parseNodeModulesParam merges multiple repeated occurrences", () => {
  assert.deepEqual(parseNodeModulesParam(["foo", "bar@2.0.0"]), [
    { name: "foo", version: undefined },
    { name: "bar", version: "2.0.0" }
  ]);
});

test("unit: parseNodeModulesParam rejects an empty entry", () => {
  assert.throws(() => parseNodeModulesParam([""]), /empty module name/);
});

test("unit: parseNodeModulesParam rejects a trailing comma", () => {
  assert.throws(() => parseNodeModulesParam(["foo,"]), /empty module name/);
});

test("unit: parseNodeModulesParam rejects a missing version after '@'", () => {
  assert.throws(() => parseNodeModulesParam(["foo@"]), /missing version after/);
});

test("unit: parseNodeModulesParam rejects an invalid npm package name", () => {
  assert.throws(() => parseNodeModulesParam(["Not Valid!"]), /not a valid npm package name/);
});

test("unit: parseNodeModulesParam rejects an invalid version", () => {
  assert.throws(() => parseNodeModulesParam(["foo@not a version"]), /not a valid version/);
});

test("unit: parseNodeModulesParam rejects duplicate module names within one invocation", () => {
  assert.throws(() => parseNodeModulesParam(["foo", "foo@1.0.0"]), /declared more than once/);
});

test("unit: parseNodeModulesParam rejects path traversal in a module name", () => {
  assert.throws(() => parseNodeModulesParam(["../etc/passwd"]), /not a valid npm package name|not allowed/);
});

test("unit: parseNodeModulesParam rejects a url-shaped module name", () => {
  assert.throws(() => parseNodeModulesParam(["https://example.com/pkg.tgz"]), /not a valid npm package name/);
});

test("unit: isDenied rejects names matching NODE_RED_CLI_DENY_MODULES", () => {
  const previous = process.env.NODE_RED_CLI_DENY_MODULES;
  process.env.NODE_RED_CLI_DENY_MODULES = "node-red-contrib-denied-*";
  try {
    assert.equal(isDenied("node-red-contrib-denied-thing"), true);
    assert.equal(isDenied("node-red-contrib-allowed-thing"), false);
  } finally {
    if (previous === undefined) delete process.env.NODE_RED_CLI_DENY_MODULES;
    else process.env.NODE_RED_CLI_DENY_MODULES = previous;
  }
});

test("unit: parseNodeModulesParam rejects a denylisted module name (security boundary)", () => {
  const previous = process.env.NODE_RED_CLI_DENY_MODULES;
  process.env.NODE_RED_CLI_DENY_MODULES = "node-red-contrib-denied-thing";
  try {
    assert.throws(() => parseNodeModulesParam(["node-red-contrib-denied-thing"]), /not allowed/);
  } finally {
    if (previous === undefined) delete process.env.NODE_RED_CLI_DENY_MODULES;
    else process.env.NODE_RED_CLI_DENY_MODULES = previous;
  }
});

test("unit: isModuleInstalled returns false when node_modules/<name> does not exist", () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-nm-"));
  assert.equal(isModuleInstalled(userDir, "missing-pkg"), false);
  fs.rmSync(userDir, { recursive: true, force: true });
});

test("unit: isModuleInstalled returns false for a partial install (no package.json)", () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-nm-"));
  fs.mkdirSync(path.join(userDir, "node_modules", "partial-pkg"), { recursive: true });
  assert.equal(isModuleInstalled(userDir, "partial-pkg"), false);
  fs.rmSync(userDir, { recursive: true, force: true });
});

test("unit: isModuleInstalled returns false when package.json lacks a 'node-red' key", () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-nm-"));
  const modDir = path.join(userDir, "node_modules", "not-a-node-red-pkg");
  fs.mkdirSync(modDir, { recursive: true });
  fs.writeFileSync(
    path.join(modDir, "package.json"),
    JSON.stringify({ name: "not-a-node-red-pkg", version: "1.0.0" })
  );
  assert.equal(isModuleInstalled(userDir, "not-a-node-red-pkg"), false);
  fs.rmSync(userDir, { recursive: true, force: true });
});

test("unit: isModuleInstalled returns true for a consistent install, honoring version match", () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-nm-"));
  const modDir = path.join(userDir, "node_modules", "real-pkg");
  fs.mkdirSync(modDir, { recursive: true });
  fs.writeFileSync(
    path.join(modDir, "package.json"),
    JSON.stringify({ name: "real-pkg", version: "1.2.3", "node-red": { nodes: {} } })
  );
  assert.equal(isModuleInstalled(userDir, "real-pkg"), true);
  assert.equal(isModuleInstalled(userDir, "real-pkg", "1.2.3"), true);
  assert.equal(isModuleInstalled(userDir, "real-pkg", "9.9.9"), false);
  fs.rmSync(userDir, { recursive: true, force: true });
});

test("unit: diffMissingModules only returns modules that are missing/inconsistent", () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-nm-"));
  const modDir = path.join(userDir, "node_modules", "already-there");
  fs.mkdirSync(modDir, { recursive: true });
  fs.writeFileSync(
    path.join(modDir, "package.json"),
    JSON.stringify({ name: "already-there", version: "1.0.0", "node-red": { nodes: {} } })
  );
  const modules = [
    { name: "already-there", version: "1.0.0" },
    { name: "not-there", version: undefined }
  ];
  assert.deepEqual(diffMissingModules(userDir, modules), [{ name: "not-there", version: undefined }]);
  fs.rmSync(userDir, { recursive: true, force: true });
});

test("unit: npmInstall passes --prefix <userDir> so npm can't escape to an ancestor node_modules (issue #24)", async (t) => {
  const parentDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-nm-parent-"));
  fs.mkdirSync(path.join(parentDir, "node_modules"), { recursive: true });
  const userDir = path.join(parentDir, "userDir");
  fs.mkdirSync(userDir, { recursive: true });

  let capturedArgs;
  let capturedOptions;
  const original = childProcess.execFile;
  childProcess.execFile = (command, args, options, callback) => {
    capturedArgs = args;
    capturedOptions = options;
    callback(null, "", "");
  };
  t.after(() => {
    childProcess.execFile = original;
    fs.rmSync(parentDir, { recursive: true, force: true });
  });

  await npmInstall(userDir, { name: "some-pkg", version: undefined });

  const prefixIndex = capturedArgs.indexOf("--prefix");
  assert.ok(prefixIndex !== -1, "expected --prefix flag to be passed");
  assert.equal(capturedArgs[prefixIndex + 1], userDir);
  assert.equal(capturedOptions.cwd, userDir);
});

test("unit: resolveUserDir returns undefined when --user-dir wasn't given (ephemeral mode preserved)", () => {
  assert.equal(resolveUserDir(undefined), undefined);
});

test("unit: resolveUserDir resolves the bare flag to the default cache dir", () => {
  assert.equal(resolveUserDir(true), defaultCacheDir());
});

test("unit: resolveUserDir resolves an explicit relative path against cwd", () => {
  assert.equal(resolveUserDir("some/dir", "/base"), path.resolve("/base", "some/dir"));
});

test("unit: defaultCacheDir honors XDG_CACHE_HOME", () => {
  const previous = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = "/tmp/xdg-test-cache";
  try {
    assert.equal(defaultCacheDir(), path.join("/tmp/xdg-test-cache", "node-red-cli"));
  } finally {
    if (previous === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previous;
  }
});
