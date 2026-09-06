"use strict";

const assert = require("node:assert/strict");
const { test, mock, beforeEach } = require("node:test");
const cp = require("node:child_process");

// docker-run.js destructures `spawn` off node:child_process at require time,
// so the mock must be installed before the module under test is required.
mock.method(cp, "spawn");

beforeEach(() => {
  cp.spawn.mock.resetCalls();
});

const { buildRunArgs, volumeNameFor, runContainer, CONTAINER_USER_DIR } = require("../../src/docker-run");

const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

function fakeChild({ code = 0, stdout = "", stderr = "" } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  // Swallow writes; emit close/data asynchronously so listeners are attached first.
  child.stdin.on("data", () => {});
  process.nextTick(() => {
    if (stdout) child.stdout.emit("data", stdout);
    if (stderr) child.stderr.emit("data", stderr);
    child.emit("close", code);
  });
  return child;
}

test("unit: buildRunArgs applies --network none by default and sandboxing flags", () => {
  const args = buildRunArgs("some-image", { networkNeeded: false });
  assert.deepEqual(args, [
    "run",
    "--rm",
    "-i",
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "some-image"
  ]);
});

test("unit: buildRunArgs omits --network none when networkNeeded (e.g. --node-modules), and points npm's cache at /tmp", () => {
  const args = buildRunArgs("some-image", { networkNeeded: true });
  assert.ok(!args.includes("--network"));
  assert.ok(args.includes("--read-only"));
  assert.ok(args.includes("some-image"));
  assert.ok(
    args.includes("npm_config_cache=/tmp/.npm-cache"),
    "npm cache must be redirected off the read-only rootfs"
  );
});

test("unit: buildRunArgs mounts a named volume, never a bind mount, when volumeName is given", () => {
  const args = buildRunArgs("some-image", { networkNeeded: false, volumeName: "node-red-cli-userdir-abc" });
  const volumeIndex = args.indexOf("-v");
  assert.ok(volumeIndex !== -1);
  assert.equal(args[volumeIndex + 1], `node-red-cli-userdir-abc:${CONTAINER_USER_DIR}`);
});

test("unit: volumeNameFor is deterministic for the same --user-dir path", () => {
  assert.equal(
    volumeNameFor("/home/user/.cache/node-red-cli"),
    volumeNameFor("/home/user/.cache/node-red-cli")
  );
  assert.notEqual(volumeNameFor("/a"), volumeNameFor("/b"));
  assert.match(volumeNameFor("/a"), /^node-red-cli-userdir-[0-9a-f]{16}$/);
});

test("unit: runContainer writes the envelope to stdin and resolves with code/stdout/stderr", async () => {
  let writtenArgs;
  let writtenStdin = "";
  cp.spawn.mock.mockImplementationOnce((command, args) => {
    writtenArgs = args;
    const child = fakeChild({ code: 0, stdout: "9\n" });
    child.stdin.on("data", (chunk) => (writtenStdin += chunk));
    return child;
  }, 0);

  const envelope = { flow: [], msg: { payload: {} }, options: { target: "calculate" } };
  const result = await runContainer("node-red-cli-sandbox:1.0.0", envelope, { networkNeeded: false });

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "9\n");
  assert.equal(writtenArgs[writtenArgs.length - 1], "node-red-cli-sandbox:1.0.0");
  assert.deepEqual(JSON.parse(writtenStdin), envelope);
});

test("unit: runContainer rejects with a 'docker run failed' prefix when docker can't be spawned", async () => {
  cp.spawn.mock.mockImplementationOnce(() => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    process.nextTick(() => child.emit("error", new Error("spawn docker ENOENT")));
    return child;
  }, 0);

  await assert.rejects(
    runContainer("some-image", { flow: [], msg: {}, options: {} }),
    /node-red-cli: docker run failed: spawn docker ENOENT/
  );
});
