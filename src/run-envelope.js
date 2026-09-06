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
 * True if `dirPath` exists and, following symlinks (npm frequently
 * symlinks packages, e.g. in workspace/monorepo installs), is a directory.
 * Never throws: any stat failure (missing path, broken symlink, etc.)
 * resolves to `false`.
 */
function isDirectory(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Returns every immediate subdirectory of `node_modules`, including one
 * level of scoped-package expansion (`@scope/*`), as a flat list of
 * absolute directory paths. Follows symlinks (see `isDirectory`). Never
 * throws: an unreadable/missing `node_modules` (or scope dir) simply
 * contributes no candidates.
 */
function listNodeModuleDirs(nodeModulesDir) {
  let entries;
  try {
    entries = fs.readdirSync(nodeModulesDir);
  } catch {
    return [];
  }

  return entries.flatMap((name) => {
    const entryPath = path.join(nodeModulesDir, name);
    if (!name.startsWith("@")) return isDirectory(entryPath) ? [entryPath] : [];
    if (!isDirectory(entryPath)) return [];

    let scopedNames;
    try {
      scopedNames = fs.readdirSync(entryPath);
    } catch {
      return [];
    }
    return scopedNames.map((scoped) => path.join(entryPath, scoped)).filter(isDirectory);
  });
}

/** True if `packageDir/package.json` exists, parses, and declares a `"node-red"` key. */
function isNodeRedPackage(packageDir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
    return Boolean(pkg["node-red"]);
  } catch {
    return false;
  }
}

/**
 * Auto-probes `baseDir` (default `/data`, the conventional mount point of
 * the motivating `ghcr.io/tbrandenburg/agentic-workflow-dev-env` image, see
 * issue #33) for a Node-RED userDir a community image pre-populated with
 * its own node packages. Returns `baseDir` when it exists, is a directory,
 * and at least one direct or scoped (`@scope/*`) child of its
 * `node_modules` declares a `"node-red"` key in `package.json`; returns
 * `undefined` otherwise.
 *
 * Best-effort by design: a real userDir with unrelated packages under
 * `node_modules` (false negative) or a `/data` that merely happens to
 * contain an unrelated `"node-red"`-keyed package (false positive) are both
 * possible; `--docker-userdir <path>` is the reliable, explicit alternative
 * when this heuristic doesn't fit an image. Never throws: any missing or
 * unreadable path along the way resolves to "not usable".
 *
 * Only meaningful inside a container (`/data` has no reserved meaning on
 * the host), so this is only ever called from the sandbox entrypoint
 * (`bin/node-red-cli-sandbox-entry.js`), never from the host CLI path.
 */
function resolveContainerDefaultUserDir(baseDir = "/data") {
  if (!isDirectory(baseDir)) return undefined;
  const candidateDirs = listNodeModuleDirs(path.join(baseDir, "node_modules"));
  return candidateDirs.some(isNodeRedPackage) ? baseDir : undefined;
}

/**
 * Resolves which `userDir` source wins, in order of precedence (see #33):
 *
 * 1. `userDir` -- host-managed, explicit `--user-dir` (or its container
 *    named-volume mount path).
 * 2. `dockerUserDir` -- explicit `--docker-userdir <path>` passthrough.
 * 3. the auto-probed `/data` default (see `resolveContainerDefaultUserDir`),
 *    only attempted when `probeContainerDefault` is set (sandbox entrypoint
 *    only).
 * 4. `undefined` -- caller falls back to an ephemeral tmpdir.
 *
 * The first three are all treated as persistent (never removed afterward);
 * only the ephemeral tmpdir fallback is managed/cleaned up by the caller.
 *
 * `probeBaseDir` overrides the auto-probed path (defaults to `/data`) --
 * only ever used by tests; real callers always probe the real `/data`.
 */
function resolveEffectiveUserDir({ userDir, dockerUserDir, probeContainerDefault, probeBaseDir } = {}) {
  if (userDir) return { userDir, persistent: true };
  if (dockerUserDir) return { userDir: dockerUserDir, persistent: true };
  if (probeContainerDefault) {
    const probed = resolveContainerDefaultUserDir(probeBaseDir);
    if (probed) return { userDir: probed, persistent: true };
  }
  return { userDir: undefined, persistent: false };
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
 * `userDir` resolution follows `resolveEffectiveUserDir`'s precedence:
 * `options.userDir` (host: an explicit `--user-dir`; container: the fixed
 * mount path of a named Docker volume) > `options.dockerUserDir` (explicit
 * `--docker-userdir <path>` passthrough) > the auto-probed `/data` default
 * (see `resolveContainerDefaultUserDir`, only attempted when
 * `options.probeContainerDefault` is set -- sandbox entrypoint only) > an
 * ephemeral tmpdir created fresh and removed again after the call. The
 * first three are all treated as persistent and never removed afterward.
 */
async function runFlowInvocation({ flow, flowFile, msg, options }) {
  const {
    target,
    flow: flowSelector,
    timeoutMs = 5000,
    format = "plain",
    nodeModules = [],
    userDir: fixedUserDir,
    dockerUserDir,
    probeContainerDefault
  } = options;

  const resolved = resolveEffectiveUserDir({ userDir: fixedUserDir, dockerUserDir, probeContainerDefault });
  const userDir = resolved.userDir || fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-"));
  const managedUserDir = !resolved.persistent;

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
    if (managedUserDir) fs.rmSync(userDir, { recursive: true, force: true });
  }
}

module.exports = {
  runFlowInvocation,
  stderrLogHandler,
  resolveContainerDefaultUserDir,
  resolveEffectiveUserDir
};
