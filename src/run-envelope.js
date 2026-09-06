"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const RED = require("node-red");
const { createHostLinkCaller } = require("./link-call");
const { createMemoryStorageModule } = require("./flow-storage");
const { formatPlain } = require("./cli-params");
const { installMissingNodeModules } = require("./node-modules-install");

const LEVEL_NAMES = {
  10: "fatal",
  20: "error",
  30: "warn",
  40: "info",
  50: "debug",
  60: "trace",
  98: "audit",
  99: "metric"
};

/**
 * Node-RED's built-in console log handler always writes via console.log,
 * i.e. to stdout. That would corrupt the JSON result on stdout, so replace
 * it with a handler that writes to stderr instead.
 */
function stderrLogHandler() {
  return (msg) => {
    const levelName = LEVEL_NAMES[msg.level] || msg.level;
    const source = msg.type ? `[${msg.type}:${msg.name || msg.id}] ` : "";
    const message = msg.msg && msg.msg.message ? msg.msg.message : msg.msg;
    console.error(`node-red-cli: [${levelName}] ${source}${message}`);
  };
}

/**
 * Runs a single link-call invocation against a real, freshly booted
 * Node-RED runtime: installs any missing `--node-modules`, boots RED with
 * either an in-memory flow array (`flow`) or a flow file path (`flowFile`),
 * calls the target link-in node, tears everything down again, and returns
 * the formatted stdout output.
 *
 * This is the single shared implementation used by both the host CLI
 * (`bin/node-red-cli.js`, non-Docker path) and the containerized sandbox
 * entrypoint (`bin/node-red-cli-sandbox-entry.js`, `--docker` path), so both
 * execute the exact same runtime logic.
 *
 * `options.userDir`, when set, is treated as a persistent directory and is
 * never removed afterward (host: an explicit `--user-dir`; container: the
 * fixed mount path of a named Docker volume). When omitted, an ephemeral
 * tmpdir is created and removed again after the call.
 */
async function runFlowInvocation({ flow, flowFile, msg, options }) {
  const {
    target,
    flow: flowSelector,
    timeoutMs = 5000,
    format = "plain",
    nodeModules = [],
    userDir: fixedUserDir
  } = options;

  const persistentUserDir = Boolean(fixedUserDir);
  const userDir = fixedUserDir || fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-"));

  try {
    if (nodeModules.length > 0) {
      await installMissingNodeModules(userDir, nodeModules);
    }

    let caller;
    RED.init({
      ...(flow ? { storageModule: createMemoryStorageModule(flow) } : { flowFile }),
      userDir,
      httpAdminRoot: false,
      httpNodeRoot: false,
      editorTheme: { projects: { enabled: false } },
      logging: { console: { level: "warn", metrics: false, audit: false, handler: stderrLogHandler } }
    });

    try {
      const flowsStarted = new Promise((resolve) => RED.events.once("flows:started", resolve));
      await RED.start();
      await flowsStarted;

      caller = createHostLinkCaller(RED);
      const result = await caller.call(target, msg, {
        flow: flowSelector,
        timeout: timeoutMs,
        onWarning: (warning) => console.error(`node-red-cli: warning: ${warning}`)
      });
      return { output: format === "plain" ? formatPlain(result.payload) : JSON.stringify(result) };
    } finally {
      caller?.close();
      await RED.stop();
    }
  } finally {
    if (!persistentUserDir) fs.rmSync(userDir, { recursive: true, force: true });
  }
}

module.exports = { runFlowInvocation, stderrLogHandler };
