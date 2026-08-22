"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { test } = require("node:test");
const { resolveFlow, validateTarget } = require("../../src/link-call");

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

test("unit: validateTarget accepts the calculator fixture and reports its return link out", () => {
  const RED = fakeRed(fixtureConfigs);
  const result = validateTarget(RED, "calculate", { flow: "calculator" });

  assert.equal(result.ok, true, result.errors.join("; "));
  assert.equal(result.targetId, "calculate");
  assert.deepEqual(result.returnLinkOutIds, ["return"]);
});

test("unit: validateTarget reports missing wire targets and duplicate node ids", () => {
  const broken = [
    ...fixtureConfigs,
    { id: "calculate", type: "link in", z: "calculator", name: "duplicate", wires: [["nowhere"]] }
  ];
  const RED = fakeRed(broken);
  const result = validateTarget(RED, "calculate", { flow: "calculator" });

  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /duplicate node id 'calculate'/);
  assert.match(result.errors.join("\n"), /wires to missing node 'nowhere'/);
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
