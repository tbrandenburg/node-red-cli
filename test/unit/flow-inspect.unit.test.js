"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const inspect = require("../../src/flow-inspect");

const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, "../fixtures/inspect.flows.json"), "utf8"));

test("inventory scopes workspace entries and includes subflow return containers", () => {
  const index = inspect.indexFlow(fixture);
  const result = inspect.inventory(index);
  assert.deepEqual(
    result.entries.map((entry) => entry.id),
    ["entry", "internal"]
  );
  assert.ok(result.returns.some((item) => item.id === "sf-return" && item.container.kind === "subflow"));
  assert.equal(inspect.resolveTab(index, "Public").id, "tab-a");
});

test("graph preserves ports, normalizes reverse Links, dynamic calls, and bounds cycles", () => {
  const index = inspect.indexFlow(fixture);
  const result = inspect.graph(index, inspect.resolveEntry(index, "entry"), 8);
  assert.ok(result.edges.some((edge) => edge.kind === "link" && edge.to === "internal"));
  assert.ok(result.edges.some((edge) => edge.kind === "wire" && edge.port === 1 && edge.unresolved));
  assert.ok(result.nodes.some((node) => node.key === "instance/sf-fn"));
  assert.ok(result.nodes.some((node) => node.key === "instance-2/sf-fn"));
  assert.ok(result.nodes.some((node) => node.key === "instance/sf-return"));
  assert.ok(result.nodes.some((node) => node.sourceId === "call"));
  assert.ok(result.edges.some((edge) => edge.kind === "call-dynamic" && edge.to === null));
});

test("duplicate identities and ambiguous selectors fail clearly", () => {
  assert.throws(
    () =>
      inspect.indexFlow([
        { id: "x", type: "tab" },
        { id: "x", type: "tab" }
      ]),
    /duplicate config id/
  );
  const index = inspect.indexFlow([...fixture, { id: "tab-c", type: "tab", label: "Public" }]);
  assert.throws(() => inspect.resolveTab(index, "Public"), /ambiguous/);
});

test("Link Call edges distinguish declared calls from continuations and dynamic calls", () => {
  const index = inspect.indexFlow([
    { id: "tab", type: "tab", label: "Calls" },
    { id: "entry", type: "link in", z: "tab", name: "entry", wires: [["call"]] },
    { id: "dyn-entry", type: "link in", z: "tab", name: "dynamic-entry", wires: [["dynamic"]] },
    {
      id: "call",
      type: "link call",
      z: "tab",
      links: ["callee", "stale"],
      linkType: "static",
      wires: [["after"]]
    },
    { id: "dynamic", type: "link call", z: "tab", linkType: "dynamic", links: ["callee"], wires: [[]] },
    { id: "callee", type: "link in", z: "tab", wires: [[]] },
    { id: "after", type: "link out", z: "tab", mode: "return", wires: [] }
  ]);
  const result = inspect.graph(index, inspect.resolveEntry(index, "entry"), 3);
  assert.ok(result.edges.some((edge) => edge.kind === "call" && edge.to === "callee"));
  assert.ok(result.edges.some((edge) => edge.kind === "after-return" && edge.to === "after"));
  assert.ok(index.warnings.some((warning) => warning.includes("multiple targets")));
  const dynamic = inspect.graph(index, inspect.resolveEntry(index, "dynamic-entry"), 2);
  assert.ok(dynamic.edges.some((edge) => edge.kind === "call-dynamic" && edge.to === null));
  assert.ok(!dynamic.edges.some((edge) => edge.kind === "call"));
});

test("depth levels include nodes through the limit and report only omitted expansion", () => {
  const index = inspect.indexFlow([
    { id: "tab", type: "tab" },
    { id: "entry", type: "link in", z: "tab", wires: [["one"]] },
    { id: "one", type: "function", z: "tab", wires: [["two"]] },
    { id: "two", type: "junction", z: "tab", wires: [["one"]] }
  ]);
  const root = inspect.resolveEntry(index, "entry");
  assert.deepEqual(
    inspect.graph(index, root, 0).nodes.map((node) => node.sourceId),
    ["entry"]
  );
  const one = inspect.graph(index, root, 1);
  assert.deepEqual(
    one.nodes.map((node) => node.sourceId),
    ["entry", "one"]
  );
  assert.equal(one.truncated, true);
  const two = inspect.graph(index, root, 2);
  assert.deepEqual(
    two.nodes.map((node) => node.sourceId),
    ["entry", "one", "two"]
  );
  assert.equal(two.truncated, true);
  assert.ok(two.edges.some((edge) => edge.kind === "wire" && edge.port === 0));
});

test("subflow boundary mappings handle nested instances, passthrough, missing definitions, and disabled tabs", () => {
  const index = inspect.indexFlow([
    { id: "tab", type: "tab", disabled: true },
    { id: "entry", type: "link in", z: "tab", wires: [["outer-a", "outer-b", "pass", "missing-def"]] },
    { id: "outer-a", type: "subflow:outer", z: "tab", wires: [["ret-a"]] },
    { id: "outer-b", type: "subflow:outer", z: "tab", wires: [["ret-b"]] },
    { id: "pass", type: "subflow:passthrough", z: "tab", wires: [["pass-target"]] },
    { id: "missing-def", type: "subflow:not-local", z: "tab", wires: [[]] },
    { id: "ret-a", type: "link out", z: "tab", mode: "return", wires: [] },
    { id: "ret-b", type: "link out", z: "tab", mode: "return", wires: [] },
    { id: "pass-target", type: "debug", z: "tab", wires: [[]] },
    {
      id: "outer",
      type: "subflow",
      in: [{ wires: [{ id: "nested" }] }],
      out: [{ wires: [{ id: "outer-return", port: 0 }] }]
    },
    { id: "nested", type: "subflow:inner", z: "outer", wires: [["outer-return"]] },
    { id: "outer-return", type: "link out", z: "outer", mode: "return", wires: [] },
    {
      id: "inner",
      type: "subflow",
      in: [{ wires: [{ id: "inner-return" }] }],
      out: [{ wires: [{ id: "inner", port: 0 }] }]
    },
    { id: "inner-return", type: "link out", z: "inner", mode: "return", wires: [] },
    { id: "passthrough", type: "subflow", out: [{ wires: [{ id: "passthrough", port: 0 }] }] }
  ]);
  const result = inspect.graph(index, inspect.resolveEntry(index, "entry"), 8);
  assert.ok(result.nodes.some((node) => node.key === "outer-a/nested/inner-return" && node.disabled));
  assert.ok(result.nodes.some((node) => node.key === "outer-b/nested/inner-return"));
  assert.ok(result.edges.some((edge) => edge.kind === "subflow-exit" && edge.to === "ret-a"));
  assert.ok(result.edges.some((edge) => edge.kind === "subflow-exit" && edge.to === "pass-target"));
  assert.ok(index.warnings.some((warning) => warning.includes("not-local")));
});

test("tab filtering, entry ID precedence, and malformed link declarations are explicit", () => {
  const index = inspect.indexFlow([
    { id: "a", type: "tab", label: "Same" },
    { id: "b", type: "tab", label: "Other" },
    { id: "entry", type: "link in", z: "a", name: "b", wires: [[]] },
    { id: "named-entry", type: "link in", z: "a", name: "entry", wires: [[]] },
    { id: "other", type: "link in", z: "b", name: "unique", links: ["missing-out"], wires: [[]] },
    { id: "broken-out", type: "link out", z: "a", links: ["not-link-in"], wires: [] },
    { id: "not-link-in", type: "debug", z: "a", wires: [] }
  ]);
  assert.equal(inspect.resolveEntry(index, "entry").id, "entry");
  assert.throws(() => inspect.resolveEntry(index, "entry", inspect.resolveTab(index, "b")), /not in tab/);
  assert.deepEqual(
    inspect.inventory(index, inspect.resolveTab(index, "a")).entries.map((item) => item.id),
    ["entry", "named-entry"]
  );
  assert.deepEqual(
    inspect.inventory(index, inspect.resolveTab(index, "Same")).entries.map((item) => item.id),
    ["entry", "named-entry"]
  );
  assert.ok(index.warnings.some((warning) => warning.includes("missing-out")));
  assert.ok(index.warnings.some((warning) => warning.includes("not-link-in")));
  assert.throws(() => inspect.indexFlow([{ id: "missing-type" }]), /id and type/);
  assert.ok(
    inspect
      .indexFlow([{ id: "bad-links", type: "link in", links: "not-an-array" }])
      .warnings.some((warning) => warning.includes("malformed"))
  );
  assert.throws(() => inspect.indexFlow([null]), /must be an object/);
});

test("malformed subflow mappings produce warnings instead of aborting traversal", () => {
  const index = inspect.indexFlow([
    { id: "tab", type: "tab" },
    { id: "entry", type: "link in", z: "tab", wires: [["instance"]] },
    { id: "instance", type: "subflow:broken", z: "tab", wires: [[]] },
    { id: "broken", type: "subflow", in: {}, out: [{ wires: {} }] }
  ]);
  const result = inspect.graph(index, inspect.resolveEntry(index, "entry"), 3);
  assert.ok(result.nodes.some((node) => node.sourceId === "instance"));
  assert.ok(index.warnings.some((warning) => warning.includes("mappings")));
});
