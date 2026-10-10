"use strict";

const { spawn } = require("node:child_process");
const { convertProcessSignalToExitCode } = require("node:util");

function buildNodeRedArgs({ flowFile, userDir, port }) {
  return [
    require.resolve("node-red/red.js"),
    "--define",
    "uiHost=127.0.0.1",
    "--port",
    String(port),
    ...(userDir ? ["--userDir", userDir] : []),
    flowFile
  ];
}

function launchNodeRed(options, { spawnProcess = spawn, runtimeProcess = process } = {}) {
  const child = spawnProcess(process.execPath, buildNodeRedArgs(options), {
    stdio: "inherit",
    shell: false
  });
  let exited = false;
  let signaled = false;

  const forwardSignal = (signal) => {
    if (exited || signaled) return;
    signaled = true;
    child.kill(signal);
  };
  const onSigint = () => forwardSignal("SIGINT");
  const onSigterm = () => forwardSignal("SIGTERM");
  runtimeProcess.on("SIGINT", onSigint);
  runtimeProcess.on("SIGTERM", onSigterm);

  return new Promise((resolve) => {
    child.once("error", (error) => {
      if (exited) return;
      exited = true;
      console.error(`node-red-cli: could not start Node-RED: ${error.message}`);
      resolve(1);
    });
    child.once("close", (code, signal) => {
      if (exited) return;
      exited = true;
      resolve(code ?? (signal ? convertProcessSignalToExitCode(signal) : 1));
    });
    child.once("close", () => {
      runtimeProcess.off("SIGINT", onSigint);
      runtimeProcess.off("SIGTERM", onSigterm);
    });
  });
}

module.exports = { buildNodeRedArgs, launchNodeRed };
