"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { after, before, test } = require("node:test");
const RED = require("node-red");
const { createHostLinkCaller } = require("../../src/link-call");
const { createMemoryStorageModule } = require("../../src/flow-storage");

const flowsPath = path.join(__dirname, "..", "fixtures", "flows.json");
const flows = JSON.parse(fs.readFileSync(flowsPath, "utf8"));
const userDir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-flowstorage-"));

let caller;

before(async () => {
  RED.init({
    storageModule: createMemoryStorageModule(flows),
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

  caller = createHostLinkCaller(RED);
});

after(async () => {
  caller?.close();
  await RED.stop();
  fs.rmSync(userDir, { recursive: true, force: true });
});

test("integration: RED.nodes.eachNode sees the in-memory flow after RED.init/RED.start", () => {
  const configs = new Map();
  RED.nodes.eachNode((config) => configs.set(config.id, config));

  for (const node of flows) {
    assert.ok(configs.has(node.id), `expected node '${node.id}' to be loaded`);
  }
});

test("integration: a link call round trips through the in-memory flow with no flow file on disk", async () => {
  const result = await caller.call("calculate", { payload: { x: 4, y: 5 } }, { flow: "calculator" });
  assert.deepEqual(result, { payload: 9, _msgid: result._msgid });
});

test("integration: no flow file is written to userDir by the in-memory storage module", () => {
  const flowsFile = path.join(userDir, "flows_" + path.basename(userDir) + ".json");
  assert.equal(fs.existsSync(flowsFile), false);
  const entries = fs.readdirSync(userDir).filter((name) => name.endsWith(".json"));
  assert.deepEqual(entries, [], `expected no JSON files written to userDir, found: ${entries}`);
});
