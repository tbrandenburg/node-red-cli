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
