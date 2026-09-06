"use strict";

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { test, mock, beforeEach } = require("node:test");
const cp = require("node:child_process");

// docker-image.js destructures spawnSync/spawn off node:child_process at
// require time, so the mocks must be installed before it is required.
mock.method(cp, "spawnSync");
mock.method(cp, "spawn");

beforeEach(() => {
  cp.spawnSync.mock.resetCalls();
  cp.spawn.mock.resetCalls();
});

const { resolveImage } = require("../../src/docker-image");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");

function dockerAvailable() {
  return { status: 0, error: null, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
}

function fakeBuildChild({ code = 0, stderr = "" } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin.on("data", () => {});
  process.nextTick(() => {
    if (stderr) child.stderr.emit("data", stderr);
    child.emit("close", code);
  });
  return child;
}

test("unit: resolveImage fails fast with a clear error when the docker CLI is unreachable", async () => {
  cp.spawnSync.mock.mockImplementationOnce(
    () => ({
      status: 1,
      error: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.from("Cannot connect to the Docker daemon")
    }),
    0
  );

  await assert.rejects(
    resolveImage(true, { version: "1.0.0" }),
    /node-red-cli: docker unavailable:.*Cannot connect/
  );
});

test("unit: resolveImage fails fast when the docker binary itself is missing (spawn ENOENT)", async () => {
  cp.spawnSync.mock.mockImplementationOnce(
    () => ({
      status: null,
      error: new Error("spawn docker ENOENT"),
      stdout: null,
      stderr: null
    }),
    0
  );

  await assert.rejects(
    resolveImage(true, { version: "1.0.0" }),
    /node-red-cli: docker unavailable: spawn docker ENOENT/
  );
});

test("unit: resolveImage returns an explicit image[:tag] as-is when it already has the sandbox entrypoint", async () => {
  cp.spawnSync.mock.mockImplementationOnce(dockerAvailable, 0); // docker info
  cp.spawnSync.mock.mockImplementationOnce(() => ({ status: 0 }), 1); // sandbox entry check: present

  const image = await resolveImage("my-registry/my-image:latest", { version: "1.0.0" });
  assert.equal(image, "my-registry/my-image:latest");
  assert.equal(
    cp.spawn.mock.callCount(),
    0,
    "no build should be triggered when the entrypoint is already present"
  );
});

test("unit: resolveImage installs node-red-cli into a derived image when an explicit image is missing the sandbox entrypoint", async () => {
  cp.spawnSync.mock.mockImplementationOnce(dockerAvailable, 0); // docker info
  cp.spawnSync.mock.mockImplementationOnce(() => ({ status: 1 }), 1); // sandbox entry check: missing
  cp.spawnSync.mock.mockImplementationOnce(() => ({ status: 1 }), 2); // derived tag not cached

  let buildArgs;
  let dockerfileContent = "";
  cp.spawn.mock.mockImplementationOnce((command, args) => {
    buildArgs = args;
    const child = fakeBuildChild({ code: 0 });
    child.stdin.on("data", (chunk) => (dockerfileContent += chunk));
    return child;
  }, 0);

  const image = await resolveImage("my-registry/my-image:latest", { version: "1.2.3" });
  assert.match(image, /^node-red-cli-sandbox-derived:[0-9a-f]{16}$/);
  assert.deepEqual(buildArgs.slice(0, 2), ["build", "-t"]);
  assert.match(dockerfileContent, /FROM my-registry\/my-image:latest/);
  assert.match(dockerfileContent, /npm install -g @tbrandenburg\/node-red-cli@1\.2\.3/);
  assert.match(dockerfileContent, /ENTRYPOINT/);
  assert.match(
    dockerfileContent,
    /USER root\nENV NPM_CONFIG_PREFIX=\/usr\/local\nRUN npm install -g @tbrandenburg\/node-red-cli@1\.2\.3/,
    "ENV NPM_CONFIG_PREFIX=/usr/local must appear between USER root and the global npm install so the install always lands under SANDBOX_ENTRY_PATH regardless of the base image's own npm prefix config"
  );
});

test("unit: resolveImage skips the derived build when it's already cached for that image+version", async () => {
  cp.spawnSync.mock.mockImplementationOnce(dockerAvailable, 0); // docker info
  cp.spawnSync.mock.mockImplementationOnce(() => ({ status: 1 }), 1); // sandbox entry check: missing
  cp.spawnSync.mock.mockImplementationOnce(() => ({ status: 0 }), 2); // derived tag already cached

  const image = await resolveImage("my-registry/my-image:latest", { version: "1.2.3" });
  assert.match(image, /^node-red-cli-sandbox-derived:[0-9a-f]{16}$/);
  assert.equal(cp.spawn.mock.callCount(), 0, "no build should run when the derived image is already cached");
});

test("unit: resolveImage builds the default sandbox image once when not already cached", async () => {
  cp.spawnSync.mock.mockImplementationOnce(dockerAvailable, 0); // docker info
  cp.spawnSync.mock.mockImplementationOnce(() => ({ status: 1 }), 1); // docker image inspect: not cached

  let buildArgs;
  let dockerfileContent = "";
  cp.spawn.mock.mockImplementationOnce((command, args) => {
    buildArgs = args;
    const child = fakeBuildChild({ code: 0 });
    child.stdin.on("data", (chunk) => (dockerfileContent += chunk));
    return child;
  }, 0);

  const image = await resolveImage(true, { version: "1.2.3" });
  assert.equal(image, "node-red-cli-sandbox:1.2.3");
  assert.deepEqual(buildArgs.slice(0, 2), ["build", "-t"]);
  assert.equal(buildArgs[2], "node-red-cli-sandbox:1.2.3");
  assert.match(dockerfileContent, /FROM node:24-slim/);
  assert.match(dockerfileContent, /npm install -g @tbrandenburg\/node-red-cli@1\.2\.3/);
  assert.match(dockerfileContent, /ENTRYPOINT/);
});

test("unit: resolveImage skips the build when the default image tag is already cached", async () => {
  cp.spawnSync.mock.mockImplementationOnce(dockerAvailable, 0); // docker info
  cp.spawnSync.mock.mockImplementationOnce(() => ({ status: 0 }), 1); // docker image inspect: cached

  const image = await resolveImage(true, { version: "1.2.3" });
  assert.equal(image, "node-red-cli-sandbox:1.2.3");
  assert.equal(cp.spawn.mock.callCount(), 0, "no build should run when the image is already cached");
});

test("unit: resolveImage reports a clear error when a build fails (e.g. unpublished version)", async () => {
  cp.spawnSync.mock.mockImplementationOnce(dockerAvailable, 0); // docker info
  cp.spawnSync.mock.mockImplementationOnce(() => ({ status: 1 }), 1); // not cached

  cp.spawn.mock.mockImplementationOnce(
    () => fakeBuildChild({ code: 1, stderr: "404 Not Found - GET npm error" }),
    0
  );

  await assert.rejects(
    resolveImage(true, { version: "0.0.0-does-not-exist" }),
    /node-red-cli: docker build failed:.*404 Not Found/
  );
});

test("unit: resolveImage builds from a local @path Dockerfile, cached by content hash", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-docker-image-test-"));
  const dockerfilePath = path.join(dir, "Dockerfile");
  fs.writeFileSync(dockerfilePath, "FROM scratch\n");

  try {
    cp.spawnSync.mock.mockImplementationOnce(dockerAvailable, 0); // docker info
    cp.spawnSync.mock.mockImplementationOnce(() => ({ status: 1 }), 1); // not cached

    let buildArgs;
    cp.spawn.mock.mockImplementationOnce((command, args) => {
      buildArgs = args;
      return fakeBuildChild({ code: 0 });
    }, 0);

    const image = await resolveImage(`@${dockerfilePath}`, { version: "1.0.0" });
    assert.match(image, /^node-red-cli-sandbox-custom:[0-9a-f]{16}$/);
    assert.deepEqual(buildArgs.slice(0, 2), ["build", "-t"]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("unit: resolveImage fails clearly when the @path Dockerfile does not exist", async () => {
  cp.spawnSync.mock.mockImplementationOnce(dockerAvailable, 0); // docker info

  await assert.rejects(
    resolveImage("@/no/such/Dockerfile", { version: "1.0.0" }),
    /node-red-cli: docker build failed: could not read Dockerfile/
  );
});
