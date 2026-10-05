"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const RED = require("node-red");
const { createHostLinkCaller } = require("../../src/link-call");

const flowsPath = path.join(__dirname, "..", "fixtures", "flows.json");
const nativeFlowsPath = path.join(__dirname, "..", "fixtures", "native-cross-tab.flows.json");
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-integration-"));
const combinedFlowsPath = path.join(userDir, "flows.json");
fs.writeFileSync(
  combinedFlowsPath,
  JSON.stringify([
    ...JSON.parse(fs.readFileSync(flowsPath, "utf8")),
    ...JSON.parse(fs.readFileSync(nativeFlowsPath, "utf8"))
  ])
);

before(async () => {
  RED.init({
    flowFile: combinedFlowsPath,
    userDir,
    httpAdminRoot: false,
    httpNodeRoot: false,
    credentialSecret: "test-not-for-production",
    editorTheme: { projects: { enabled: false } },
    logging: { console: { level: "warn", metrics: false, audit: false } }
  });

  const flowsStarted = new Promise((resolve) => RED.events.once("flows:started", resolve));
  await RED.start();
  await flowsStarted;
});

after(async () => {
  await RED.stop();
  fs.rmSync(userDir, { recursive: true, force: true });
});

test("integration: close() rejects calls still pending against the real runtime", async () => {
  const caller = createHostLinkCaller(RED);
  const pending = caller.call("slow", { payload: "x" }, { timeout: 5000 });

  caller.close(new Error("shutting down"));

  await assert.rejects(pending, /shutting down/);

  // Let the in-flight "slow" flow finish naturally before the runtime stops,
  // so its delayed callback does not fire against an already-stopped RED.
  await new Promise((resolve) => setTimeout(resolve, 200));
});

test("integration: concurrent calls to different targets resolve independently", async () => {
  const caller = createHostLinkCaller(RED);
  try {
    const [sum, slow] = await Promise.all([
      caller.call("calculate", { payload: { x: 10, y: 32 } }, { timeout: 2000 }),
      caller.call("slow", { payload: "keep" }, { timeout: 2000 })
    ]);

    assert.equal(sum.payload, 42);
    assert.equal(slow.payload, "keep");
  } finally {
    caller.close();
  }
});

test("integration: explicit target ID works without a flow selector in a multi-tab runtime", async () => {
  const caller = createHostLinkCaller(RED);
  try {
    const result = await caller.call("calculate", { payload: { x: 13, y: 8 } }, { timeout: 2000 });
    assert.equal(result.payload, 21);
  } finally {
    caller.close();
  }
});

test("integration: native links and subflow execute and return to host", async () => {
  const caller = createHostLinkCaller(RED);
  try {
    const input = { input: { a: 13.75, b: -8 } };
    const unscoped = await caller.call("entry", input, { timeout: 2000 });
    const scoped = await caller.call("entry", input, { flow: "first", timeout: 2000 });
    assert.equal(unscoped.payload, -110);
    assert.equal(scoped.payload, -110);
  } finally {
    caller.close();
  }
});

test("integration: a return Link Out inside a subflow resolves the host call", async () => {
  const caller = createHostLinkCaller(RED);
  try {
    const result = await caller.call("return-entry", { payload: "input" }, { timeout: 2000 });
    assert.equal(result.payload, "returned-from-subflow");
  } finally {
    caller.close();
  }
});

test("integration: nested native Link Call unwinds before the host return", async () => {
  const caller = createHostLinkCaller(RED);
  try {
    const result = await caller.call("nested-entry", { payload: "input" }, { timeout: 2000 });
    assert.equal(result.payload, "nested-complete");
  } finally {
    caller.close();
  }
});

test("integration: no-return entries time out and only the first return resolves a call", async () => {
  const caller = createHostLinkCaller(RED);
  try {
    await assert.rejects(
      caller.call("timeout-entry", { payload: "input" }, { timeout: 30 }),
      /link call timed out after 30 ms/
    );
    const result = await caller.call("duplicate-entry", { payload: "input" }, { timeout: 2000 });
    assert.equal(result.payload, "first");
  } finally {
    caller.close();
  }
});

test("integration: omitting the target rejects with a clear error when several link-in nodes are present", async () => {
  const caller = createHostLinkCaller(RED);
  try {
    await assert.rejects(
      caller.call(undefined, { payload: { x: 1, y: 2 } }, { timeout: 2000 }),
      /target must be specified because \d+ link-in nodes are present/
    );
  } finally {
    caller.close();
  }
});
