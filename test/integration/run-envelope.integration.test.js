"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { runFlowInvocation } = require("../../src/run-envelope");

const UNREGISTERED_TYPE_FLOW = [
  { id: "tab", type: "tab", label: "t" },
  { id: "ask", type: "link in", z: "tab", name: "ask", wires: [["missing"]] },
  { id: "missing", type: "totally-unregistered-node-type", z: "tab", name: "m", wires: [["return"]] },
  { id: "return", type: "link out", z: "tab", name: "return", mode: "return" }
];

/**
 * Regression coverage for issue #23: a flow referencing a node type that
 * isn't registered in userDir must fail with the same clear preflight
 * error and a rejected promise in both ephemeral (no userDir) and
 * persistent (explicit userDir) modes -- not silently resolve/exit with
 * empty output. Node-RED never emits `flows:started` when a flow has
 * missing types (see `waitForFlowsSettled` in src/run-envelope.js), so
 * this exercises the real embedded runtime end to end.
 */
test("integration: runFlowInvocation rejects with preflight error for an unregistered node type (ephemeral userDir)", async () => {
  await assert.rejects(
    runFlowInvocation({
      flow: UNREGISTERED_TYPE_FLOW,
      msg: { payload: "hi" },
      options: { target: "ask", timeoutMs: 5000, format: "json" }
    }),
    /preflight validation failed:\n- target 'ask' is not instantiated in the runtime/
  );
});

test("integration: runFlowInvocation rejects with preflight error for an unregistered node type (persistent userDir)", async () => {
  const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-run-envelope-"));
  try {
    await assert.rejects(
      runFlowInvocation({
        flow: UNREGISTERED_TYPE_FLOW,
        msg: { payload: "hi" },
        options: { target: "ask", timeoutMs: 5000, format: "json", userDir }
      }),
      /preflight validation failed:\n- target 'ask' is not instantiated in the runtime/
    );
  } finally {
    fs.rmSync(userDir, { recursive: true, force: true });
  }
});
