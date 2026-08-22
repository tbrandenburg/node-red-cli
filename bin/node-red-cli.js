#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const RED = require("node-red");
const { createHostLinkCaller } = require("../src/link-call");
const { applySetParams, parseFormatParam, formatPlain } = require("../src/cli-params");

function parseArgs(argv) {
  const positionals = [];
  const options = { timeout: 5000, set: [], format: "json" };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    const flowMatch = arg.match(/^--flow=(.*)$/);
    if (flowMatch) {
      options.flow = flowMatch[1];
      continue;
    }
    const timeoutMatch = arg.match(/^--timeout=(.*)$/);
    if (timeoutMatch) {
      options.timeout = Number(timeoutMatch[1]);
      continue;
    }
    const formatMatch = arg.match(/^--format=(.*)$/);
    if (formatMatch) {
      options.format = formatMatch[1];
      continue;
    }
    if (arg === "--set") {
      options.set.push(argv[++i]);
      continue;
    }
    positionals.push(arg);
  }

  return { positionals, options };
}

function printUsage() {
  console.error(
    [
      "Usage: node-red-cli <flows.json> [target] [--flow=<tab>] [--timeout=<ms>]",
      "                    [--set <key>=<value>]... [--format=json|plain]",
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
      "--format=json|plain selects the stdout output format (default: json).",
      "json prints the full result object as JSON. plain prints only the",
      "result payload as plain text.",
      "",
      "Example:",
      '  echo \'{"payload":{"x":4,"y":5}}\' | node-red-cli flows.json calculate',
      "",
      "Equivalent using --set instead of stdin:",
      "  node-red-cli flows.json calculate --set x=4 --set y=5 < /dev/null"
    ].join("\n")
  );
}

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

async function main() {
  const { positionals, options } = parseArgs(process.argv.slice(2));

  if (options.help || positionals.length < 1) {
    printUsage();
    process.exitCode = options.help ? 0 : 1;
    return;
  }

  const [flowFileArg, target] = positionals;
  const flowFile = path.resolve(process.cwd(), flowFileArg);

  if (!fs.existsSync(flowFile)) {
    console.error(`node-red-cli: flow file not found: ${flowFile}`);
    process.exitCode = 1;
    return;
  }

  const rawInput = (await readStdin()).trim();
  let msg;
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
    flowFile,
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

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
