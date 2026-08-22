"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const RED = require("node-red");
const { createHostLinkCaller } = require("../../src/link-call");

const flowsPath = path.join(__dirname, "..", "fixtures", "flows.json");
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-integration-"));

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

test("integration: omitting the target rejects with a clear error when several link-in nodes are present", async () => {
  const caller = createHostLinkCaller(RED);
  try {
    await assert.rejects(
      caller.call(undefined, { payload: { x: 1, y: 2 } }, { timeout: 2000 }),
      /target must be specified because 2 link-in nodes are present/
    );
  } finally {
    caller.close();
  }
});
