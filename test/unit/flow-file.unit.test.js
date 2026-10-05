"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { isExplicitPath, resolveFlowFile } = require("../../src/flow-file");

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-flow-file-"));
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, cwd };
}

function writeFlow(directory, name = "flows.json") {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, name);
  fs.writeFileSync(file, "[]\n");
  return file;
}

test("omitted flow-file resolves flows.json in cwd or flow-dir", (t) => {
  const dirs = project(t);
  const cwdFlow = writeFlow(dirs.cwd);
  assert.equal(resolveFlowFile(dirs), cwdFlow);
  const flowDir = path.join(dirs.root, "flows");
  const flowDirFile = writeFlow(flowDir);
  assert.equal(resolveFlowFile({ ...dirs, flowDir }), flowDirFile);
});

test("bare filename resolves only in cwd unless flow-dir is supplied", (t) => {
  const dirs = project(t);
  const cwdFlow = writeFlow(dirs.cwd, "plan.json");
  const hiddenFlow = writeFlow(path.join(dirs.cwd, ".workflows"), "hidden.json");
  assert.equal(resolveFlowFile({ ...dirs, flowFileArg: "plan.json" }), cwdFlow);
  assert.throws(() => resolveFlowFile({ ...dirs, flowFileArg: "hidden.json" }), /flow file not found:/);
  const flowDir = path.join(dirs.root, "custom");
  const customFlow = writeFlow(flowDir, "plan.json");
  assert.equal(resolveFlowFile({ ...dirs, flowFileArg: "plan.json", flowDir }), customFlow);
  assert.throws(
    () => resolveFlowFile({ ...dirs, flowFileArg: "hidden.json", flowDir }),
    /flow file not found:/
  );
  assert.ok(fs.existsSync(hiddenFlow));
});

test("invalid flow-dir is reported and explicit path resolution never falls back", (t) => {
  const dirs = project(t);
  assert.throws(() => resolveFlowFile({ ...dirs, flowDir: "missing-dir" }), /flow directory not found:/);
  const file = writeFlow(dirs.root, "not-a-dir");
  assert.throws(() => resolveFlowFile({ ...dirs, flowDir: file }), /flow directory is not a directory:/);
  writeFlow(path.join(dirs.cwd, ".workflows"), "absent.json");
  assert.throws(
    () => resolveFlowFile({ ...dirs, flowFileArg: "./absent.json" }),
    new RegExp(`flow file not found: ${path.join(dirs.cwd, "absent.json")}`)
  );
});

test("explicit relative and absolute paths resolve exactly and paths must be regular files", (t) => {
  const dirs = project(t);
  const relative = writeFlow(path.join(dirs.cwd, "nested"), "plan.json");
  assert.equal(resolveFlowFile({ ...dirs, flowFileArg: "nested/plan.json" }), relative);
  assert.equal(resolveFlowFile({ ...dirs, flowFileArg: relative }), relative);
  assert.throws(() => resolveFlowFile({ ...dirs, flowFileArg: dirs.cwd }), /not a regular file:/);
});

test("path detection recognizes POSIX and Windows separators without dot-name heuristics", () => {
  assert.equal(isExplicitPath("plan.json"), false);
  assert.equal(isExplicitPath(".plan.json"), false);
  assert.equal(isExplicitPath("nested/plan.json"), true);
  assert.equal(isExplicitPath("nested\\plan.json"), true);
  assert.equal(isExplicitPath("/tmp/plan.json"), true);
});
