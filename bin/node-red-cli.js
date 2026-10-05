#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { Command } = require("commander");
const { applySetParams, parseFlowJsonParam, parseOutputParam } = require("../src/cli-params");
const { parseNodeModulesParam, resolveUserDir } = require("../src/node-modules");
const { runFlowInvocation } = require("../src/run-envelope");
const { resolveImage } = require("../src/docker-image");
const { runContainer, volumeNameFor, CONTAINER_USER_DIR } = require("../src/docker-run");
const { version } = require("../package.json");
const { resolveFlowFile } = require("../src/flow-file");
const flowInspect = require("../src/flow-inspect");

const HELP_TEXT = [
  "",
  "Invokes a callable Link In entry in a Node-RED flow-file. The message returned by the",
  "matching link-out (return) node is printed to stdout.",
  "",
  "entry defaults to the sole Link In node when omitted.",
  "If multiple tabs exist but only one link-in node is present overall,",
  "it is used automatically (a warning is printed to stderr).",
  "",
  "--set <key>=<value> sets msg.payload.<key> to <value>, repeatable.",
  "Values are JSON-parsed when possible (4 -> number, true -> boolean),",
  "otherwise kept as plain strings. --set params are applied on top of",
  "the payload read from stdin (if any) and override matching keys.",
  "",
  "--tab <id|label> selects a Node-RED workspace tab.",
  "--output <payload|message> selects output (default: payload). Payload prints",
  "strings as-is and other values as JSON; message prints the full message as JSON.",
  "",
  "--flow-json <json|-> supplies inline flow JSON or reads it from stdin",
  "instead of a flow-file positional argument (the two are mutually exclusive).",
  "The flow is never written to disk. Because stdin can only be consumed",
  "once, --flow-json - takes stdin for the flow definition, not for msg;",
  "in that mode msg must be built entirely from --set params.",
  "",
  "--user-dir [dir] makes Node-RED's userDir persistent/reusable across",
  "runs. Without it, the CLI uses",
  "an ephemeral tmpdir created fresh and",
  "deleted after every invocation. Pass a path to use a specific directory,",
  "or the bare flag to use a stable cache dir ($XDG_CACHE_HOME/node-red-cli,",
  "falling back to ~/.cache/node-red-cli). A shared userDir accumulates",
  "Node-RED runtime/state files (e.g. .config.runtime.json) across runs;",
  "delete the directory to clear the cache.",
  "",
  "--node-modules <name[@version]>[,...] installs any of the given",
  "Node-RED node npm packages that are missing from userDir/node_modules",
  "before the flow runs (repeatable and/or comma-separated). Requires an",
  "explicit --user-dir (installing into an ephemeral userDir would just",
  "reinstall from npm on every run). Already-installed, version-matching",
  "modules are left untouched (no network access). This runs a real",
  "`npm install`, i.e. arbitrary code execution from the configured npm",
  "registry - only use it with trusted module names.",
  "",
  "--docker [value] re-executes the entire invocation (flow resolution,",
  "link call, and any --node-modules install) inside a disposable, hardened",
  "Docker container instead of the host process. Zero bind mounts, zero",
  "leftover host files. <value> is one of:",
  "  - omitted (bare flag): use/build a cached local image",
  "    node-red-cli-sandbox:<installed version>, from node:24-slim + a",
  "    global npm install of this package.",
  "  - '<image[:tag]>': use an explicit image. If it already contains the",
  "    sandbox entrypoint it is used as-is; otherwise node-red-cli is",
  "    installed into a derived image on first use (cached by image+version).",
  "  - '@<path>' or an http(s) URL: build from a Dockerfile (local file or",
  "    fetched URL), cached by content hash.",
  "Sandboxing defaults: --network none (unless --node-modules is also set,",
  "which needs registry access, or --network is passed explicitly to enable",
  "network access independent of installing any package), --read-only",
  "rootfs with a /tmp tmpfs, --cap-drop=ALL, --security-opt=no-new-privileges.",
  "When combined with --user-dir, persistence uses a named Docker volume,",
  "never a host bind mount. Without --user-dir, the container's own /data",
  "is auto-probed for a pre-populated Node-RED userDir (best-effort; see",
  "--docker-user-dir for a reliable, explicit alternative).",
  "",
  "--docker-user-dir <dir> tells --docker to use <dir> (a directory inside",
  "the container, e.g. one a base image already pre-installs Node-RED node",
  "packages into) as the userDir, instead of the default ephemeral tmpdir or",
  "the best-effort /data auto-probe. Ignored outside --docker mode.",
  "Precedence: --user-dir > --docker-user-dir > the /data auto-probe > the ephemeral default.",
  "",
  "A flow-file path with a separator is exact. Bare flow-files resolve in cwd,",
  "or in --flow-dir when supplied. With no flow-file, flows.json is used in cwd",
  "or --flow-dir. --flow-dir is separate from the Node-RED runtime userDir.",
  "",
  "Example:",
  '  echo \'{"payload":{"x":4,"y":5}}\' | node-red-cli run flows.json calculate',
  "",
  "Equivalent using --set instead of stdin:",
  "  node-red-cli run flows.json calculate --set x=4 --set y=5 < /dev/null"
].join("\n");

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

/** Collects a repeatable `--set key=value` option into an array. */
function collectSet(value, previous) {
  return [...previous, value];
}

/** Collects a repeatable `--node-modules` option into an array. */
function collectNodeModules(value, previous) {
  return [...previous, value];
}

function parseDepth(value) {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new Error("depth must be a non-negative integer");
  const depth = Number(value);
  if (!Number.isSafeInteger(depth)) throw new Error("depth must be a non-negative integer");
  return depth;
}

function inspect(flowFileArg, entryArg, options, command) {
  options = command.opts();
  if (command.getOptionValueSource("depth") === "cli" && !entryArg) {
    console.error("node-red-cli: --depth requires an entry");
    process.exitCode = 1;
    return;
  }
  try {
    const flowFile = resolveFlowFile({ flowFileArg, flowDir: options.flowDir });
    let flows;
    try {
      flows = JSON.parse(fs.readFileSync(flowFile, "utf8"));
    } catch (error) {
      throw new Error(`could not read/parse flow file '${flowFile}': ${error.message}`, { cause: error });
    }
    const index = flowInspect.indexFlow(flows);
    const tab = flowInspect.resolveTab(index, options.tab);
    const result = {
      source: { path: flowFile },
      ...flowInspect.inventory(index, tab),
      warnings: index.warnings,
      graph: null
    };
    if (entryArg) {
      const entry = flowInspect.resolveEntry(index, entryArg, tab);
      result.graph = flowInspect.graph(index, entry, options.depth);
    }
    process.stdout.write(
      options.json ? `${JSON.stringify(result)}\n` : `${flowInspect.formatInspection(result)}\n`
    );
  } catch (error) {
    console.error(`node-red-cli: ${error.message}`);
    process.exitCode = 1;
  }
}

async function run(flowFileArg, entryArg, options, command) {
  options = command.optsWithGlobals();
  const hasFlowJson = options.flowJson !== undefined;
  // With inline flow JSON, the first positional represents the entry instead
  // of a flow-file; Commander still validates the two-position maximum.
  if (hasFlowJson && entryArg) {
    console.error("node-red-cli: flow-file and --flow-json are mutually exclusive");
    process.exitCode = 1;
    return;
  }
  const entry = hasFlowJson ? flowFileArg || entryArg : entryArg;
  flowFileArg = hasFlowJson ? undefined : flowFileArg;

  let flowFile;
  let flows;
  if (hasFlowJson) {
    try {
      flows = await parseFlowJsonParam(options.flowJson, { readStdin });
    } catch (error) {
      console.error(`node-red-cli: ${error.message}`);
      process.exitCode = 1;
      return;
    }
  } else {
    try {
      flowFile = resolveFlowFile({ flowFileArg, flowDir: options.flowDir });
    } catch (error) {
      console.error(`node-red-cli: ${error.message}`);
      process.exitCode = 1;
      return;
    }
  }

  const usedStdinForFlow = options.flowJson === "-";
  let msg;
  if (usedStdinForFlow) {
    msg = { payload: {} };
  } else {
    const rawInput = (await readStdin()).trim();
    try {
      msg = rawInput.length > 0 ? JSON.parse(rawInput) : {};
    } catch (error) {
      console.error(`node-red-cli: invalid JSON on stdin: ${error.message}`);
      process.exitCode = 1;
      return;
    }

    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      console.error("node-red-cli: the JSON message on stdin must be an object");
      process.exitCode = 1;
      return;
    }
  }

  try {
    msg.payload = applySetParams(msg.payload, options.set);
  } catch (error) {
    console.error(`node-red-cli: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  try {
    parseOutputParam(options.output);
  } catch (error) {
    console.error(`node-red-cli: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  let nodeModules;
  try {
    nodeModules = options.nodeModules.length > 0 ? parseNodeModulesParam(options.nodeModules) : [];
  } catch (error) {
    console.error(`node-red-cli: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const persistentUserDir = resolveUserDir(options.userDir);
  if (nodeModules.length > 0 && !persistentUserDir) {
    if (options.dockerUserDir || options.docker) {
      console.error(
        "node-red-cli: --node-modules requires an explicit --user-dir (a persistent directory); " +
          "--docker-user-dir and the best-effort /data auto-probe are not guaranteed persistent, " +
          "so installing into them would just reinstall from npm on every run"
      );
    } else {
      console.error(
        "node-red-cli: --node-modules requires an explicit --user-dir (a persistent directory); " +
          "using it with the default ephemeral userDir would reinstall from npm on every run"
      );
    }
    process.exitCode = 1;
    return;
  }

  if (options.docker) {
    if (!flows) {
      try {
        flows = JSON.parse(fs.readFileSync(flowFile, "utf8"));
      } catch (error) {
        console.error(`node-red-cli: could not read/parse flow file '${flowFile}': ${error.message}`);
        process.exitCode = 1;
        return;
      }
    }

    const volumeName = persistentUserDir ? volumeNameFor(persistentUserDir) : undefined;
    const envelope = {
      flow: flows,
      msg,
      options: {
        target: entry,
        flow: options.tab,
        timeoutMs: options.timeout,
        output: options.output,
        nodeModules,
        userDir: volumeName ? CONTAINER_USER_DIR : undefined,
        dockerUserDir: options.dockerUserDir
      }
    };

    let image;
    let result;
    try {
      image = await resolveImage(options.docker, { version });
      result = await runContainer(image, envelope, {
        networkNeeded: nodeModules.length > 0 || options.network,
        volumeName
      });
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
      return;
    }

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.code ?? 1;
    return;
  }

  try {
    const { output } = await runFlowInvocation({
      flow: flows,
      flowFile,
      msg,
      options: {
        target: entry,
        flow: options.tab,
        timeoutMs: options.timeout,
        output: options.output,
        nodeModules,
        userDir: persistentUserDir
      }
    });
    process.stdout.write(`${output}\n`);
  } catch (error) {
    console.error(`node-red-cli: ${error.message}`);
    process.exitCode = 1;
  }
}

const program = new Command();

function addRunOptions(command) {
  return command
    .option("--tab <id|label>", "workspace tab id or unique label to scope entry selection")
    .option("--flow-dir <dir>", "directory for a bare flow-file name")
    .option("--flow-json <json|->", "inline flow JSON or '-' to read flow JSON from stdin")
    .option("--timeout <ms>", "call timeout in milliseconds", (value) => Number(value), 5000)
    .option("--output <mode>", "output mode: payload|message", "payload")
    .option("--set <key=value>", "set msg.payload.<key> to <value>, repeatable", collectSet, [])
    .option("--user-dir [dir]", "persistent Node-RED userDir (bare flag = default cache dir)")
    .option(
      "--node-modules <name[@version]>",
      "install missing Node-RED node npm package(s), comma-separated and/or repeatable; requires --user-dir",
      collectNodeModules,
      []
    )
    .option(
      "--docker [value]",
      "run the invocation sandboxed in a disposable Docker container; bare = cached default image, " +
        "'<image[:tag]>' = explicit image (installed into if missing), '@path'/URL = build from a Dockerfile"
    )
    .option(
      "--docker-user-dir <dir>",
      "in --docker mode, use <dir> (inside the container) as the userDir instead of the default " +
        "ephemeral tmpdir or the best-effort /data auto-probe; ignored outside --docker mode"
    )
    .option(
      "--network",
      "enable network access in --docker mode, independent of --node-modules (default: --network none)"
    )
    .action(run);
}

program
  .name("node-red-cli")
  .description("Call an existing Node-RED Link In entry.")
  .version(version, "-v, --version", "print the installed node-red-cli version and exit")
  .addHelpText("after", "\nRun `node-red-cli run --help` for flow invocation options.");
const runCommand = program
  .command("run")
  .description("invoke a Node-RED flow-file entry")
  .argument("[flow-file]", "local Node-RED flow JSON file")
  .argument("[entry]", "Link In id or unique name")
  .usage("[flow-file] [entry] [options]")
  .configureHelp({ showGlobalOptions: true })
  .addHelpText("after", HELP_TEXT);
addRunOptions(runCommand);

program
  .command("inspect")
  .description("inspect a Node-RED flow-file without running it")
  .argument("[flow-file]", "local Node-RED flow JSON file")
  .argument("[entry]", "workspace Link In id or unique name")
  .option("--tab <id|label>", "workspace tab id or unique label")
  .option("--flow-dir <dir>", "directory for a bare flow-file name")
  .option("--depth <n>", "maximum graph depth from entry", parseDepth, 1)
  .option("--json", "emit machine-readable JSON")
  .action(inspect);

program.parseAsync(process.argv).catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
