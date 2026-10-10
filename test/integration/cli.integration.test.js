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
  fs.copyFileSync(fixture, path.join(project.directory, "flows.json"));
  const emptyFlowJson = invoke(["run", "--flow-json", ""], project);
  assert.notEqual(emptyFlowJson.status, 0);
  assert.match(emptyFlowJson.stderr, /invalid JSON from --flow-json value/);
  const emptyFlowJsonWithFile = invoke(["run", "--flow-json", "", "flows.json", "calculate"], project);
  assert.notEqual(emptyFlowJsonWithFile.status, 0);
  assert.match(emptyFlowJsonWithFile.stderr, /flow-file and --flow-json are mutually exclusive/);
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

test("inspect emits static inventory and bounded graph JSON without runtime state", (t) => {
  const project = createProject(t);
  const inspectFixture = path.join(root, "test/fixtures/inspect.flows.json");
  const help = invoke(["--help"], project);
  assert.match(help.stdout, /inspect/);
  const inspectHelp = invoke(["inspect", "--help"], project);
  assert.equal(inspectHelp.status, 0, inspectHelp.stderr);
  assert.match(inspectHelp.stdout, /inspect \[options\]/);
  for (const option of ["--tab", "--flow-dir", "--depth", "--json"])
    assert.match(inspectHelp.stdout, new RegExp(option));
  for (const option of ["--docker", "--user-dir", "--node-modules", "--output", "--raw"])
    assert.doesNotMatch(inspectHelp.stdout, new RegExp(option));
  assert.match(inspectHelp.stdout, /--flow-json <json\|->/);
  assert.match(inspectHelp.stdout, /first positional is \[entry\]/);
  const rawInventory = invoke(["inspect", inspectFixture, "--json"], project);
  assert.equal(rawInventory.status, 0, rawInventory.stderr);
  assert.equal(rawInventory.stderr, "");
  const inventory = JSON.parse(rawInventory.stdout);
  assert.equal(inventory.source.kind, "file");
  assert.equal(inventory.source.path, path.resolve(inspectFixture));
  assert.equal(inventory.graph, null);
  assert.equal(inventory.entries.length, 2);
  const graph = JSON.parse(success(["inspect", inspectFixture, "entry", "--depth", "8", "--json"], project));
  assert.ok(graph.graph.nodes.some((node) => node.sourceId === "junction"));
  assert.ok(graph.graph.edges.some((edge) => edge.kind === "call-dynamic" && edge.to === null));
  assert.ok(graph.warnings.some((warning) => warning.includes("missing")));
  assert.notEqual(invoke(["inspect", inspectFixture, "--depth", "2"], project).status, 0);
  assert.notEqual(invoke(["inspect", inspectFixture, "entry", "--depth", "1.5"], project).status, 0);
  assert.deepEqual(fs.readdirSync(project.home), []);
});

test("inspect accepts inline and stdin flow JSON without runtime files", (t) => {
  const project = createProject(t);
  const inline = fs.readFileSync(fixture, "utf8").trim();
  const inlinePretty = success(["inspect", "--flow-json", inline], project);
  assert.match(inlinePretty, /Flow: \[inline JSON\]/);
  assert.match(inlinePretty, /Calculator Example/);
  const inlineInventory = JSON.parse(success(["inspect", "--flow-json", inline, "--json"], project));
  assert.deepEqual(inlineInventory.source, { path: null, kind: "inline" });
  assert.equal(inlineInventory.graph, null);
  const inlineGraph = JSON.parse(
    success(["inspect", "--flow-json", inline, "calculate", "--depth", "2", "--json"], project)
  );
  assert.ok(inlineGraph.graph.nodes.some((node) => node.sourceId === "add"));
  const stdinPretty = success(["inspect", "--flow-json", "-"], project, inline);
  assert.match(stdinPretty, /Flow: \[stdin\]/);
  const stdinInventory = JSON.parse(success(["inspect", "--flow-json", "-", "--json"], project, inline));
  assert.deepEqual(stdinInventory.source, { path: null, kind: "stdin" });
  const stdinGraph = JSON.parse(
    success(["inspect", "calculate", "--flow-json", "-", "--depth", "2", "--json"], project, inline)
  );
  assert.equal(stdinGraph.graph.depth, 2);
  assert.ok(stdinGraph.graph.nodes.some((node) => node.sourceId === "add"));
  const rootOnly = JSON.parse(
    success(["inspect", "calculate", "--flow-json", "-", "--depth", "0", "--json"], project, inline)
  );
  assert.equal(rootOnly.graph.nodes.length, 1);
  for (const args of [
    ["inspect", "file.json", "calculate", "--flow-json", inline],
    ["inspect", "--flow-json", inline, "--flow-dir", project.directory],
    ["inspect", "--flow-json", ""],
    ["inspect", "--flow-json", "not JSON"],
    ["inspect", "--flow-json", "{}"],
    ["inspect", "--flow-json", "null"],
    ["inspect", "--flow-json", `@${fixture}`],
    ["inspect", "--flow-json", inline, "--depth", "2"]
  ])
    assert.notEqual(invoke(args, project).status, 0, args.join(" "));
  const invalidStdin = invoke(["inspect", "--flow-json", "-"], project, "not JSON");
  assert.notEqual(invalidStdin.status, 0);
  assert.deepEqual(fs.readdirSync(project.home), []);
});

test("inspect reuses exact flow resolution and applies tab/depth selection", (t) => {
  const project = createProject(t);
  const flowDir = path.join(project.directory, "source");
  fs.mkdirSync(flowDir);
  fs.copyFileSync(path.join(root, "test/fixtures/inspect.flows.json"), path.join(flowDir, "plan.json"));
  const inventory = JSON.parse(
    success(["inspect", "plan.json", "--flow-dir", flowDir, "--tab", "Public", "--json"], project)
  );
  assert.deepEqual(
    inventory.tabs.map((tab) => tab.id),
    ["tab-a"]
  );
  assert.deepEqual(
    inventory.entries.map((entry) => entry.id),
    ["entry"]
  );
  fs.copyFileSync(path.join(flowDir, "plan.json"), path.join(project.directory, "explicit.json"));
  assert.equal(JSON.parse(success(["inspect", "./explicit.json", "--json"], project)).entries.length, 2);
  const rootOnly = JSON.parse(
    success(["inspect", "./explicit.json", "entry", "--depth", "0", "--json"], project)
  );
  assert.equal(rootOnly.graph.nodes.length, 1);
  fs.writeFileSync(path.join(project.directory, "bad.json"), "{}");
  assert.notEqual(invoke(["inspect", "bad.json"], project).status, 0);
  fs.writeFileSync(path.join(project.directory, "malformed.json"), "not JSON");
  assert.notEqual(invoke(["inspect", "malformed.json"], project).status, 0);
  const sole = JSON.parse(success(["inspect", fixture, "--json"], project));
  assert.equal(sole.entries.length, 1);
  assert.equal(sole.graph, null);
  assert.notEqual(invoke(["inspect", "./absent.json"], project).status, 0);
});
