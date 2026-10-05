"use strict";

const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const cli = path.join(root, "bin/node-red-cli.js");
const fixture = path.join(root, "test/fixtures/single-link-in.flows.json");

function createProject(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-command-"));
  const home = path.join(directory, "home");
  fs.mkdirSync(home);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, cwd: directory, home };
}

function invoke(args, { cwd, home }) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    input: "",
    env: { ...process.env, HOME: home, XDG_CACHE_HOME: path.join(home, ".cache") }
  });
}

function successfulOutput(args, project) {
  const result = invoke(args, project);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), "9");
}

test("legacy and run commands use the same flow invocation", (t) => {
  const project = createProject(t);
  successfulOutput([fixture, "calculate", "--set", "x=4", "--set", "y=5"], project);
  successfulOutput(["run", fixture, "calculate", "--set", "x=4", "--set", "y=5"], project);
});

test("run discovers default and named flow files and honors authoritative flowDir", (t) => {
  const project = createProject(t);
  const workflows = path.join(project.directory, ".workflows");
  fs.mkdirSync(workflows);
  fs.copyFileSync(fixture, path.join(workflows, "flows.json"));
  fs.copyFileSync(fixture, path.join(workflows, "plan.json"));
  successfulOutput(["run", "--set", "x=4", "--set", "y=5"], project);
  successfulOutput(["run", "--flow", "Calculator Example", "--set", "x=4", "--set", "y=5"], project);
  successfulOutput(["run", "plan.json", "--set", "x=4", "--set", "y=5"], project);

  const customDir = path.join(project.directory, "custom");
  fs.mkdirSync(customDir);
  fs.copyFileSync(fixture, path.join(customDir, "plan.json"));
  fs.writeFileSync(path.join(project.directory, "plan.json"), "[]\n");
  successfulOutput(["run", "plan.json", "--flowDir", customDir, "--set", "x=4", "--set", "y=5"], project);
  fs.rmSync(path.join(customDir, "plan.json"));
  const missing = invoke(["run", "plan.json", "--flowDir", customDir], project);
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /flow file not found:/);
});

test("run rejects a missing explicit path instead of discovering the same filename", (t) => {
  const project = createProject(t);
  fs.mkdirSync(path.join(project.directory, ".workflows"));
  fs.copyFileSync(fixture, path.join(project.directory, ".workflows", "plan.json"));
  const result = invoke(["run", "./plan.json"], project);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /flow file not found: .*\/plan\.json/);
});

test("both userDir spellings and flow-json remain available with run", (t) => {
  const project = createProject(t);
  successfulOutput(
    ["run", fixture, "--userDir", path.join(project.directory, "new-user"), "--set", "x=4", "--set", "y=5"],
    project
  );
  successfulOutput(
    ["run", fixture, "--user-dir", path.join(project.directory, "old-user"), "--set", "x=4", "--set", "y=5"],
    project
  );
  const firstUserDir = path.join(project.directory, "first-user");
  const lastUserDir = path.join(project.directory, "last-user");
  successfulOutput(
    ["run", fixture, "--userDir", firstUserDir, "--user-dir", lastUserDir, "--set", "x=4", "--set", "y=5"],
    project
  );
  assert.equal(fs.existsSync(path.join(firstUserDir, ".config.runtime.json")), false);
  assert.equal(fs.existsSync(path.join(lastUserDir, ".config.runtime.json")), true);
  successfulOutput(["run", fixture, "--userDir", "--set", "x=4", "--set", "y=5"], project);
  assert.ok(fs.existsSync(path.join(project.home, ".cache", "node-red-cli")));
  successfulOutput(["run", "--flow-json", `@${fixture}`, "--set", "x=4", "--set", "y=5"], project);
});
