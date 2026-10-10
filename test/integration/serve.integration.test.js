"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const cli = path.join(root, "bin/node-red-cli.js");
const fixture = path.join(root, "test/fixtures/serve-http.flows.json");

function project(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-cli-serve-"));
  const home = path.join(directory, "home");
  fs.mkdirSync(home);
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, home };
}

function invoke(args, cwd, home) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, HOME: home }
  });
}

test("serve CLI validates ports and exposes only native server options", (t) => {
  const { directory, home } = project(t);
  const rootHelp = invoke(["--help"], directory, home);
  assert.match(rootHelp.stdout, /serve/);
  const help = invoke(["serve", "--help"], directory, home);
  for (const option of ["--flow-dir", "--user-dir", "--port"]) assert.match(help.stdout, new RegExp(option));
  for (const option of ["--timeout", "--docker", "--flow-json"])
    assert.doesNotMatch(help.stdout, new RegExp(option));
  fs.copyFileSync(fixture, path.join(directory, "flows.json"));
  for (const port of ["-1", "1.5", "65536", "NaN", ""]) {
    const result = invoke(["serve", "flows.json", "--port", port], directory, home);
    assert.notEqual(result.status, 0, `port ${JSON.stringify(port)} must fail`);
  }
  assert.match(invoke(["serve", "missing.json"], directory, home).stderr, /flow file not found/);
});

test("serve launches a native HTTP In flow and shuts its child down on SIGTERM", async (t) => {
  const { directory, home } = project(t);
  const flow = path.join(directory, "hello world.json");
  const userDir = path.join(directory, "user-dir");
  fs.copyFileSync(fixture, flow);
  fs.mkdirSync(userDir);
  fs.writeFileSync(path.join(userDir, "settings.js"), 'module.exports = { uiHost: "0.0.0.0" };\n');
  const child = spawn(process.execPath, [cli, "serve", flow, "--port", "0", "--user-dir", userDir], {
    cwd: directory,
    env: { ...process.env, HOME: home },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  });

  let response;
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const address = output.match(/127\.0\.0\.1:(\d+)/);
    if (address) {
      try {
        response = await globalThis.fetch(`http://127.0.0.1:${address[1]}/hello`);
        if (response.ok) break;
      } catch {
        response = undefined;
      }
    }
    if (child.exitCode !== null) break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(response?.ok, `native endpoint did not become ready: ${output}`);
  assert.equal(await response.text(), "hello from Node-RED");
  const address = output.match(/127\.0\.0\.1:(\d+)/);
  const conflict = invoke(
    ["serve", flow, "--port", address[1], "--user-dir", path.join(directory, "conflict-user-dir")],
    directory,
    home
  );
  assert.notEqual(conflict.status, 0, "an occupied native server port must fail");
  assert.equal((await globalThis.fetch(`http://127.0.0.1:${address[1]}/hello`)).status, 200);
  const editor = await globalThis.fetch(`http://127.0.0.1:${address[1]}/`);
  assert.equal(editor.status, 200);
  assert.match(await editor.text(), /Node-RED/);
  child.kill("SIGTERM");
  const result = await closed;
  assert.equal(result.code, 0);
  assert.ok(fs.existsSync(userDir), "native userDir persists after shutdown");
  await assert.rejects(globalThis.fetch(`http://127.0.0.1:${address[1]}/hello`));
});
