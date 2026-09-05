#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { Command } = require("commander");
const RED = require("node-red");
const { createHostLinkCaller } = require("../src/link-call");
const { createMemoryStorageModule } = require("../src/flow-storage");
const { applySetParams, parseFlowJsonParam, parseFormatParam, formatPlain } = require("../src/cli-params");
const { version } = require("../package.json");

const HELP_TEXT = [
  "",
  "Reads a JSON message from stdin and invokes the given link-in target",
  "in the specified Node-RED flow file. The message returned by the",
  "matching link-out (return) node is printed to stdout.",
  "",
  "target defaults to the sole link-in node in the flow file when omitted.",
  "If multiple tabs exist but only one link-in node is present overall,",
  "it is used automatically (a warning is printed to stderr).",
  "",
  "--set <key>=<value> sets msg.payload.<key> to <value>, repeatable.",
  "Values are JSON-parsed when possible (4 -> number, true -> boolean),",
  "otherwise kept as plain strings. --set params are applied on top of",
  "the payload read from stdin (if any) and override matching keys.",
  "",
  "--format=json|plain selects the stdout output format (default: plain).",
  "json prints the full result object as JSON. plain prints only the",
  "result payload as plain text.",
  "",
  "--flow-json <value> supplies the flow definition inline instead of the",
  "<flows.json> positional argument (the two are mutually exclusive).",
  "<value> is one of:",
  '  - an inline JSON array, e.g. --flow-json \'[{"id":"a",...}]\'',
  "  - '-' to read the flow JSON from stdin",
  "  - '@<path>' to read it from a file",
  "The flow is never written to disk. Because stdin can only be consumed",
  "once, --flow-json - takes stdin for the flow definition, not for msg;",
  "in that mode msg must be built entirely from --set params.",
  "",
  "Example:",
  '  echo \'{"payload":{"x":4,"y":5}}\' | node-red-cli flows.json calculate',
  "",
  "Equivalent using --set instead of stdin:",
  "  node-red-cli flows.json calculate --set x=4 --set y=5 < /dev/null"
].join("\n");

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

async function run(args, options) {
  // <flows.json> and --flow-json are mutually exclusive, and both share the
  // "first positional" slot conceptually, so parse positionals manually
  // instead of relying on commander's fixed argument order: when
  // --flow-json is given, the sole remaining positional is the target;
  // otherwise the first positional is the flow file and the second the
  // target.
  const [flowFileArg, target] = options.flowJson ? [undefined, args[0]] : args;

  if (args.length > (options.flowJson ? 1 : 2)) {
    console.error("node-red-cli: too many positional arguments");
    process.exitCode = 1;
    return;
  }

  if (!flowFileArg && !options.flowJson) {
    console.error("node-red-cli: either <flows.json> or --flow-json must be given");
    process.exitCode = 1;
    return;
  }
  if (flowFileArg && options.flowJson) {
    console.error("node-red-cli: <flows.json> and --flow-json are mutually exclusive");
    process.exitCode = 1;
    return;
  }

  let flowFile;
  let flows;
  if (options.flowJson) {
    try {
      flows = await parseFlowJsonParam(options.flowJson, { readStdin });
    } catch (error) {
      console.error(`node-red-cli: ${error.message}`);
      process.exitCode = 1;
      return;
    }
  } else {
    flowFile = path.resolve(process.cwd(), flowFileArg);
    if (!fs.existsSync(flowFile)) {
      console.error(`node-red-cli: flow file not found: ${flowFile}`);
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
    parseFormatParam(options.format);
  } catch (error) {
    console.error(`node-red-cli: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  const userDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "node-red-cli-"));
  let caller;

  RED.init({
    ...(flows ? { storageModule: createMemoryStorageModule(flows) } : { flowFile }),
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
      flow: options.flow,
      timeout: options.timeout,
      onWarning: (warning) => console.error(`node-red-cli: warning: ${warning}`)
    });
    process.stdout.write(
      options.format === "plain" ? `${formatPlain(result.payload)}\n` : `${JSON.stringify(result)}\n`
    );
  } catch (error) {
    console.error(`node-red-cli: ${error.message}`);
    process.exitCode = 1;
  } finally {
    caller?.close();
    await RED.stop();
    fs.rmSync(userDir, { recursive: true, force: true });
  }
}

const program = new Command();

program
  .name("node-red-cli")
  .usage(
    "<flows.json>|--flow-json <value> [target] [--flow=<tab>] [--timeout=<ms>] [--set <key>=<value>]... [--format=json|plain]"
  )
  .argument("[args...]", "[flows.json] [target], or [target] alone when --flow-json is given (see --help)")
  .option("--flow <tab>", "flow tab name/id to search the target in")
  .option(
    "--flow-json <value>",
    "flow JSON inline, '-' for stdin, or '@path' for a file; mutually exclusive with <flows.json>"
  )
  .option("--timeout <ms>", "call timeout in milliseconds", (value) => Number(value), 5000)
  .option("--format <format>", "output format: json|plain", "plain")
  .option("--set <key=value>", "set msg.payload.<key> to <value>, repeatable", collectSet, [])
  .addHelpText("after", HELP_TEXT)
  .version(version, "-v, --version", "print the installed node-red-cli version and exit")
  .action(run);

program.parseAsync(process.argv).catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
