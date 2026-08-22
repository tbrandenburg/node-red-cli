#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const RED = require("node-red");
const { createHostLinkCaller } = require("../src/link-call");

function parseArgs(argv) {
  const positionals = [];
  const options = { timeout: 5000 };

  for (const arg of argv) {
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
    positionals.push(arg);
  }

  return { positionals, options };
}

function printUsage() {
  console.error(
    [
      "Usage: node-red-cli <flows.json> [target] [--flow=<tab>] [--timeout=<ms>]",
      "",
      "Reads a JSON message from stdin and invokes the given link-in target",
      "in the specified Node-RED flow file. The message returned by the",
      "matching link-out (return) node is printed as JSON to stdout.",
      "",
      "target defaults to the sole link-in node in the flow file when omitted.",
      "If multiple tabs exist but only one link-in node is present overall,",
      "it is used automatically (a warning is printed to stderr).",
      "",
      "Example:",
      '  echo \'{"payload":{"x":4,"y":5}}\' | node-red-cli flows.json calculate'
    ].join("\n")
  );
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

  const userDir = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "node-red-cli-"));
  let caller;

  RED.init({
    flowFile,
    userDir,
    httpAdminRoot: false,
    httpNodeRoot: false,
    editorTheme: { projects: { enabled: false } },
    logging: { console: { level: "warn", metrics: false, audit: false } }
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
    process.stdout.write(`${JSON.stringify(result)}\n`);
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
