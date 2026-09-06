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
 * Node-RED's flow parser (`@node-red/runtime/lib/flows/util.js`) classifies
 * *any* node lacking both `x` and `y` properties as a global config node --
 * regardless of its actual `type` -- since those coordinates are otherwise
 * only ever used by the editor canvas. A real, editor-exported flow always
 * has them on every wired node, so this never matters there. But hand-authored
 * `--flow-json` flows (this tool's own core use case; see the README's
 * `agent` example) commonly omit them, since they carry no runtime meaning.
 * A wired node misclassified as a config node undergoes `Flow.js`'s
 * config-node circular-dependency scan instead of normal instantiation,
 * which scans every one of its own property values against other node ids
 * and throws "Circular config node dependency detected" the moment any
 * property value happens to equal another node's id -- including its own,
 * e.g. a node whose `name` equals its own `id` (an extremely natural thing
 * to write by hand, and exactly what the README's own agent example does).
 * That aborts the whole flow's instantiation, so downstream preflight
 * validation reports the target/return nodes as "not instantiated" even
 * though the flow is otherwise entirely valid (see issue #28).
 *
 * Fix: assign synthetic coordinates to every node that is unambiguously a
 * regular (wired) node -- i.e. it already declares a `wires` array, or is a
 * `link out` node (which routes via `links` instead of `wires`) -- so
 * Node-RED's parser classifies it correctly. Nodes without either (real
 * config nodes) are left untouched.
 */
function withDeployCoordinates(flow) {
  let n = 0;
  return flow.map((node) => {
    const isWired = Object.prototype.hasOwnProperty.call(node, "wires") || node.type === "link out";
    const hasCoords =
      Object.prototype.hasOwnProperty.call(node, "x") && Object.prototype.hasOwnProperty.call(node, "y");
    if (!isWired || hasCoords) return node;
    n += 1;
    return { ...node, x: n * 100, y: 100 };
  });
}

/**
 * Waits for Node-RED to finish attempting to start the deployed flows.
 *
 * `RED.start()` resolves as soon as the runtime itself has booted, but the
 * actual flow deploy happens asynchronously afterward and normally signals
 * completion via a one-off `flows:started` event. However, when the flow
 * references a node type that isn't registered (or another deploy-blocking
 * condition applies, e.g. missing external modules or safe mode), Node-RED's
 * `Flow.start()` logs the problem and returns *without* ever emitting
 * `flows:started` (see `@node-red/runtime/lib/flows/index.js`). Awaiting
 * only `flows:started` would then hang forever; since nothing else keeps
 * the event loop alive, the process exits silently with code 0 once the
 * loop drains, abandoning the pending call.
 *
 * Node-RED does always emit a `runtime-event` with id `runtime-state` in
 * both cases: `payload.state === "start"` on success, and
 * `payload.state === "stop"` / `"safe"` on any of the early-return failure
 * paths. Racing both events lets us return as soon as Node-RED has settled
 * either way; if the flows never actually started, the target/return nodes
 * simply won't be instantiated and the existing preflight validation in
 * `createHostLinkCaller` reports the real, specific error instead.
 *
 * A `stop`/`safe` `runtime-state` event and a real `flows:started` are
 * mutually exclusive outcomes of the same deploy attempt in the installed
 * `@node-red/runtime` (each early-return failure path returns before ever
 * reaching the code that emits `flows:started`), so this never races in
 * practice today. Still, resolving on `stop`/`safe` is deferred by one
 * macrotask (`setImmediate`) rather than immediately, so that if a
 * `flows:started` for the same attempt is already scheduled to fire right
 * after, it wins instead -- cheap insurance against exactly the kind of
 * premature-resolution regression reported in issue #28, without delaying
 * genuine failures beyond a single negligible tick.
 *
 * (Uses `setTimeout(fn, 0)` rather than `setImmediate` purely because the
 * latter isn't part of this project's configured ESLint globals; both defer
 * to the next macrotask.)
 */
function waitForFlowsSettled(RED) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      RED.events.removeListener("flows:started", onStarted);
      RED.events.removeListener("runtime-event", onRuntimeEvent);
      resolve();
    };
    const onStarted = () => finish();
    const onRuntimeEvent = (event) => {
      if (
        event?.id === "runtime-state" &&
        (event.payload?.state === "stop" || event.payload?.state === "safe")
      ) {
        setTimeout(finish, 0);
      }
    };
    RED.events.once("flows:started", onStarted);
    RED.events.on("runtime-event", onRuntimeEvent);
  });
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
      ...(flow ? { storageModule: createMemoryStorageModule(withDeployCoordinates(flow)) } : { flowFile }),
      userDir,
      httpAdminRoot: false,
      httpNodeRoot: false,
      editorTheme: { projects: { enabled: false } },
      logging: { console: { level: "warn", metrics: false, audit: false, handler: stderrLogHandler } }
    });

    try {
      const flowsSettled = waitForFlowsSettled(RED);
      await RED.start();
      await flowsSettled;

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
