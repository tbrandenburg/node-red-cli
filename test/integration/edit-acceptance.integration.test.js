"use strict";

const assert = require("node:assert/strict");
const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const root = path.resolve(__dirname, "../..");
const cli = process.env.NODE_RED_CLI_BIN || path.join(root, "bin/node-red-cli.js");
const fixture = path.join(root, "test/fixtures/serve-http.flows.json");
const nativeFixture = path.join(root, "test/fixtures/native-cross-tab.flows.json");

function temporaryProject(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-edit-acceptance-"));
  const userDir = path.join(directory, "user");
  fs.mkdirSync(userDir);
  const flowFile = path.join(directory, "flows.json");
  const flows = JSON.parse(fs.readFileSync(fixture, "utf8"));
  flows.push({ id: "second-tab", type: "tab", label: "Second" });
  flows.find((node) => node.id === "serve-set-payload").wires = [["custom-auth"]];
  flows.push({
    id: "custom-auth",
    type: "acceptance-auth",
    z: "serve-tab",
    name: "Credential fixture",
    x: 460,
    y: 120,
    wires: [["serve-http-response"]]
  });
  fs.writeFileSync(flowFile, JSON.stringify(flows, null, 2));
  const moduleDir = path.join(userDir, "node_modules", "node-red-contrib-acceptance-auth");
  fs.mkdirSync(moduleDir, { recursive: true });
  fs.writeFileSync(
    path.join(moduleDir, "package.json"),
    JSON.stringify({
      name: "node-red-contrib-acceptance-auth",
      version: "1.0.0",
      "node-red": { nodes: { "acceptance-auth": "acceptance-auth.js" } }
    })
  );
  fs.writeFileSync(
    path.join(moduleDir, "acceptance-auth.js"),
    'module.exports = function(RED) { function AcceptanceAuth(config) { RED.nodes.createNode(this, config); this.on("input", function(msg) { if (msg.req && msg.req.query && msg.req.query.check) msg.payload = String(this.credentials.password === "second-sentinel"); this.send(msg); }); } RED.nodes.registerType("acceptance-auth", AcceptanceAuth, { credentials: { username: { type: "text" }, password: { type: "password" } } }); };\n'
  );
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, userDir, flowFile, flows };
}

function freePort() {
  const server = require("node:net").createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function launch(project, port) {
  const child = spawn(
    process.execPath,
    [cli, "serve", project.flowFile, "--port", String(port), "--user-dir", project.userDir],
    {
      cwd: project.directory,
      env: { ...process.env, HOME: project.directory },
      stdio: ["ignore", "pipe", "pipe"]
    }
  );
  let output = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => (output += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (output += chunk));
  return { child, output: () => output };
}

async function waitForReady(server, port) {
  const deadline = Date.now() + 30000;
  let lastError;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`serve exited early: ${server.output()}`);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/hello`);
      if (response.ok) return;
      lastError = new Error(`HTTP endpoint returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Node-RED did not become ready: ${lastError?.message}; ${server.output()}`);
}

async function stop(server) {
  if (server.child.exitCode !== null || server.child.signalCode !== null) return;
  const closed = new Promise((resolve, reject) => {
    server.child.once("error", reject);
    server.child.once("close", (code, signal) => resolve({ code, signal }));
  });
  server.child.kill("SIGTERM");
  const result = await closed;
  assert.equal(result.code, 0, `serve shutdown failed: ${server.output()}`);
}

async function admin(port, method = "GET", body) {
  const response = await fetch(`http://127.0.0.1:${port}/flows`, {
    method,
    headers: {
      "Node-RED-API-Version": "v2",
      "Content-Type": "application/json",
      ...(method === "POST" ? { "Node-RED-Deployment-Type": "full" } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  return { response, body: response.status === 204 ? null : await response.json() };
}

async function safeCredentials(port, type, id) {
  const response = await fetch(
    `http://127.0.0.1:${port}/credentials/${encodeURIComponent(type)}/${encodeURIComponent(id)}`
  );
  return { response, body: await response.json() };
}

function invoke(args, project, extraEnv = {}, input) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: project.directory,
    encoding: "utf8",
    env: { ...process.env, HOME: project.directory, ...extraEnv },
    ...(input === undefined ? {} : { input })
  });
}

function invokeAsync(args, project, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd: project.directory,
      env: { ...process.env, HOME: project.directory, ...extraEnv },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status: status ?? 1, signal, stdout, stderr }));
  });
}

function temporaryNativeProject(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "node-red-edit-structures-"));
  const userDir = path.join(directory, "user");
  fs.mkdirSync(userDir);
  const flowFile = path.join(directory, "flows.json");
  const flows = JSON.parse(fs.readFileSync(nativeFixture, "utf8"));
  flows.push({ id: "seed-broker", type: "mqtt-broker", name: "seed", broker: "127.0.0.1", port: "1883" });
  fs.writeFileSync(flowFile, JSON.stringify(flows, null, 2));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return { directory, userDir, flowFile, flows };
}

async function waitForAdmin(server, port) {
  const deadline = Date.now() + 30000;
  let lastError;
  while (Date.now() < deadline) {
    if (server.child.exitCode !== null) throw new Error(`serve exited early: ${server.output()}`);
    try {
      const result = await admin(port);
      if (result.response.ok && result.body?.rev && Array.isArray(result.body.flows)) return result.body;
      lastError = new Error(`Admin API returned ${result.response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Node-RED Admin API did not become ready: ${lastError?.message}; ${server.output()}`);
}

function writePlan(project, name, plan) {
  const file = path.join(project.directory, name);
  fs.writeFileSync(file, JSON.stringify(plan));
  return file;
}

test("edit acceptance on a native serve process: queries, preview, deploy, stale rejection, runtime and restart", async (t) => {
  const project = temporaryProject(t);
  let port = await freePort();
  let server = launch(project, port);
  t.after(async () => stop(server));
  await waitForReady(server, port);

  const base = await admin(port);
  assert.equal(base.response.status, 200);
  assert.ok(base.body.rev);
  assert.deepEqual(
    base.body.flows.map((node) => node.id),
    project.flows.map((node) => node.id)
  );
  const untouched = base.body.flows.filter(
    (node) => !["serve-tab", "second-tab", "serve-set-payload"].includes(node.id)
  );
  const get = invoke(
    ["edit", "get", "serve-set-payload", "--admin-url", `http://127.0.0.1:${port}`, "--json"],
    project
  );
  assert.equal(get.status, 0, get.stderr);
  assert.equal(JSON.parse(get.stdout).node.id, "serve-set-payload");
  const list = invoke(["edit", "list", "--admin-url", `http://127.0.0.1:${port}`, "--json"], project);
  assert.equal(list.status, 0, list.stderr);
  assert.deepEqual(
    JSON.parse(list.stdout).tabs.map((tab) => tab.id),
    ["serve-tab", "second-tab"]
  );

  assert.equal(
    base.body.flows.some((node) => node.type === "mqtt-broker"),
    false
  );
  const unverifiedType = {
    id: "assumed-broker",
    type: "mqtt-broker",
    z: "serve-tab",
    x: 700,
    y: 260,
    wires: []
  };
  const unverifiedPlanFile = writePlan(project, "unverified-config-type.json", {
    rev: base.body.rev,
    ops: [{ op: "add", node: unverifiedType }]
  });
  const unverified = invoke(
    ["edit", "preview", unverifiedPlanFile, "--admin-url", `http://127.0.0.1:${port}`, "--json"],
    project
  );
  assert.notEqual(unverified.status, 0);
  assert.match(unverified.stderr, /assumeOrdinary:true/);
  const assumedPlanFile = writePlan(project, "assumed-config-type.json", {
    rev: base.body.rev,
    ops: [{ op: "add", node: unverifiedType, assumeOrdinary: true }]
  });
  const assumed = invoke(
    ["edit", "preview", assumedPlanFile, "--admin-url", `http://127.0.0.1:${port}`, "--json"],
    project
  );
  assert.equal(assumed.status, 0, assumed.stderr);
  assert.match(JSON.parse(assumed.stdout).warnings.join(" "), /category was not verified/);
  assert.equal((await admin(port)).body.rev, base.body.rev, "assumption preview must not deploy");

  const plan = {
    rev: base.body.rev,
    ops: [
      {
        op: "set",
        id: "serve-set-payload",
        fields: { rules: [{ t: "set", p: "payload", pt: "msg", to: "edited by native apply", tot: "str" }] }
      },
      { op: "tab", action: "set", id: "second-tab", fields: { label: "Second (edited)" } },
      {
        op: "group",
        action: "add",
        group: {
          id: "acceptance-group",
          type: "group",
          z: "serve-tab",
          name: "Acceptance",
          x: 80,
          y: 60,
          w: 560,
          h: 180,
          nodes: ["serve-set-payload"]
        }
      }
    ]
  };
  const credentialSeed = await admin(port, "POST", {
    rev: base.body.rev,
    flows: base.body.flows.map((node) =>
      node.id === "custom-auth"
        ? {
            ...node,
            credentials: { username: "acceptance-user", password: "credential-preservation-sentinel" }
          }
        : node
    )
  });
  assert.equal(credentialSeed.response.status, 200, JSON.stringify(credentialSeed.body));
  const seededFlows = (await admin(port)).body;
  plan.rev = seededFlows.rev;
  const seededCredentialNode = seededFlows.flows.find((node) => node.id === "custom-auth");
  assert.equal("credentials" in seededCredentialNode, false, "GET /flows must not expose credential content");
  const seededSafeCredentials = await safeCredentials(port, "acceptance-auth", "custom-auth");
  assert.equal(seededSafeCredentials.response.status, 200);
  assert.equal(seededSafeCredentials.body.has_password, true);
  assert.equal(seededSafeCredentials.body.username, "acceptance-user");
  assert.doesNotMatch(JSON.stringify(seededSafeCredentials.body), /credential-preservation-sentinel/);
  assert.doesNotMatch(JSON.stringify(seededFlows), /credential-preservation-sentinel/);
  const planFile = writePlan(project, "plan.json", plan);
  const preview = invoke(
    ["edit", "preview", planFile, "--admin-url", `http://127.0.0.1:${port}`, "--json"],
    project
  );
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).deployed, false);
  assert.deepEqual((await admin(port)).body, seededFlows, "preview must not deploy");

  const applied = invoke(
    ["edit", "apply", planFile, "--admin-url", `http://127.0.0.1:${port}`, "--json"],
    project
  );
  assert.equal(applied.status, 0, applied.stderr);
  const appliedResult = JSON.parse(applied.stdout);
  assert.equal(appliedResult.deployed, true);
  assert.notEqual(appliedResult.rev, base.body.rev);
  const deployed = await admin(port);
  assert.equal(deployed.body.flows.find((node) => node.id === "serve-tab").label, "Serve HTTP");
  assert.equal(deployed.body.flows.find((node) => node.id === "second-tab").label, "Second (edited)");
  assert.deepEqual(deployed.body.flows.find((node) => node.id === "acceptance-group").nodes, [
    "serve-set-payload"
  ]);
  assert.equal(deployed.body.flows.find((node) => node.id === "serve-set-payload").g, "acceptance-group");
  for (const before of untouched)
    assert.deepEqual(
      deployed.body.flows.find((node) => node.id === before.id),
      before
    );
  assert.equal("credentials" in deployed.body.flows.find((node) => node.id === "custom-auth"), false);
  assert.deepEqual(
    (await safeCredentials(port, "acceptance-auth", "custom-auth")).body,
    seededSafeCredentials.body
  );
  assert.doesNotMatch(JSON.stringify(deployed), /credential-preservation-sentinel/);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/hello`)).text(), "edited by native apply");

  const credentialPlan = {
    rev: deployed.body.rev,
    ops: [
      {
        op: "credential",
        action: "set",
        id: "custom-auth",
        values: { password: { env: "NR_EDIT_ACCEPTANCE_SECRET" } }
      }
    ]
  };
  const credentialFile = writePlan(project, "credential-set.json", credentialPlan);
  const expectedSecret = "second-sentinel";
  const credentialPreview = invoke(
    ["edit", "preview", credentialFile, "--admin-url", `http://127.0.0.1:${port}`, "--json"],
    project,
    { NR_EDIT_ACCEPTANCE_SECRET: expectedSecret }
  );
  assert.equal(credentialPreview.status, 0, credentialPreview.stderr);
  assert.doesNotMatch(`${credentialPreview.stdout}${credentialPreview.stderr}`, /second-sentinel/);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/hello?check=1`)).text(), "false");
  assert.equal((await admin(port)).body.rev, deployed.body.rev, "credential preview must not deploy");

  const credentialApply = invoke(
    ["edit", "apply", credentialFile, "--admin-url", `http://127.0.0.1:${port}`, "--json"],
    project,
    { NR_EDIT_ACCEPTANCE_SECRET: expectedSecret }
  );
  assert.equal(credentialApply.status, 0, credentialApply.stderr);
  assert.doesNotMatch(`${credentialApply.stdout}${credentialApply.stderr}`, /second-sentinel/);
  let credentialDeployed = await admin(port);
  credentialPlan.rev = credentialDeployed.body.rev;
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/hello?check=1`)).text(), "true");
  await stop(server);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/hello`));
  port = await freePort();
  server = launch(project, port);
  await waitForReady(server, port);
  credentialDeployed = await admin(port);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/hello?check=1`)).text(), "true");
  assert.equal((await safeCredentials(port, "acceptance-auth", "custom-auth")).body.has_password, true);

  const clearPlan = {
    rev: credentialDeployed.body.rev,
    ops: [{ op: "credential", action: "clear", id: "custom-auth", keys: ["password"] }]
  };
  const clearFile = writePlan(project, "credential-clear.json", clearPlan);
  const clearResult = invoke(
    ["edit", "apply", clearFile, "--admin-url", `http://127.0.0.1:${port}`, "--json"],
    project
  );
  assert.equal(clearResult.status, 0, clearResult.stderr);
  assert.doesNotMatch(`${clearResult.stdout}${clearResult.stderr}`, /second-sentinel/);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/hello?check=1`)).text(), "false");
  assert.equal(
    (await safeCredentials(port, "acceptance-auth", "custom-auth")).body.username,
    "acceptance-user"
  );

  const stale = invoke(
    ["edit", "apply", planFile, "--admin-url", `http://127.0.0.1:${port}`, "--json"],
    project
  );
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /stale/);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/hello`)).text(), "edited by native apply");

  const invalidFile = writePlan(project, "invalid.json", {
    rev: deployed.body.rev,
    ops: [{ op: "tab", action: "delete", id: "serve-tab" }]
  });
  const invalid = invoke(
    ["edit", "apply", invalidFile, "--admin-url", `http://127.0.0.1:${port}`, "--json"],
    project
  );
  assert.notEqual(invalid.status, 0);
  assert.match(invalid.stderr, /nonempty/);
  assert.equal((await admin(port)).body.rev, deployed.body.rev, "invalid plan must not deploy");

  await stop(server);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/hello`));
  port = await freePort();
  server = launch(project, port);
  await waitForReady(server, port);
  const restarted = await admin(port);
  assert.deepEqual(
    restarted.body.flows.map((node) => node.id),
    deployed.body.flows.map((node) => node.id)
  );
  assert.equal(restarted.body.flows.find((node) => node.id === "second-tab").label, "Second (edited)");
  assert.deepEqual(restarted.body.flows.find((node) => node.id === "acceptance-group").nodes, [
    "serve-set-payload"
  ]);
  assert.equal("credentials" in restarted.body.flows.find((node) => node.id === "custom-auth"), false);
  assert.equal((await safeCredentials(port, "acceptance-auth", "custom-auth")).body.has_password, false);
  assert.equal(await (await fetch(`http://127.0.0.1:${port}/hello`)).text(), "edited by native apply");
});

test("edit preview and apply resolve relative plan paths from --cwd", async (t) => {
  const project = temporaryProject(t);
  const caller = path.join(project.directory, "caller");
  const selected = path.join(project.directory, "project");
  fs.mkdirSync(caller);
  fs.mkdirSync(selected);
  const planDirectory = path.join(selected, "plans");
  fs.mkdirSync(planDirectory);
  const port = await freePort();
  const server = launch(project, port);
  t.after(async () => stop(server));
  await waitForReady(server, port);
  const before = await admin(port);
  const list = spawnSync(
    process.execPath,
    [
      cli,
      "edit",
      "--cwd",
      path.relative(caller, selected),
      "list",
      "--admin-url",
      `http://127.0.0.1:${port}`,
      "--json"
    ],
    { cwd: caller, encoding: "utf8", env: { ...process.env, HOME: project.directory } }
  );
  assert.equal(list.status, 0, list.stderr);
  assert.ok(JSON.parse(list.stdout).nodes.some((node) => node.id === "serve-set-payload"));
  const get = spawnSync(
    process.execPath,
    [
      cli,
      "edit",
      "get",
      "serve-set-payload",
      "--cwd",
      path.relative(caller, selected),
      "--admin-url",
      `http://127.0.0.1:${port}`,
      "--json"
    ],
    { cwd: caller, encoding: "utf8", env: { ...process.env, HOME: project.directory } }
  );
  assert.equal(get.status, 0, get.stderr);
  assert.equal(JSON.parse(get.stdout).node.id, "serve-set-payload");
  const planPath = path.join(planDirectory, "change.json");
  fs.writeFileSync(
    planPath,
    JSON.stringify({
      rev: before.body.rev,
      ops: [{ op: "set", id: "serve-set-payload", fields: { name: "cwd plan applied" } }]
    })
  );
  const args = [
    "edit",
    "preview",
    "plans/change.json",
    "--cwd",
    path.relative(caller, selected),
    "--admin-url",
    `http://127.0.0.1:${port}`,
    "--json"
  ];
  const preview = spawnSync(process.execPath, [cli, ...args], {
    cwd: caller,
    encoding: "utf8",
    env: { ...process.env, HOME: project.directory }
  });
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).deployed, false);
  assert.equal((await admin(port)).body.rev, before.body.rev);

  const apply = spawnSync(
    process.execPath,
    [cli, ...args.map((value, index) => (index === 1 ? "apply" : value))],
    {
      cwd: caller,
      encoding: "utf8",
      env: { ...process.env, HOME: project.directory }
    }
  );
  assert.equal(apply.status, 0, apply.stderr);
  assert.equal(JSON.parse(apply.stdout).deployed, true);
  const after = await admin(port);
  assert.equal(after.body.flows.find((node) => node.id === "serve-set-payload").name, "cwd plan applied");
});

test("credential operation fails closed when the runtime exposes no credential schema", async (t) => {
  const project = temporaryProject(t);
  const port = await freePort();
  const server = launch(project, port);
  t.after(async () => stop(server));
  await waitForReady(server, port);
  const current = await admin(port);
  assert.ok(current.body.flows.some((node) => node.id === "custom-auth" && node.type === "acceptance-auth"));
  const candidate = {
    rev: current.body.rev,
    ops: [
      {
        op: "credential",
        action: "set",
        id: "custom-auth",
        values: { password: { env: "NR_EDIT_ACCEPTANCE_SECRET" } }
      }
    ]
  };
  const file = writePlan(project, "credential-plan.json", candidate);
  const result = invoke(
    ["edit", "apply", file, "--admin-url", `http://127.0.0.1:${port}`, "--json"],
    project
  );
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /credential schema.*could not be verified/);
  assert.equal((await admin(port)).body.rev, current.body.rev);
});

test("Admin API auth failures and a deploy-time 409 are surfaced without retries or response-body leaks", async (t) => {
  let mode = "conflict";
  let postCount = 0;
  const requests = [];
  const flows = [
    { id: "api-tab", type: "tab", label: "API test" },
    { id: "api-function", type: "function", z: "api-tab", x: 10, y: 10, wires: [[]], func: "return msg;" }
  ];
  const server = http.createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    if (request.method === "GET" && request.url === "/flows") {
      const status = mode === "unauthorized" ? 401 : mode === "forbidden" ? 403 : 200;
      response.writeHead(status, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify(
          status === 200 ? { rev: "mock-rev", flows } : { error: "admin-response-secret-sentinel" }
        )
      );
      return;
    }
    if (request.method === "POST" && request.url === "/flows") {
      postCount += 1;
      request.resume();
      response.writeHead(409, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "conflict-response-secret-sentinel" }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  const adminUrl = `http://127.0.0.1:${address.port}`;
  const reachability = await fetch(`${adminUrl}/flows`);
  assert.equal(reachability.status, 200);
  const project = temporaryProject(t);
  const conflictPlan = writePlan(project, "conflict-plan.json", {
    rev: "mock-rev",
    ops: [{ op: "set", id: "api-function", fields: { name: "Updated" } }]
  });
  const conflict = await invokeAsync(
    ["edit", "--admin-url", adminUrl, "apply", conflictPlan, "--json"],
    project
  );
  assert.notEqual(conflict.status, 0);
  assert.match(conflict.stderr, /409/);
  assert.doesNotMatch(conflict.stderr, /conflict-response-secret-sentinel/);
  assert.equal(postCount, 1, "409 must not be retried");

  for (const [responseMode, status] of [
    ["unauthorized", 401],
    ["forbidden", 403]
  ]) {
    mode = responseMode;
    const denied = await invokeAsync(["edit", "--admin-url", adminUrl, "list", "--json"], project);
    assert.notEqual(denied.status, 0);
    assert.match(denied.stderr, new RegExp(String(status)));
    assert.doesNotMatch(denied.stderr, /admin-response-secret-sentinel/);
  }
  assert.equal(postCount, 1, "auth failures must not deploy");
});

test("structural edit operations preserve native Link and subflow behavior across deploy and restart", async (t) => {
  const project = temporaryNativeProject(t);
  let port = await freePort();
  let server = launch(project, port);
  t.after(async () => stop(server));
  await waitForAdmin(server, port);
  const initial = await admin(port);
  assert.equal(initial.response.status, 200);

  const definition = initial.body.flows.find((node) => node.id === "multiply");
  const scratch = { id: "scratch-tab", type: "tab", label: "Scratch", disabled: false, info: "" };
  const newDefinition = {
    id: "acceptance-subflow",
    type: "subflow",
    name: "Acceptance subflow",
    in: [{ x: 40, y: 40, wires: [{ id: "acceptance-inner" }] }],
    out: [{ x: 300, y: 40, wires: [{ id: "acceptance-inner", port: 0 }] }]
  };
  const addInner = {
    id: "added-inner",
    type: "function",
    z: "nested-tab",
    x: 380,
    y: 240,
    outputs: 1,
    func: "msg.payload = msg.payload + '-edited'; return msg;",
    wires: [[]]
  };
  const newLink = {
    id: "inner-entry-2",
    type: "link in",
    z: "nested-tab",
    x: 100,
    y: 260,
    links: [],
    wires: [["inner-function"]]
  };
  const acceptanceInner = {
    id: "acceptance-inner",
    type: "function",
    z: "acceptance-subflow",
    x: 200,
    y: 100,
    outputs: 1,
    func: "return msg;",
    wires: [[]]
  };
  const operations = [
    {
      op: "set",
      id: "native-calculate",
      fields: { func: "msg.payload=msg.input.a*msg.input.b+1;return msg;" }
    },
    { op: "subflow", action: "set-definition", id: "multiply", fields: { name: "Multiply acceptance" } },
    {
      op: "subflow",
      action: "ports",
      id: "multiply",
      in: definition.in,
      out: definition.out
    },
    { op: "add", node: addInner },
    {
      op: "group",
      action: "add",
      group: {
        id: "acceptance-group",
        type: "group",
        z: "nested-tab",
        name: "Before",
        x: 120,
        y: 140,
        w: 420,
        h: 180,
        style: {},
        nodes: ["added-inner"]
      }
    },
    {
      op: "group",
      action: "set",
      id: "acceptance-group",
      fields: { name: "After", style: { fill: "#ddd" } }
    },
    {
      op: "group",
      action: "members",
      id: "acceptance-group",
      remove: ["added-inner"],
      add: ["inner-function"]
    },
    { op: "disconnect", from: "inner-function", port: 0, to: "inner-return" },
    { op: "connect", from: "inner-function", port: 0, to: "added-inner" },
    { op: "connect", from: "added-inner", port: 0, to: "inner-return" },
    { op: "link", action: "add", node: newLink },
    { op: "link", action: "disconnect", from: "native-call", to: "inner-entry" },
    { op: "link", action: "connect", from: "native-call", to: "inner-entry-2" },
    { op: "subflow", action: "add-definition", definition: newDefinition },
    { op: "add", node: acceptanceInner },
    {
      op: "subflow",
      action: "ports",
      id: "acceptance-subflow",
      in: newDefinition.in,
      out: newDefinition.out
    },
    {
      op: "subflow",
      action: "add-instance",
      node: {
        id: "acceptance-instance",
        type: "subflow:acceptance-subflow",
        z: "nested-tab",
        x: 500,
        y: 340,
        wires: [["inner-function"]]
      }
    },
    {
      op: "config",
      action: "add",
      node: {
        id: "acceptance-broker",
        type: "mqtt-broker",
        name: "acceptance",
        broker: "127.0.0.1",
        port: "1883"
      }
    },
    { op: "config", action: "set", id: "acceptance-broker", fields: { broker: "updated.invalid" } },
    { op: "config", action: "delete", id: "acceptance-broker" },
    { op: "tab", action: "add", tab: scratch },
    { op: "tab", action: "set", id: scratch.id, fields: { label: "Scratch edited" } },
    {
      op: "tab",
      action: "reorder",
      order: ["nested-tab", "first", "second", "return-tab", "timeout-tab", "duplicate-tab", scratch.id]
    },
    { op: "tab", action: "delete", id: scratch.id }
  ];

  const sourcePreviewFile = writePlan(project, "source-preview.json", {
    rev: initial.body.rev,
    ops: [{ op: "set", id: "native-calculate", fields: { func: "function-source-sentinel" } }]
  });
  const sourcePreview = invoke(
    ["edit", "preview", sourcePreviewFile, "--admin-url", `http://127.0.0.1:${port}`],
    project
  );
  assert.equal(sourcePreview.status, 0, sourcePreview.stderr);
  assert.doesNotMatch(sourcePreview.stdout, /function-source-sentinel/);
  const sourceJsonPreview = invoke(
    ["edit", "preview", sourcePreviewFile, "--admin-url", `http://127.0.0.1:${port}`, "--json"],
    project
  );
  assert.equal(sourceJsonPreview.status, 0, sourceJsonPreview.stderr);
  assert.match(JSON.parse(sourceJsonPreview.stdout).warnings.join(" "), /executable Function source/);

  const missingTypeFile = writePlan(project, "missing-node-type.json", {
    rev: initial.body.rev,
    ops: [
      {
        op: "add",
        node: { id: "missing-node", type: "not-installed", z: "nested-tab", x: 1, y: 2, wires: [] }
      }
    ]
  });
  const missingType = invoke(
    ["edit", "preview", missingTypeFile, "--admin-url", `http://127.0.0.1:${port}`, "--json"],
    project
  );
  assert.notEqual(missingType.status, 0);
  assert.match(missingType.stderr, /not installed/);
  assert.equal((await admin(port)).body.rev, initial.body.rev, "unknown node types must not deploy");

  const previewFile = writePlan(project, "structural-preview.json", {
    rev: initial.body.rev,
    ops: operations
  });
  const preview = invoke(
    ["edit", "preview", previewFile, "--admin-url", `http://127.0.0.1:${port}`, "--json"],
    project
  );
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).deployed, false);
  assert.equal((await admin(port)).body.rev, initial.body.rev, "preview must not deploy structural changes");

  const applied = invoke(
    ["edit", "apply", previewFile, "--admin-url", `http://127.0.0.1:${port}`, "--json"],
    project
  );
  assert.equal(applied.status, 0, applied.stderr);
  const deployed = await admin(port);
  assert.deepEqual(
    deployed.body.flows.filter((node) => node.type === "tab").map((node) => node.id),
    ["nested-tab", "first", "second", "return-tab", "timeout-tab", "duplicate-tab"]
  );
  assert.equal(deployed.body.flows.find((node) => node.id === "acceptance-group").name, "After");
  assert.deepEqual(deployed.body.flows.find((node) => node.id === "acceptance-group").nodes, [
    "inner-function"
  ]);
  assert.equal(deployed.body.flows.find((node) => node.id === "inner-function").g, "acceptance-group");
  assert.equal(deployed.body.flows.find((node) => node.id === "native-call").links[0], "inner-entry-2");
  assert.equal(deployed.body.flows.find((node) => node.id === "multiply").name, "Multiply acceptance");
  assert.equal(
    deployed.body.flows.find((node) => node.id === "acceptance-instance").type,
    "subflow:acceptance-subflow"
  );
  assert.equal(
    deployed.body.flows.some((node) => node.id === "acceptance-broker"),
    false
  );

  await stop(server);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/flows`));
  const nestedRun = invoke(
    ["run", project.flowFile, "nested-entry"],
    project,
    {},
    JSON.stringify({ payload: "input" })
  );
  assert.equal(nestedRun.status, 0, nestedRun.stderr);
  assert.equal(nestedRun.stdout.trim(), "nested-complete-edited");
  const multiplyRun = invoke(
    ["run", project.flowFile, "entry"],
    project,
    {},
    JSON.stringify({ input: { a: 13.75, b: -8 } })
  );
  assert.equal(multiplyRun.status, 0, multiplyRun.stderr);
  assert.equal(multiplyRun.stdout.trim(), "-109");

  port = await freePort();
  server = launch(project, port);
  await waitForAdmin(server, port);
  const restarted = await admin(port);
  assert.deepEqual(
    restarted.body.flows.filter((node) => node.type === "tab").map((node) => node.id),
    ["nested-tab", "first", "second", "return-tab", "timeout-tab", "duplicate-tab"]
  );

  const cleanupOps = [
    { op: "group", action: "delete", id: "acceptance-group" },
    { op: "disconnect", from: "inner-function", port: 0, to: "added-inner" },
    { op: "disconnect", from: "added-inner", port: 0, to: "inner-return" },
    { op: "connect", from: "inner-function", port: 0, to: "inner-return" },
    { op: "delete", id: "added-inner" },
    { op: "link", action: "disconnect", from: "native-call", to: "inner-entry-2" },
    { op: "link", action: "connect", from: "native-call", to: "inner-entry" },
    { op: "link", action: "delete", id: "inner-entry-2" },
    { op: "subflow", action: "delete-instance", id: "acceptance-instance" },
    { op: "subflow", action: "ports", id: "acceptance-subflow", in: [], out: [] },
    { op: "delete", id: "acceptance-inner" },
    { op: "subflow", action: "delete-definition", id: "acceptance-subflow" }
  ];
  const cleanupFile = writePlan(project, "structural-cleanup.json", {
    rev: restarted.body.rev,
    ops: cleanupOps
  });
  const cleanup = invoke(
    ["edit", "apply", cleanupFile, "--admin-url", `http://127.0.0.1:${port}`, "--json"],
    project
  );
  assert.equal(cleanup.status, 0, cleanup.stderr);
  const cleaned = await admin(port);
  for (const id of [
    "acceptance-group",
    "added-inner",
    "inner-entry-2",
    "acceptance-instance",
    "acceptance-subflow",
    "acceptance-inner"
  ])
    assert.equal(
      cleaned.body.flows.some((node) => node.id === id),
      false,
      `${id} should be removed`
    );
  assert.deepEqual(cleaned.body.flows.find((node) => node.id === "inner-function").wires, [["inner-return"]]);
  assert.deepEqual(cleaned.body.flows.find((node) => node.id === "native-call").links, ["inner-entry"]);
  await stop(server);
  const finalRun = invoke(
    ["run", project.flowFile, "nested-entry"],
    project,
    {},
    JSON.stringify({ payload: "input" })
  );
  assert.equal(finalRun.status, 0, finalRun.stderr);
  assert.equal(finalRun.stdout.trim(), "nested-complete");
});

test("Link node names preview and deploy without changing relationships", async (t) => {
  const project = temporaryNativeProject(t);
  let port = await freePort();
  const server = launch(project, port);
  t.after(async () => stop(server));
  const initial = await waitForAdmin(server, port);
  const selectedIds = ["cross", "internal", "native-call"];
  const names = new Map(selectedIds.map((id) => [id, `Renamed ${id}`]));
  const plan = {
    rev: initial.rev,
    ops: selectedIds.map((id) => ({ op: "set", id, fields: { name: names.get(id) } }))
  };
  const planFile = writePlan(project, "rename-links.json", plan);
  const preview = invoke(
    ["edit", "preview", planFile, "--admin-url", `http://127.0.0.1:${port}`, "--json"],
    project
  );
  assert.equal(preview.status, 0, preview.stderr);
  assert.equal(JSON.parse(preview.stdout).deployed, false);
  assert.deepEqual(await admin(port).then(({ body }) => body), initial, "preview must not deploy");

  const before = structuredClone(initial.flows);
  const applied = invoke(
    ["edit", "apply", planFile, "--admin-url", `http://127.0.0.1:${port}`, "--json"],
    project
  );
  assert.equal(applied.status, 0, applied.stderr);
  const deployed = await admin(port);
  assert.equal(deployed.response.status, 200);
  assert.deepEqual(
    deployed.body.flows.map(({ id }) => id),
    before.map(({ id }) => id)
  );
  for (const oldNode of before) {
    const updated = deployed.body.flows.find(({ id }) => id === oldNode.id);
    const expected = names.has(oldNode.id) ? { ...oldNode, name: names.get(oldNode.id) } : oldNode;
    assert.deepEqual(updated, expected, `only the name of ${oldNode.id} may change`);
  }

  for (const fields of [{ name: "bad", links: [] }, { name: 42 }]) {
    const invalid = writePlan(project, "invalid-link-rename.json", {
      rev: deployed.body.rev,
      ops: [{ op: "set", id: "cross", fields }]
    });
    const rejected = invoke(
      ["edit", "preview", invalid, "--admin-url", `http://127.0.0.1:${port}`, "--json"],
      project
    );
    assert.notEqual(rejected.status, 0);
    assert.equal((await admin(port)).body.rev, deployed.body.rev, "rejected preview must not deploy");
  }

  await stop(server);
  port = await freePort();
  const restarted = launch(project, port);
  t.after(async () => stop(restarted));
  const persisted = await waitForAdmin(restarted, port);
  for (const id of selectedIds)
    assert.equal(persisted.flows.find((node) => node.id === id).name, names.get(id));
});
