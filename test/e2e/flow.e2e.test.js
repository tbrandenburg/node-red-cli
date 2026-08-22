"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const RED = require("node-red");
const { createHostLinkCaller, resolveFlow, validateTarget } = require("../../src/link-call");

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
