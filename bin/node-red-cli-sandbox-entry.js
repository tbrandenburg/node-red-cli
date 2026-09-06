#!/usr/bin/env node
"use strict";

/**
 * Container-side entrypoint for `--docker`, set as the sandbox image's
 * `ENTRYPOINT` (see `src/docker-image.js`). Reads a `{ flow, msg, options }`
 * envelope as JSON from stdin, runs it against a real Node-RED runtime via
 * the shared `runFlowInvocation` (the exact same logic the host CLI uses
 * for its non-Docker path), and writes the formatted result to stdout.
 *
 * The `NODE_RED_CLI_DEFAULT_USERDIR` env-var convention (see #31), which
 * lets an image's own pre-populated default userDir be discovered when
 * `--user-dir` isn't given, is resolved entirely inside the shared
 * `runFlowInvocation` (`src/run-envelope.js`) -- nothing to do here beyond
 * the existing pass-through of `envelope.options`.
 */

const { runFlowInvocation } = require("../src/run-envelope");

function readStdin() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.on("data", (chunk) => chunks.push(chunk));
    process.stdin.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    process.stdin.on("error", reject);
  });
}

async function main() {
  let envelope;
  try {
    const raw = await readStdin();
    envelope = JSON.parse(raw);
  } catch (error) {
    console.error(`node-red-cli: invalid envelope on stdin: ${error.message}`);
    process.exitCode = 1;
    return;
  }

  try {
    const { output } = await runFlowInvocation({
      flow: envelope.flow,
      msg: envelope.msg,
      options: envelope.options || {}
    });
    process.stdout.write(`${output}\n`);
  } catch (error) {
    console.error(`node-red-cli: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
