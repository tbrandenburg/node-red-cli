"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const RED = require("node-red");
const { createHostLinkCaller, resolveFlow, validateTarget } = require("../src/link-call");

const root = __dirname;
const flowsPath = path.join(root, "fixtures", "flows.json");
const flowHashBefore = crypto.createHash("sha256").update(fs.readFileSync(flowsPath)).digest("hex");
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "nr-call-test-"));

async function main() {
  RED.init({
    flowFile: flowsPath,
    userDir,
    httpAdminRoot: false,
    httpNodeRoot: false,
    credentialSecret: "test-not-for-production",
    editorTheme: { projects: { enabled: false } },
    logging: { console: { level: "warn", metrics: false, audit: false } }
  });

  let caller;
  try {
    // RED.start() deliberately resolves before asynchronous flow loading has
    // finished. Do not inspect RED.nodes until the deployed flow is active.
    const flowsStarted = new Promise((resolve) => RED.events.once("flows:started", resolve));
    await RED.start();
    await flowsStarted;

    const selectedFlow = resolveFlow(RED);
    assert.equal(selectedFlow.ok, true, selectedFlow.errors.join("; "));
    assert.equal(selectedFlow.flow.id, "calculator");
    assert.equal(selectedFlow.selectedBy, "fallback");

    const valid = validateTarget(RED, "calculate", { flow: "Calculator Example" });
    assert.equal(valid.ok, true, valid.errors.join("; "));
    assert.equal(valid.flowId, "calculator");
    assert.equal(valid.targetId, "calculate");
    assert.ok(valid.returnLinkOutIds.includes("return"));

    const invalid = validateTarget(RED, "missing-target", { flow: "calculator" });
    assert.equal(invalid.ok, false);
    assert.match(invalid.errors.join("\n"), /not present in flow/);

    caller = createHostLinkCaller(RED);

    const result = await caller.call("calculate", { payload: { x: 4, y: 5 } }, { flow: "calculator" });
    assert.deepEqual(result, { payload: 9, _msgid: result._msgid });
    assert.equal(result._linkSource, undefined);
    assert.equal(typeof result._msgid, "string");

    await assert.rejects(
      caller.call("slow", { payload: "x" }, { timeout: 50 }),
      /timed out after 50 ms/
    );

    const flowHashAfter = crypto.createHash("sha256").update(fs.readFileSync(flowsPath)).digest("hex");
    assert.equal(flowHashAfter, flowHashBefore, "the flow file must remain unchanged");

    console.log(JSON.stringify({ result, preflight: "verified", timeout: "verified", flowMutation: "none" }));
  } finally {
    caller?.close();
    await RED.stop();
    fs.rmSync(userDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
