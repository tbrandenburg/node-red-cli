"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { isExplicitPath, resolveFlowFile } = require("../../src/flow-file");

function temporaryDirectories() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-flow-file-"));
  const cwd = path.join(root, "project");
  const homeDir = path.join(root, "home");
  fs.mkdirSync(cwd);
  fs.mkdirSync(homeDir);
  return { root, cwd, homeDir };
}

function writeFlow(directory, filename) {
  fs.mkdirSync(directory, { recursive: true });
  const filePath = path.join(directory, filename);
  fs.writeFileSync(filePath, "[]\n");
  return filePath;
}

test("flow-file resolution uses exact explicit relative and absolute paths", (t) => {
  const dirs = temporaryDirectories();
  t.after(() => fs.rmSync(dirs.root, { recursive: true, force: true }));
  const relative = writeFlow(path.join(dirs.cwd, "nested"), "plan.json");
  assert.equal(isExplicitPath("./nested/plan.json"), true);
  assert.equal(resolveFlowFile({ flowFileArg: "./nested/plan.json", ...dirs }), relative);
  assert.equal(resolveFlowFile({ flowFileArg: relative, ...dirs }), relative);
  writeFlow(path.join(dirs.cwd, ".workflows"), "missing.json");
  assert.throws(
    () => resolveFlowFile({ flowFileArg: "./missing.json", ...dirs }),
    new RegExp(`flow file not found: ${path.join(dirs.cwd, "missing.json")}`)
  );
});

test("bare file discovery uses the declared precedence from project to home", (t) => {
  const dirs = temporaryDirectories();
  t.after(() => fs.rmSync(dirs.root, { recursive: true, force: true }));
  const cwdMatch = writeFlow(dirs.cwd, "plan.json");
  writeFlow(path.join(dirs.cwd, "data"), "plan.json");
  assert.equal(resolveFlowFile({ flowFileArg: "plan.json", ...dirs }), cwdMatch);

  fs.rmSync(cwdMatch);
  const projectLocations = [
    "data",
    ".node-red",
    ".workflows",
    ".node-red-cli",
    "node-red",
    "workflows",
    "node-red-cli"
  ];
  const projectMatches = projectLocations.map((directory) =>
    writeFlow(path.join(dirs.cwd, directory), "plan.json")
  );
  const homeLocations = [".node-red", ".node-red-cli", ".workflows"];
  const homeMatches = homeLocations.map((directory) =>
    writeFlow(path.join(dirs.homeDir, directory), "plan.json")
  );
  assert.equal(resolveFlowFile({ flowFileArg: "plan.json", ...dirs }), projectMatches[0]);
  for (let index = 1; index < projectMatches.length; index += 1) {
    fs.rmSync(projectMatches[index - 1]);
    assert.equal(resolveFlowFile({ flowFileArg: "plan.json", ...dirs }), projectMatches[index]);
  }
  for (const filePath of projectMatches) fs.rmSync(filePath, { force: true });
  assert.equal(resolveFlowFile({ flowFileArg: "plan.json", ...dirs }), homeMatches[0]);
  for (let index = 1; index < homeMatches.length; index += 1) {
    fs.rmSync(homeMatches[index - 1]);
    assert.equal(resolveFlowFile({ flowFileArg: "plan.json", ...dirs }), homeMatches[index]);
  }
});

test("flowDir is authoritative and omitted filename resolves flows.json", (t) => {
  const dirs = temporaryDirectories();
  t.after(() => fs.rmSync(dirs.root, { recursive: true, force: true }));
  const flowDir = path.join(dirs.root, "custom");
  const filePath = writeFlow(flowDir, "flows.json");
  assert.equal(resolveFlowFile({ ...dirs, flowDir }), filePath);
  writeFlow(path.join(dirs.cwd, ".workflows"), "absent.json");
  assert.throws(
    () => resolveFlowFile({ ...dirs, flowDir, flowFileArg: "absent.json" }),
    new RegExp(`flow file not found: ${path.join(flowDir, "absent.json")}`)
  );
  assert.throws(
    () => resolveFlowFile({ ...dirs, flowFileArg: "not-there.json" }),
    /flow file not found: 'not-there\.json' in the flow lookup locations/
  );
});
