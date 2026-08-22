"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { after, before, test } = require("node:test");
const RED = require("node-red");
const { createHostLinkCaller, resolveFlow, validateTarget } = require("../../src/link-call");

/** Run the CLI as a subprocess, piping `input` to stdin and collecting output. */
function runCli(args, input) {
  return new Promise((resolve, reject) => {
    const cliPath = path.join(__dirname, "..", "..", "bin", "node-red-cli.js");
    const child = spawn(process.execPath, [cliPath, ...args]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

// This is the original flow used while designing the host-link-call adapter.
// It now serves as a durable test asset: a minimal, real Node-RED flow with
// a fast `calculate` path and a deliberately slow `slow` path for exercising
// the timeout behavior end to end.
const flowsPath = path.join(__dirname, "..", "fixtures", "flows.json");
const flowHashBefore = crypto.createHash("sha256").update(fs.readFileSync(flowsPath)).digest("hex");
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-e2e-"));

let caller;

before(async () => {
  RED.init({
    flowFile: flowsPath,
    userDir,
    httpAdminRoot: false,
    httpNodeRoot: false,
    credentialSecret: "test-not-for-production",
    editorTheme: { projects: { enabled: false } },
    logging: { console: { level: "warn", metrics: false, audit: false } }
  });

  // RED.start() deliberately resolves before asynchronous flow loading has
  // finished. Do not inspect RED.nodes until the deployed flow is active.
  const flowsStarted = new Promise((resolve) => RED.events.once("flows:started", resolve));
  await RED.start();
  await flowsStarted;

  caller = createHostLinkCaller(RED);
});

after(async () => {
  caller?.close();
  await RED.stop();
  fs.rmSync(userDir, { recursive: true, force: true });
});

test("e2e: calls calculate through the real Node-RED runtime and gets the sum back", async () => {
  const selectedFlow = resolveFlow(RED);
  assert.equal(selectedFlow.ok, true, selectedFlow.errors.join("; "));
  assert.equal(selectedFlow.flow.id, "calculator");

  const valid = validateTarget(RED, "calculate", { flow: "Calculator Example" });
  assert.equal(valid.ok, true, valid.errors.join("; "));
  assert.ok(valid.returnLinkOutIds.includes("return"));

  const result = await caller.call("calculate", { payload: { x: 4, y: 5 } }, { flow: "calculator" });
  assert.deepEqual(result, { payload: 9, _msgid: result._msgid });
  assert.equal(result._linkSource, undefined);
});

test("e2e: preflight validation rejects an unknown target before the flow runs", () => {
  const invalid = validateTarget(RED, "missing-target", { flow: "calculator" });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join("\n"), /not present in flow/);
});

test("e2e: a non-terminating flow rejects with a timeout", async () => {
  await assert.rejects(caller.call("slow", { payload: "x" }, { timeout: 50 }), /timed out after 50 ms/);
});

test("e2e: the flow file is never mutated by a call", () => {
  const flowHashAfter = crypto.createHash("sha256").update(fs.readFileSync(flowsPath)).digest("hex");
  assert.equal(flowHashAfter, flowHashBefore, "the flow file must remain unchanged");
});

test("e2e: the CLI falls back to the only link-in node when target is omitted", async () => {
  const singleFlowsPath = path.join(__dirname, "..", "fixtures", "single-link-in.flows.json");
  const { code, stdout, stderr } = await runCli(
    [singleFlowsPath],
    JSON.stringify({ payload: { x: 4, y: 5 } })
  );

  assert.equal(code, 0, stderr);
  assert.equal(stdout.trim(), "9");
});

test("e2e: --set key=value params map onto payload attributes without any stdin", async () => {
  const { code, stdout, stderr } = await runCli([flowsPath, "calculate", "--set", "x=4", "--set", "y=5"], "");

  assert.equal(code, 0, stderr);
  assert.equal(stdout.trim(), "9");
});

test("e2e: --set key=value params override matching keys from a stdin payload", async () => {
  const { code, stdout, stderr } = await runCli(
    [flowsPath, "calculate", "--set", "y=10"],
    JSON.stringify({ payload: { x: 4, y: 5 } })
  );

  assert.equal(code, 0, stderr);
  assert.equal(stdout.trim(), "14");
});

test("e2e: stdout carries only the plain-text payload by default, Node-RED runtime logs go to stderr", async () => {
  const { code, stdout, stderr } = await runCli(
    [flowsPath, "calculate"],
    JSON.stringify({ payload: { x: 4, y: 5 } })
  );

  assert.equal(code, 0, stderr);
  assert.equal(stdout.trim().split("\n").length, 1, `expected a single line, got:\n${stdout}`);
  assert.equal(stdout.trim(), "9");
  assert.match(stderr, /\[warn\]/);
});

test("e2e: --format=plain behaves the same as the default (no --format)", async () => {
  const { code, stdout, stderr } = await runCli(
    [flowsPath, "calculate", "--format=plain"],
    JSON.stringify({ payload: { x: 4, y: 5 } })
  );

  assert.equal(code, 0, stderr);
  assert.equal(stdout.trim(), "9");
});

test("e2e: --format=json prints the full result object as JSON", async () => {
  const { code, stdout, stderr } = await runCli(
    [flowsPath, "calculate", "--format=json"],
    JSON.stringify({ payload: { x: 4, y: 5 } })
  );

  assert.equal(code, 0, stderr);
  assert.equal(JSON.parse(stdout).payload, 9);
});

test("e2e: --version prints the package version and exits without requiring a flow file", async () => {
  const { version } = require("../../package.json");
  const { code, stdout, stderr } = await runCli(["--version"], "");

  assert.equal(code, 0, stderr);
  assert.equal(stdout.trim(), version);
});

test("e2e: -v prints the package version and exits without requiring a flow file", async () => {
  const { version } = require("../../package.json");
  const { code, stdout, stderr } = await runCli(["-v"], "");

  assert.equal(code, 0, stderr);
  assert.equal(stdout.trim(), version);
});

test("e2e: an invalid --format value fails with a clear error and no stdout output", async () => {
  const { code, stdout, stderr } = await runCli(
    [flowsPath, "calculate", "--format=xml"],
    JSON.stringify({ payload: { x: 4, y: 5 } })
  );

  assert.notEqual(code, 0);
  assert.equal(stdout, "");
  assert.match(stderr, /invalid --format value 'xml'/);
});
