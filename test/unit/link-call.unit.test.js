"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { createHostLinkCaller, resolveFlow, validateTarget } = require("../../src/link-call");

const fixtureConfigs = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "fixtures", "flows.json"), "utf8")
);

/**
 * Minimal fake of the parts of the Node-RED runtime that resolveFlow and
 * validateTarget touch. No embedded runtime is started for these tests.
 */
function fakeRed(configs, instantiatedIds = new Set(configs.map((config) => config.id))) {
  return {
    nodes: {
      eachNode: (callback) => configs.forEach(callback),
      getNode: (id) => (instantiatedIds.has(id) ? configs.find((config) => config.id === id) : undefined)
    },
    hooks: {
      add: () => {},
      remove: () => {}
    }
  };
}

test("unit: resolveFlow falls back to the only tab, but requires a selector when several tabs exist", () => {
  const RED = fakeRed(fixtureConfigs);
  const single = resolveFlow(RED);
  assert.equal(single.ok, true);
  assert.equal(single.flow.id, "calculator");
  assert.equal(single.selectedBy, "fallback");

  const secondTab = { id: "second-tab", type: "tab", label: "Second" };
  const ambiguous = resolveFlow(fakeRed([...fixtureConfigs, secondTab]));
  assert.equal(ambiguous.ok, false);
  assert.match(ambiguous.errors.join("\n"), /flow must be specified/);
});

test("unit: validateTarget accepts the calculator fixture without graph prediction", () => {
  const RED = fakeRed(fixtureConfigs);
  const result = validateTarget(RED, "calculate", { flow: "calculator" });

  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.targetId, "calculate");
  assert.equal("returnLinkOutIds" in result, false);
});

test("unit: validateTarget preserves duplicate id detection without predicting ordinary wires", () => {
  const broken = [
    ...fixtureConfigs,
    { id: "calculate", type: "link in", z: "calculator", name: "duplicate", wires: [["nowhere"]] }
  ];
  const RED = fakeRed(broken);
  const result = validateTarget(RED, "calculate", { flow: "calculator" });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /duplicate node id 'calculate'/);
  assert.equal(
    result.errors.some((error) => error.includes("wires to missing node")),
    false
  );
});

const secondTab = { id: "second-tab", type: "tab", label: "Second" };
const singleLinkInConfigs = fixtureConfigs.filter(
  (config) => !["slow", "delay", "slow-return"].includes(config.id)
);
const noLinkInConfigs = fixtureConfigs.filter((config) => config.type !== "link in");

test("unit: validateTarget falls back to the only link-in node (1 link-in, 1 tab -> no arguments needed)", () => {
  const RED = fakeRed(singleLinkInConfigs);
  const result = validateTarget(RED, undefined, {});

  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.targetId, "calculate");
  assert.equal(result.flowId, "calculator");
  assert.deepEqual(result.warnings, []);
});

test("unit: validateTarget requires target when several link-in nodes share the only tab (>1 link-in, 1 tab)", () => {
  const RED = fakeRed(fixtureConfigs);
  const result = validateTarget(RED, undefined, {});

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /target must be specified because 2 link-in nodes are present/);
});

test("unit: validateTarget falls back across tabs with a warning (1 link-in, >1 tabs -> no arguments but warning)", () => {
  const RED = fakeRed([...singleLinkInConfigs, secondTab]);
  const result = validateTarget(RED, undefined, {});

  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.targetId, "calculate");
  assert.equal(result.flowId, "calculator");
  assert.equal(result.warnings.length, 1);
  assert.match(
    result.warnings[0],
    /flow not specified; inferred flow 'Calculator Example' and target 'calculate'/
  );
});

test("unit: validateTarget requires both flow and target when ambiguous on both axes (>1 link-in, >1 tabs)", () => {
  const RED = fakeRed([...fixtureConfigs, secondTab]);
  const result = validateTarget(RED, undefined, {});

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /flow must be specified because 2 workspace tabs are present/);
  assert.match(
    result.errors.join("\n"),
    /target must be specified because 2 link-in nodes are present across those tabs/
  );
});

test("unit: validateTarget reports a clear error when no link-in nodes exist at all", () => {
  const RED = fakeRed(noLinkInConfigs);
  const result = validateTarget(RED, undefined, {});

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /no link-in nodes found in the flow configuration/);
});

test("unit: validateTarget still accepts an explicit target when several link-in nodes are present", () => {
  const RED = fakeRed(fixtureConfigs);
  const result = validateTarget(RED, "slow", { flow: "calculator" });

  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.targetId, "slow");
});

test("unit: validateTarget falls back within an explicitly given flow that has exactly one link-in", () => {
  const RED = fakeRed([...singleLinkInConfigs, secondTab]);
  const result = validateTarget(RED, undefined, { flow: "calculator" });

  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.targetId, "calculate");
  assert.deepEqual(result.warnings, []);
});

test("unit: validateTarget reports an invalid flow selector without throwing when target is omitted", () => {
  const result = validateTarget(fakeRed(singleLinkInConfigs), undefined, { flow: "missing-flow" });
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /flow 'missing-flow' was not found/);
});

test("unit: explicit target ID resolves across tabs; supplied flow scopes membership", () => {
  const RED = fakeRed([
    ...fixtureConfigs,
    secondTab,
    { id: "other", type: "link in", z: "second-tab", name: "same" }
  ]);
  const global = validateTarget(RED, "calculate");
  assert.equal(global.ok, true, global.errors.join("; "));
  assert.equal(global.flowId, "calculator");

  const scoped = validateTarget(RED, "calculate", { flow: "second-tab" });
  assert.equal(scoped.ok, false);
  assert.match(scoped.errors.join("\n"), /does not belong to flow/);
});

test("unit: unique names resolve, duplicate names reject, and IDs take precedence", () => {
  const renamed = fixtureConfigs.map((config) =>
    config.id === "calculate" ? { ...config, name: "named-entry" } : config
  );
  const subflowTemplate = [
    { id: "subflow-template", type: "subflow", name: "Template" },
    { id: "template-entry", type: "link in", z: "subflow-template", name: "named-entry" }
  ];
  const RED = fakeRed([
    ...renamed,
    ...subflowTemplate,
    secondTab,
    { id: "named-two", type: "link in", z: "second-tab", name: "named-entry" }
  ]);
  assert.equal(validateTarget(RED, "calculate").targetId, "calculate");
  assert.equal(validateTarget(RED, "named-entry").ok, false);
  assert.equal(
    validateTarget(fakeRed([...renamed, ...subflowTemplate]), "named-entry").targetId,
    "calculate"
  );
  assert.equal(
    validateTarget(fakeRed([...singleLinkInConfigs, ...subflowTemplate]), undefined).targetId,
    "calculate"
  );
  const wrongTypeId = validateTarget(
    fakeRed([...renamed, { id: "named-entry", type: "function", z: "calculator" }]),
    "named-entry"
  );
  assert.match(wrongTypeId.errors.join("\n"), /expected 'link in'/);
  assert.equal(
    validateTarget(
      fakeRed([...renamed, { id: "calculate-two", type: "link in", z: "calculator", name: "named-entry" }]),
      "named-entry",
      { flow: "calculator" }
    ).ok,
    false
  );
});

test("unit: configured targets that are not instantiated are rejected", () => {
  const RED = fakeRed(fixtureConfigs, new Set());
  const result = validateTarget(RED, "calculate");
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /not instantiated in the runtime/);
});

test("unit: createHostLinkCaller checks runtime hooks before registering", () => {
  const RED = fakeRed(fixtureConfigs);
  delete RED.hooks;
  assert.throws(() => createHostLinkCaller(RED), /runtime hooks are not available/);
});

test("unit: call still rejects invalid timeout and message inputs", async () => {
  const caller = createHostLinkCaller(fakeRed(fixtureConfigs));
  try {
    await assert.rejects(
      caller.call("calculate", { payload: 1 }, { timeout: 0 }),
      /timeout must be a positive/
    );
    await assert.rejects(caller.call("calculate", null), /msg must be an object/);
    await assert.rejects(caller.call("calculate", []), /msg must be an object/);
  } finally {
    caller.close();
  }
});
