"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const RED = require("node-red");
const { createHostLinkCaller } = require("../../src/link-call");

const flowsPath = path.join(__dirname, "..", "fixtures", "single-link-in.flows.json");
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-integration-fallback-"));

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

test("integration: omitting the target falls back to the only link-in node against a real runtime, no warning", async () => {
  const warnings = [];
  const caller = createHostLinkCaller(RED);
  try {
    const result = await caller.call(
      undefined,
      { payload: { x: 4, y: 5 } },
      {
        timeout: 2000,
        onWarning: (warning) => warnings.push(warning)
      }
    );

    assert.equal(result.payload, 9);
    assert.deepEqual(warnings, []);
  } finally {
    caller.close();
  }
});
