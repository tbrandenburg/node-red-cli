"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { applyWorkingDirectory, resolveWorkingDirectory } = require("../../src/working-dir");

test("working directory resolves once from the original cwd without tilde expansion", () => {
  assert.equal(resolveWorkingDirectory(undefined, "/caller"), undefined);
  assert.equal(resolveWorkingDirectory("project", "/caller"), path.resolve("/caller/project"));
  assert.equal(resolveWorkingDirectory("/project", "/caller"), path.resolve("/project"));
  assert.equal(resolveWorkingDirectory("~/project", "/caller"), path.resolve("/caller/~/project"));
});

test("working directory rejects missing paths and regular files", (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-working-dir-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, "plan.json");
  fs.writeFileSync(file, "{}");

  assert.throws(() => applyWorkingDirectory(path.join(directory, "missing")), /working directory not found:/);
  assert.throws(() => applyWorkingDirectory(file), /not a working directory:/);
});
