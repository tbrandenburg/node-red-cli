"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { resolveContainerDefaultUserDir, resolveEffectiveUserDir } = require("../../src/run-envelope");

/**
 * Unit coverage for issue #33's `resolveContainerDefaultUserDir` helper --
 * the `/data` auto-probe that lets a Docker image's own pre-populated
 * default userDir be discovered without any bespoke env-var convention
 * (replacing the reverted `NODE_RED_CLI_DEFAULT_USERDIR`, see #31/#32).
 * `baseDir` is parameterized precisely so this is testable against real
 * temp directories on disk without touching the real `/data` (which
 * generally doesn't exist outside a container anyway).
 */
test("unit: resolveContainerDefaultUserDir returns undefined when baseDir doesn't exist", () => {
  const missingDir = path.join(os.tmpdir(), "node-red-cli-data-probe-missing-", String(Date.now()));
  assert.equal(resolveContainerDefaultUserDir(missingDir), undefined);
});

test("unit: resolveContainerDefaultUserDir returns undefined when baseDir has no node_modules", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-data-probe-empty-"));
  try {
    assert.equal(resolveContainerDefaultUserDir(baseDir), undefined);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("unit: resolveContainerDefaultUserDir returns undefined when node_modules has only unrelated packages (true negative)", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-data-probe-unrelated-"));
  try {
    const pkgDir = path.join(baseDir, "node_modules", "some-unrelated-package");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name: "some-unrelated-package" }));
    assert.equal(resolveContainerDefaultUserDir(baseDir), undefined);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("unit: resolveContainerDefaultUserDir returns baseDir when a direct node_modules child declares 'node-red' (true positive)", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-data-probe-direct-"));
  try {
    const pkgDir = path.join(baseDir, "node_modules", "node-red-contrib-example");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "node-red-contrib-example", "node-red": { nodes: { example: "index.js" } } })
    );
    assert.equal(resolveContainerDefaultUserDir(baseDir), baseDir);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("unit: resolveContainerDefaultUserDir returns baseDir when a scoped (@scope/*) package declares 'node-red' (true positive)", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-data-probe-scoped-"));
  try {
    const pkgDir = path.join(baseDir, "node_modules", "@example-scope", "example-nodes");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "@example-scope/example-nodes", "node-red": { nodes: { example: "index.js" } } })
    );
    assert.equal(resolveContainerDefaultUserDir(baseDir), baseDir);
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("unit: resolveContainerDefaultUserDir follows symlinked scoped packages (npm frequently symlinks installs)", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-data-probe-symlink-"));
  try {
    const realPkgDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-data-probe-symlink-target-"));
    fs.writeFileSync(
      path.join(realPkgDir, "package.json"),
      JSON.stringify({ name: "@example-scope/example-nodes", "node-red": { nodes: { example: "index.js" } } })
    );
    const scopeDir = path.join(baseDir, "node_modules", "@example-scope");
    fs.mkdirSync(scopeDir, { recursive: true });
    fs.symlinkSync(realPkgDir, path.join(scopeDir, "example-nodes"), "dir");

    assert.equal(resolveContainerDefaultUserDir(baseDir), baseDir);
    fs.rmSync(realPkgDir, { recursive: true, force: true });
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

/**
 * Unit coverage for `resolveEffectiveUserDir`'s full 4-level precedence
 * order (see #33): explicit `--user-dir` > explicit `--docker-userdir` >
 * the auto-probed `/data` default (only attempted when
 * `probeContainerDefault` is set) > the ephemeral fallback (represented
 * here as `undefined`, since the ephemeral tmpdir itself is created by the
 * caller, `runFlowInvocation`).
 */
test("unit: resolveEffectiveUserDir level 1 -- explicit userDir wins over everything else", () => {
  const result = resolveEffectiveUserDir({
    userDir: "/explicit/user-dir",
    dockerUserDir: "/docker/user-dir",
    probeContainerDefault: true
  });
  assert.deepEqual(result, { userDir: "/explicit/user-dir", persistent: true });
});

test("unit: resolveEffectiveUserDir level 2 -- dockerUserDir wins when userDir is absent", () => {
  const result = resolveEffectiveUserDir({ dockerUserDir: "/docker/user-dir", probeContainerDefault: true });
  assert.deepEqual(result, { userDir: "/docker/user-dir", persistent: true });
});

test("unit: resolveEffectiveUserDir level 3 -- auto-probed /data wins when userDir/dockerUserDir are both absent", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-precedence-probe-"));
  try {
    const pkgDir = path.join(baseDir, "node_modules", "node-red-contrib-example");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "node-red-contrib-example", "node-red": {} })
    );

    const result = resolveEffectiveUserDir({ probeContainerDefault: true, probeBaseDir: baseDir });
    assert.deepEqual(result, { userDir: baseDir, persistent: true });
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("unit: resolveEffectiveUserDir level 3 -- an unusable auto-probe base falls through to level 4 (not persistent)", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-precedence-probe-negative-"));
  try {
    const result = resolveEffectiveUserDir({ probeContainerDefault: true, probeBaseDir: baseDir });
    assert.deepEqual(result, { userDir: undefined, persistent: false });
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("unit: resolveEffectiveUserDir level 3 -- probeContainerDefault false skips the auto-probe even if it would otherwise succeed", () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-precedence-skip-probe-"));
  try {
    const pkgDir = path.join(baseDir, "node_modules", "node-red-contrib-example");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "node-red-contrib-example", "node-red": {} })
    );

    const result = resolveEffectiveUserDir({ probeBaseDir: baseDir });
    assert.deepEqual(result, { userDir: undefined, persistent: false });
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});

test("unit: resolveEffectiveUserDir level 4 -- falls back to undefined/not-persistent when nothing else applies", () => {
  const result = resolveEffectiveUserDir({});
  assert.deepEqual(result, { userDir: undefined, persistent: false });
});
