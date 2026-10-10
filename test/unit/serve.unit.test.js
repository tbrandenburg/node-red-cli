"use strict";

const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const test = require("node:test");
const { buildNodeRedArgs, launchNodeRed } = require("../../src/serve");

test("native arguments use local Node-RED and force loopback", () => {
  const flowFile = "/tmp/my flow.json";
  const args = buildNodeRedArgs({ flowFile, userDir: "/tmp/user dir", port: 1881 });
  assert.equal(args[0], require.resolve("node-red/red.js"));
  assert.deepEqual(args.slice(1), [
    "--define",
    "uiHost=127.0.0.1",
    "--port",
    "1881",
    "--userDir",
    "/tmp/user dir",
    flowFile
  ]);
  assert.equal(buildNodeRedArgs({ flowFile, port: 1880 }).includes("--userDir"), false);
});

test("launcher inherits stdio, propagates exit status, and forwards signals once", async () => {
  const child = new EventEmitter();
  const signals = [];
  child.kill = (signal) => signals.push(signal);
  const runtime = new EventEmitter();
  let spawnArgs;
  const result = launchNodeRed(
    { flowFile: "/flow.json", port: 0 },
    {
      runtimeProcess: runtime,
      spawnProcess: (...args) => {
        spawnArgs = args;
        return child;
      }
    }
  );
  assert.equal(spawnArgs[0], process.execPath);
  assert.deepEqual(spawnArgs[2], { stdio: "inherit", shell: false });
  runtime.emit("SIGTERM");
  runtime.emit("SIGTERM");
  assert.deepEqual(signals, ["SIGTERM"]);
  child.emit("close", 7, null);
  assert.equal(await result, 7);
  assert.equal(runtime.listenerCount("SIGTERM"), 0);
});

test("spawn errors produce a nonzero status", async () => {
  const child = new EventEmitter();
  const originalError = console.error;
  const errors = [];
  console.error = (message) => errors.push(message);
  try {
    const result = launchNodeRed(
      { flowFile: "/flow.json", port: 1880 },
      {
        spawnProcess: () => child,
        runtimeProcess: new EventEmitter()
      }
    );
    child.emit("error", new Error("spawn failed"));
    assert.equal(await result, 1);
    assert.match(errors[0], /could not start Node-RED: spawn failed/);
  } finally {
    console.error = originalError;
  }
});
