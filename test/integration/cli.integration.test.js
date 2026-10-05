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
  return { directory, home };
}

function invoke(args, project, input = "") {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: project.directory,
    encoding: "utf8",
    input,
    env: { ...process.env, HOME: project.home, XDG_CACHE_HOME: path.join(project.home, ".cache") }
  });
}

function success(args, project, input = "") {
  const result = invoke(args, project, input);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

test("run is mandatory and help exposes only the canonical run options", (t) => {
  const project = createProject(t);
  const rootHelp = invoke(["--help"], project);
  assert.equal(rootHelp.status, 0, rootHelp.stderr);
  assert.match(rootHelp.stdout, /run/);
  assert.doesNotMatch(rootHelp.stdout, /flow-file execution/);
  const legacy = invoke([fixture, "calculate", "--set", "x=4"], project);
  assert.notEqual(legacy.status, 0);
  const help = invoke(["run", "--help"], project);
  assert.equal(help.status, 0, help.stderr);
  for (const flag of ["--tab", "--flow-dir", "--flow-json", "--user-dir", "--docker-user-dir", "--output"]) {
    assert.match(help.stdout, new RegExp(flag));
  }
  for (const flag of ["--flow ", "--flowDir", "--flowJson", "--userDir", "--docker-userdir", "--format"]) {
    assert.doesNotMatch(help.stdout, new RegExp(flag));
  }
});

test("flow-file resolution uses cwd, flow-dir, defaults, and exact paths without discovery", (t) => {
  const project = createProject(t);
  fs.copyFileSync(fixture, path.join(project.directory, "flows.json"));
  assert.equal(success(["run", "--set", "x=4", "--set", "y=5"], project), "9");
  fs.unlinkSync(path.join(project.directory, "flows.json"));
  const hidden = path.join(project.directory, ".workflows");
  fs.mkdirSync(hidden);
  fs.copyFileSync(fixture, path.join(hidden, "plan.json"));
  assert.notEqual(invoke(["run", "plan.json"], project).status, 0);
  assert.equal(
    success(["run", "plan.json", "--flow-dir", hidden, "--set", "x=4", "--set", "y=5"], project),
    "9"
  );
  assert.equal(success(["run", "./.workflows/plan.json", "--set", "x=4", "--set", "y=5"], project), "9");
  assert.notEqual(invoke(["run", "./missing.json"], project).status, 0);
  assert.notEqual(invoke(["run", "--flow-dir", path.join(project.directory, "missing")], project).status, 0);
});

test("tab, entry inference, flow-json forms, and output modes work", (t) => {
  const project = createProject(t);
  assert.equal(
    success(
      ["run", fixture, "calculate", "--tab", "Calculator Example", "--set", "x=4", "--set", "y=5"],
      project
    ),
    "9"
  );
  assert.equal(success(["run", fixture, "--set", "x=4", "--set", "y=5"], project), "9");
  assert.equal(
    success(["run", fixture, "--output", "payload", "--set", "x=4", "--set", "y=5"], project),
    "9"
  );
  const inline = fs.readFileSync(fixture, "utf8").trim();
  assert.equal(
    success(["run", "--flow-json", inline, "calculate", "--set", "x=4", "--set", "y=5"], project),
    "9"
  );
  assert.equal(
    success(["run", "--flow-json", "-", "calculate", "--set", "x=4", "--set", "y=5"], project, inline),
    "9"
  );
  assert.notEqual(invoke(["run", "--flow-json", `@${fixture}`], project).status, 0);
  const mutuallyExclusive = invoke(["run", "--flow-json", inline, fixture, "calculate"], project);
  assert.notEqual(mutuallyExclusive.status, 0);
  assert.match(mutuallyExclusive.stderr, /flow-file and --flow-json are mutually exclusive/);
  const message = JSON.parse(
    success(["run", fixture, "calculate", "--output", "message", "--set", "x=4", "--set", "y=5"], project)
  );
  assert.equal(message.payload, 9);
  assert.notEqual(invoke(["run", fixture, "--output", "invalid"], project).status, 0);
  for (const flag of ["--flow", "--flowJson", "--flowDir", "--userDir", "--docker-userdir", "--format"]) {
    assert.notEqual(invoke(["run", fixture, flag], project).status, 0, `${flag} should be rejected`);
  }
});

test("canonical user-dir preserves explicit and stable-cache behavior", (t) => {
  const project = createProject(t);
  const userDir = path.join(project.directory, "user-dir");
  assert.equal(
    success(["run", fixture, "--user-dir", userDir, "--set", "x=4", "--set", "y=5"], project),
    "9"
  );
  assert.ok(fs.existsSync(path.join(userDir, ".config.runtime.json")));
  assert.equal(success(["run", fixture, "--user-dir", "--set", "x=4", "--set", "y=5"], project), "9");
  assert.ok(fs.existsSync(path.join(project.home, ".cache", "node-red-cli")));
});
