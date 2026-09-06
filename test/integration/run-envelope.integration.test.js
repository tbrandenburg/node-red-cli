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

/**
 * Regression coverage for issue #28: a v0.2.14 report that flows using the
 * `agent` node (node-red-agents) deterministically fail with "Circular
 * config node dependency" / "not instantiated", even though the flow is
 * otherwise valid and deployed fine on v0.2.12/v0.2.13.
 *
 * Root cause (confirmed against the real `@tbrandenburg/node-red-agents`
 * package, and reproducible with only core node types as below): Node-RED's
 * flow parser (`@node-red/runtime/lib/flows/util.js`) classifies *any* node
 * lacking both `x` and `y` as a global config node, regardless of its
 * actual type -- and the README's own hand-authored `--flow-json` `agent`
 * example (like this fixture) omits those editor-only coordinates. A wired
 * node misclassified as a config node undergoes `Flow.js`'s config-node
 * circular-dependency scan, which throws "Circular config node dependency
 * detected" the moment one of its own property values happens to equal
 * another node's id -- including its own id, e.g. a node whose `name`
 * equals its own `id` (exactly what this fixture, and the README example,
 * both do). That aborts the whole flow's instantiation, which is what
 * previously made the *unrelated* `waitForFlowsSettled` race a prime
 * suspect: the target/return nodes end up "not instantiated" either way.
 * This flow is otherwise entirely valid and must deploy and succeed exactly
 * as it did before v0.2.14.
 */
const SELF_NAMED_LINK_FLOW = [
  { id: "tab", type: "tab", label: "t" },
  { id: "ask", type: "link in", z: "tab", name: "ask", wires: [["return"]] },
  { id: "return", type: "link out", z: "tab", name: "return", mode: "return" }
];

test("integration: runFlowInvocation deploys and calls a flow whose nodes omit editor x/y coordinates (issue #28)", async () => {
  const result = await runFlowInvocation({
    flow: SELF_NAMED_LINK_FLOW,
    msg: { payload: "hi" },
    options: { target: "ask", timeoutMs: 5000, format: "json" }
  });
  assert.deepEqual(JSON.parse(result.output).payload, "hi");
});
