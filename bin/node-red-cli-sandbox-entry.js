#!/usr/bin/env node
"use strict";

/**
 * Container-side entrypoint for `--docker`, set as the sandbox image's
 * `ENTRYPOINT` (see `src/docker-image.js`). Reads a `{ flow, msg, options }`
 * envelope as JSON from stdin, runs it against a real Node-RED runtime via
 * the shared `runFlowInvocation` (the exact same logic the host CLI uses
 * for its non-Docker path), and writes the formatted result to stdout.
 *
 * Sets `options.probeContainerDefault: true` before delegating to
 * `runFlowInvocation`, so its `/data` auto-probe (see #33,
 * `resolveContainerDefaultUserDir` in `src/run-envelope.js`) is only ever
 * attempted here -- inside the container -- and never on the host CLI
 * path, since `/data` has no reserved meaning outside a container. It only
 * takes effect as a fallback: an explicit `userDir` (named-volume mount) or
 * `dockerUserDir` (`--docker-userdir`) already present on `envelope.options`
 * still wins, per `resolveEffectiveUserDir`'s precedence.
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
      options: { ...(envelope.options || {}), probeContainerDefault: true }
    });
    process.stdout.write(`${output}\n`);
  } catch (error) {
    console.error(`node-red-cli: ${error.message}`);
    process.exitCode = 1;
  }
}

main();
