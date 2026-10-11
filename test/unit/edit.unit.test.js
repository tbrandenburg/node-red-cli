"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { createEditClient, DEFAULT_ADMIN_URL } = require("../../src/edit-api");
const { listNodes, getNodeContext } = require("../../src/edit-query");
const { parsePlan, transformPlan } = require("../../src/edit-plan");

const flows = [
  { id: "tab-a", type: "tab", label: "Main" },
  { id: "one", type: "inject", z: "tab-a", name: "Alpha", wires: [["two"]], x: 1, y: 2 },
  {
    id: "two",
    type: "function",
    z: "tab-a",
    name: "Beta",
    x: 2,
    y: 3,
    func: "return msg",
    wires: [[]],
    credentials: { password: "private" }
  },
  { id: "cfg", type: "mqtt-broker", broker: "localhost" }
];

function response(status, value) {
  return { ok: status >= 200 && status < 300, status, json: async () => value };
}

test("Admin API v2 GET uses safe URL, bearer auth and validates opaque revision", async () => {
  let call;
  const client = createEditClient({
    adminUrl: "http://127.0.0.1:1880/admin/",
    token: "secret-token",
    fetchImpl: async (url, options) => {
      call = { url: String(url), options };
      return response(200, { rev: "opaque/rev", flows });
    }
  });
  assert.equal(DEFAULT_ADMIN_URL, "http://127.0.0.1:1880");
  assert.deepEqual(await client.getFlows(), { rev: "opaque/rev", flows });
  assert.equal(call.url, "http://127.0.0.1:1880/admin/flows");
  assert.equal(call.options.headers.Authorization, "Bearer secret-token");
  assert.equal(call.options.headers["Node-RED-API-Version"], "v2");
  assert.equal(call.options.redirect, "error");
});

test("Admin API rejects unsafe URLs, v1 responses, missing revisions and write without revision", async () => {
  assert.throws(() => createEditClient({ adminUrl: "http://example.com" }), /HTTPS/);
  assert.throws(() => createEditClient({ adminUrl: "http://user:pass@127.0.0.1" }), /without credentials/);
  const client = createEditClient({ fetchImpl: async () => response(200, flows) });
  await assert.rejects(client.getFlows(), /nonempty rev and flows array/);
  assert.throws(() => client.postFlows({ rev: "  ", flows }), /nonempty revision/);
});

test("Admin API POST includes v2 full deploy and exact revision, never raw error body", async () => {
  let options;
  const client = createEditClient({
    fetchImpl: async (_url, init) => {
      options = init;
      return response(200, { rev: "new-rev" });
    }
  });
  assert.deepEqual(await client.postFlows({ rev: "exact-rev", flows }), { rev: "new-rev" });
  assert.deepEqual(JSON.parse(options.body), { rev: "exact-rev", flows });
  assert.equal(options.headers["Node-RED-Deployment-Type"], "full");
  const conflict = createEditClient({
    fetchImpl: async () => ({ ok: false, status: 409, json: async () => ({ error: "private raw" }) })
  });
  await assert.rejects(
    conflict.getFlows(),
    (error) => error.message.includes("409") && !error.message.includes("private raw")
  );
});

test("credential schema lookup uses safe Admin API values and returns field names only", async () => {
  let url;
  const client = createEditClient({
    adminUrl: "http://127.0.0.1:1880/admin",
    fetchImpl: async (requestUrl) => {
      url = String(requestUrl);
      return response(200, { username: "hidden-user", has_password: true });
    }
  });
  assert.deepEqual(await client.getCredentialSchema("test:node", "node/1"), {
    username: "text",
    password: "password"
  });
  assert.equal(url, "http://127.0.0.1:1880/admin/credentials/test%3Anode/node%2F1");
});

test("installed node type lookup uses the native Admin API nodes endpoint", async () => {
  let url;
  const client = createEditClient({
    adminUrl: "http://127.0.0.1:1880/admin",
    fetchImpl: async (requestUrl) => {
      url = String(requestUrl);
      return response(200, [
        { enabled: true, types: ["inject", "function"] },
        { enabled: false, types: ["disabled-node"] },
        { enabled: true, types: ["debug"] }
      ]);
    }
  });
  assert.deepEqual(await client.getNodeTypes(), ["inject", "function", "debug"]);
  assert.equal(url, "http://127.0.0.1:1880/admin/nodes");
});

test("live list filters preserve order, exclude config nodes and calculate pre-limit total", () => {
  const scopedConfig = { id: "scoped-config", type: "mqtt-broker", z: "tab-a", broker: "localhost" };
  const result = listNodes([...flows, scopedConfig], { search: "a", limit: 1 });
  assert.equal(result.total, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.nodes[0].id, "one");
  assert.deepEqual(result.tabs, [{ id: "tab-a", label: "Main", nodeCount: 2 }]);
  const configNodes = listNodes([...flows, scopedConfig], { kind: "config" });
  assert.deepEqual(
    configNodes.nodes.map((node) => [node.id, node.tabId]),
    [
      ["cfg", null],
      ["scoped-config", "tab-a"]
    ]
  );
  assert.throws(() => listNodes(flows, { kind: "unknown" }), /kind must be workspace or config/);
  assert.throws(() => listNodes(flows, { tab: "missing" }), /not found/);
});

test("node context separates ordinary wires and excludes credentials", () => {
  const result = getNodeContext(flows, "two");
  assert.equal(result.tab.id, "tab-a");
  assert.deepEqual(result.incoming, [{ from: "one", port: 0 }]);
  assert.equal("credentials" in result.node, false);
  assert.throws(() => getNodeContext(flows, "missing"), /not found/);
  const subflowNode = getNodeContext(require("../fixtures/native-cross-tab.flows.json"), "native-calculate");
  assert.equal(subflowNode.tab, null);
  assert.deepEqual(subflowNode.subflow, { id: "multiply", name: "Multiply" });
});

test("plan parser and transformer are strict, pure, ordered and protect structural/sensitive fields", () => {
  const plan = parsePlan(
    JSON.stringify({
      rev: "rev",
      ops: [{ op: "set", id: "two", fields: { name: "Updated", func: "return msg;" } }]
    })
  );
  const before = structuredClone(flows);
  const result = transformPlan(flows, plan);
  assert.deepEqual(flows, before);
  assert.deepEqual(
    result.flows.map((node) => node.id),
    flows.map((node) => node.id)
  );
  assert.equal(result.flows[2].credentials.password, "private");
  assert.equal(result.flows[2].func, "return msg;");
  assert.throws(() => parsePlan('{"rev":"","ops":[]}'), /nonempty string/);
  for (const field of ["id", "wires", "credentials", "secret", "apiKey", "constructor"]) {
    assert.throws(
      () =>
        transformPlan(flows, { rev: "rev", ops: [{ op: "set", id: "two", fields: { [field]: "unsafe" } }] }),
      /protected|sensitive/
    );
  }
  assert.throws(
    () =>
      transformPlan(flows, { rev: "rev", ops: [{ op: "set", id: "cfg", fields: { broker: "changed" } }] }),
    /ordinary workspace/
  );
  const nestedSecrets = structuredClone(flows);
  nestedSecrets[2].settings = { nested: { password: "nested-secret-sentinel" } };
  const safeDiff = transformPlan(nestedSecrets, {
    rev: "rev",
    ops: [{ op: "set", id: "two", fields: { settings: { nested: { other: 2 } } } }]
  });
  assert.doesNotMatch(JSON.stringify(safeDiff.changes), /nested-secret-sentinel/);
});

test("set renames Link nodes by exact ID without changing relationships", () => {
  const graph = [
    { id: "tab", type: "tab", label: "Main" },
    {
      id: "entry",
      type: "link in",
      z: "tab",
      x: 1,
      y: 2,
      name: "Entry",
      links: ["out"],
      wires: [["worker"]]
    },
    { id: "worker", type: "function", z: "tab", x: 3, y: 4, wires: [[]] },
    { id: "out", type: "link out", z: "tab", x: 5, y: 6, mode: "link", links: ["entry"], wires: [] },
    { id: "return", type: "link out", z: "tab", x: 7, y: 8, mode: "return", links: [], wires: [] },
    { id: "call", type: "link call", z: "tab", x: 9, y: 10, mode: "static", links: ["entry"], wires: [[]] },
    { id: "dynamic", type: "link call", z: "tab", x: 11, y: 12, mode: "dynamic", links: [], wires: [[]] }
  ];
  const original = structuredClone(graph);
  const ops = [
    ["entry", "Entry renamed"],
    ["out", "Out renamed"],
    ["return", "Return renamed"],
    ["call", "Call renamed"],
    ["dynamic", "Dynamic renamed"]
  ].map(([id, name]) => ({ op: "set", id, fields: { name } }));
  const result = transformPlan(graph, { rev: "rev", ops });
  assert.deepEqual(graph, original);
  assert.deepEqual(
    result.changes.map(({ id, fields }) => [id, Object.keys(fields)]),
    [
      ["entry", ["name"]],
      ["out", ["name"]],
      ["return", ["name"]],
      ["call", ["name"]],
      ["dynamic", ["name"]]
    ]
  );
  for (const node of original.filter(({ type }) => type.startsWith("link "))) {
    const renamed = result.flows.find(({ id }) => id === node.id);
    assert.deepEqual({ ...renamed, name: undefined }, { ...node, name: undefined });
  }
  assert.deepEqual(
    result.flows.map(({ id }) => id),
    original.map(({ id }) => id)
  );

  const cleared = transformPlan(graph, {
    rev: "rev",
    ops: [{ op: "set", id: "entry", fields: { name: "" } }]
  });
  assert.equal(cleared.flows.find(({ id }) => id === "entry").name, "");
  assert.throws(
    () => transformPlan(graph, { rev: "rev", ops: [{ op: "set", id: "entry", fields: { name: "Entry" } }] }),
    /does not change/
  );

  for (const fields of [
    { links: [] },
    { wires: [] },
    { mode: "return" },
    { linkType: "dynamic" },
    { id: "other" },
    { z: "other" },
    { x: 0 },
    { unknown: true },
    { name: "Entry", mode: "return" },
    { name: null },
    { name: [] },
    { name: 1 },
    { name: {} }
  ])
    assert.throws(
      () => transformPlan(graph, { rev: "rev", ops: [{ op: "set", id: "entry", fields }] }),
      /Link node name|Link nodes may change only/
    );
  assert.throws(
    () => transformPlan(graph, { rev: "rev", ops: [{ op: "set", id: "missing", fields: { name: "x" } }] }),
    /was not found/
  );
});

test("add is deterministic, validates inputs, and supports later connect operations", () => {
  const node = { id: "debug-new", type: "debug", z: "tab-a", x: 10, y: 20, wires: [] };
  const original = structuredClone(flows);
  const result = transformPlan(flows, {
    rev: "rev",
    ops: [
      { op: "add", node, assumeOrdinary: true },
      { op: "connect", from: "one", port: 0, to: "debug-new" }
    ]
  });
  assert.deepEqual(flows, original);
  assert.deepEqual(
    result.flows.map((node) => node.id),
    [...flows.map((node) => node.id), "debug-new"]
  );
  assert.deepEqual(result.flows[1].wires, [["two", "debug-new"]]);
  assert.match(result.warnings[0], /explicitly assumed ordinary/);
  assert.throws(
    () => transformPlan(flows, { rev: "rev", ops: [{ op: "add", node }] }),
    /assumeOrdinary:true/
  );
  assert.throws(
    () =>
      transformPlan(flows, {
        rev: "rev",
        ops: [
          { op: "add", node, assumeOrdinary: true },
          { op: "add", node: { ...node, id: "debug-again" } }
        ]
      }),
    /assumeOrdinary:true/
  );
  const knownType = transformPlan(flows, {
    rev: "rev",
    ops: [{ op: "add", node: { ...node, id: "another-inject", type: "inject" } }]
  });
  assert.deepEqual(knownType.warnings, []);
  for (const bad of [
    { ...node, id: "one" },
    { ...node, id: "bad-coord", x: Infinity },
    { ...node, id: "bad-wire", wires: ["two"] },
    { ...node, id: "bad-sensitive", config: [{ password: "x" }] },
    { ...node, id: "bad-structural", type: "link out" },
    { ...node, id: "bad-config", type: "mqtt-broker" }
  ]) {
    assert.throws(() => transformPlan(flows, { rev: "rev", ops: [{ op: "add", node: bad }] }));
  }
  assert.throws(
    () =>
      transformPlan(flows, {
        rev: "rev",
        ops: [{ op: "add", node: { ...node, z: "missing" }, assumeOrdinary: true }]
      }),
    /existing tab or subflow owner/
  );
  const crossOwner = [
    ...structuredClone(flows),
    { id: "tab-b", type: "tab" },
    { id: "remote", type: "debug", z: "tab-b", wires: [] }
  ];
  assert.throws(
    () =>
      transformPlan(crossOwner, {
        rev: "rev",
        ops: [
          {
            op: "add",
            node: { ...node, id: "bad-cross-wire", wires: [["remote"]] },
            assumeOrdinary: true
          }
        ]
      }),
    /crosses workspace owners/
  );
});

test("connect and disconnect are port-aware and reject invalid or cross-tab edges", () => {
  const routed = [{ id: "tab-a", type: "tab" }, ...flows.slice(1, 3)];
  routed[1].wires = [["two"], []];
  routed[1].outputs = 2;
  const result = transformPlan(routed, {
    rev: "rev",
    ops: [
      { op: "disconnect", from: "one", port: 0, to: "two" },
      { op: "connect", from: "one", port: 1, to: "two" }
    ]
  });
  assert.deepEqual(result.flows[1].wires, [[], ["two"]]);
  for (const op of [
    { op: "connect", from: "one", port: 0, to: "two" },
    { op: "connect", from: "one", port: -1, to: "two" },
    { op: "connect", from: "one", port: 2, to: "two" },
    { op: "disconnect", from: "one", port: 1, to: "two" }
  ])
    assert.throws(() => transformPlan(routed, { rev: "rev", ops: [op] }));
  assert.throws(
    () =>
      transformPlan(
        [...routed, { id: "tab-b", type: "tab" }, { id: "three", type: "debug", z: "tab-b", wires: [[]] }],
        {
          rev: "rev",
          ops: [{ op: "connect", from: "one", port: 0, to: "three" }]
        }
      ),
    /across tabs/
  );
  const native = [
    { id: "tab", type: "tab" },
    { id: "function", type: "function", z: "tab", wires: [["return"]] },
    { id: "return", type: "link out", z: "tab", mode: "return", links: [], wires: [] }
  ];
  const disconnectedLinkOutWire = transformPlan(native, {
    rev: "rev",
    ops: [{ op: "disconnect", from: "function", port: 0, to: "return" }]
  });
  assert.deepEqual(disconnectedLinkOutWire.flows.find((node) => node.id === "function").wires, [[]]);
  const linkInGraph = [
    { id: "tab", type: "tab" },
    { id: "function", type: "function", z: "tab", wires: [[]] },
    { id: "in", type: "link in", z: "tab", links: [], wires: [[]] }
  ];
  assert.throws(
    () =>
      transformPlan(linkInGraph, {
        rev: "rev",
        ops: [{ op: "connect", from: "function", port: 0, to: "in" }]
      }),
    /compatible ordinary wire targets/
  );
});

test("delete cleans owned wires and group membership but refuses structural or unknown references", () => {
  const graph = [
    { id: "tab-a", type: "tab" },
    { id: "one", type: "inject", z: "tab-a", x: 80, y: 120, wires: [["two", "three"]] },
    { id: "two", type: "debug", z: "tab-a", x: 180, y: 100, g: "group-a", wires: [[]] },
    { id: "three", type: "debug", z: "tab-a", x: 180, y: 160, g: "group-a", wires: [[]] },
    { id: "group-a", type: "group", z: "tab-a", x: 120, y: 60, w: 240, h: 140, nodes: ["two", "three"] }
  ];
  const result = transformPlan(graph, { rev: "rev", ops: [{ op: "delete", id: "two" }] });
  assert.deepEqual(
    result.flows.map((node) => node.id),
    ["tab-a", "one", "three", "group-a"]
  );
  assert.deepEqual(result.flows[1].wires, [["three"]]);
  assert.deepEqual(result.flows[3].nodes, ["three"]);
  assert.deepEqual(graph[1].wires, [["two", "three"]]);
  assert.throws(
    () =>
      transformPlan(
        [...graph, { id: "ref", type: "custom", z: "tab-a", wires: [[]], nested: { target: "two" } }],
        {
          rev: "rev",
          ops: [{ op: "delete", id: "two" }]
        }
      ),
    /unsafe reference.*ref.nested.target/
  );
  assert.throws(
    () => transformPlan(flows, { rev: "rev", ops: [{ op: "delete", id: "cfg" }] }),
    /ordinary workspace/
  );
  assert.throws(
    () =>
      transformPlan([...flows, { id: "link-ref", type: "link out", z: "tab-a", links: ["two"], wires: [] }], {
        rev: "rev",
        ops: [{ op: "delete", id: "two" }]
      }),
    /unsafe reference/
  );
});

test("tab reorder moves tab slots only and tab deletion refuses owned content", () => {
  const graph = [
    { id: "a", type: "tab" },
    { id: "n", type: "inject", z: "a", x: 10, y: 20, wires: [[]] },
    { id: "b", type: "tab" }
  ];
  const reordered = transformPlan(graph, {
    rev: "r",
    ops: [{ op: "tab", action: "reorder", order: ["b", "a"] }]
  });
  assert.deepEqual(
    reordered.flows.map((item) => item.id),
    ["b", "n", "a"]
  );
  assert.deepEqual(reordered.changeCounts, { nodes: 0, flowMetadata: 1 });
  assert.equal(reordered.summary, "0 nodes changed; flow order changed");
  assert.deepEqual(reordered.changes, [{ id: "flow-order", type: "flow", action: "reordered" }]);
  const nodeAndOrder = transformPlan(graph, {
    rev: "r",
    ops: [
      { op: "set", id: "n", fields: { name: "Updated" } },
      { op: "tab", action: "reorder", order: ["b", "a"] }
    ]
  });
  assert.deepEqual(nodeAndOrder.changeCounts, { nodes: 1, flowMetadata: 1 });
  assert.equal(nodeAndOrder.summary, "1 node changed; flow order changed");
  assert.deepEqual(nodeAndOrder.changes.at(-1), { id: "flow-order", type: "flow", action: "reordered" });
  const nodeOnly = transformPlan(graph, {
    rev: "r",
    ops: [{ op: "set", id: "n", fields: { name: "Updated" } }]
  });
  assert.deepEqual(nodeOnly.changeCounts, { nodes: 1, flowMetadata: 0 });
  assert.equal(nodeOnly.summary, "1 node changed");
  assert.throws(
    () => transformPlan(graph, { rev: "r", ops: [{ op: "tab", action: "delete", id: "a" }] }),
    /nonempty/
  );
});

test("groups keep nodes and g membership synchronized", () => {
  const graph = [
    { id: "a", type: "tab" },
    { id: "n", type: "inject", z: "a", x: 10, y: 10, wires: [[]] }
  ];
  const result = transformPlan(graph, {
    rev: "r",
    ops: [
      {
        op: "group",
        action: "add",
        group: { id: "g", type: "group", z: "a", x: 0, y: 0, w: 100, h: 80, nodes: ["n"] }
      }
    ]
  });
  assert.deepEqual(result.flows[2].nodes, ["n"]);
  assert.equal(result.flows[1].g, "g");
  assert.throws(
    () =>
      transformPlan(result.flows, {
        rev: "r",
        ops: [{ op: "group", action: "set", id: "g", fields: { x: 500 } }]
      }),
    /bounds do not contain member/
  );
  const removed = transformPlan(result.flows, {
    rev: "r",
    ops: [{ op: "group", action: "delete", id: "g" }]
  });
  assert.equal("g" in removed.flows[1], false);
  const referencedGroup = [
    ...result.flows,
    { id: "external-reference", type: "custom", nested: { groupId: "g" } }
  ];
  assert.throws(
    () =>
      transformPlan(referencedGroup, {
        rev: "r",
        ops: [{ op: "group", action: "delete", id: "g" }]
      }),
    /referenced at 'external-reference.nested.groupId'/
  );
});

test("config deletion refuses recursive exact references and credential edits", () => {
  const graph = [
    ...structuredClone(flows),
    { id: "ref", type: "custom", z: "tab-a", config: { nested: { broker: "cfg" } }, wires: [] }
  ];
  assert.throws(
    () => transformPlan(graph, { rev: "r", ops: [{ op: "config", action: "delete", id: "cfg" }] }),
    /referenced/
  );
  assert.throws(
    () =>
      transformPlan(flows, {
        rev: "r",
        ops: [{ op: "config", action: "set", id: "cfg", fields: { credentials: {} } }]
      }),
    /invalid config set/
  );
  const globalConfig = transformPlan(flows, {
    rev: "r",
    ops: [
      {
        op: "config",
        action: "add",
        node: { id: "global-config", type: "mqtt-broker", z: "", broker: "localhost", port: "1883" }
      }
    ]
  });
  assert.equal(globalConfig.flows.find((node) => node.id === "global-config").z, "");
  assert.throws(
    () =>
      transformPlan(flows, {
        rev: "r",
        ops: [
          { op: "config", action: "delete", id: "cfg" },
          {
            op: "add",
            node: {
              id: "broker-after-delete",
              type: "mqtt-broker",
              z: "tab-a",
              x: 10,
              y: 20,
              wires: []
            },
            assumeOrdinary: true
          }
        ]
      }),
    /config node type/
  );
});

test("ordinary set/delete reject tab-scoped config nodes while config operations handle them", () => {
  const scoped = {
    id: "scoped-config",
    type: "mqtt-broker",
    z: "tab-a",
    broker: "localhost",
    port: "1883"
  };
  const graph = [...flows, scoped];
  for (const op of [
    { op: "set", id: scoped.id, fields: { broker: "new-host" } },
    { op: "delete", id: scoped.id }
  ])
    assert.throws(() => transformPlan(graph, { rev: "r", ops: [op] }), /ordinary workspace/);

  const configEdit = transformPlan(graph, {
    rev: "r",
    ops: [
      { op: "config", action: "set", id: scoped.id, fields: { broker: "new-host" } },
      { op: "config", action: "delete", id: scoped.id }
    ]
  });
  assert.equal(
    configEdit.flows.some((node) => node.id === scoped.id),
    false
  );
});

test("credential operations require schema, accept env names, and redact values", () => {
  const graph = [
    { id: "tab", type: "tab" },
    { id: "auth", type: "custom-auth", z: "tab", wires: [[]] }
  ];
  const schema = { "custom-auth": { username: { type: "text" }, password: { type: "password" } } };
  const sentinel = "credential-test-sentinel";
  process.env.NR_EDIT_TEST_SECRET = sentinel;
  try {
    const plan = {
      rev: "r",
      ops: [
        {
          op: "credential",
          action: "set",
          id: "auth",
          values: { username: { env: "NR_EDIT_TEST_SECRET" } }
        }
      ]
    };
    const preview = transformPlan(graph, plan, { credentialSchemas: schema });
    assert.doesNotMatch(JSON.stringify(preview.changes), new RegExp(sentinel));
    assert.equal(preview.changes[0].fields.credentials.after, "[REDACTED]");
    const applied = transformPlan(graph, plan, {
      credentialSchemas: schema,
      resolveCredentialValues: true
    });
    assert.equal(applied.flows[1].credentials.username, sentinel);
    assert.throws(() => transformPlan(graph, plan), /schema.*could not be verified/);
    const cleared = transformPlan(
      graph,
      { rev: "r", ops: [{ op: "credential", action: "clear", id: "auth", keys: ["password"] }] },
      { credentialSchemas: schema }
    );
    assert.deepEqual(cleared.flows[1].credentials, { password: "" });
  } finally {
    delete process.env.NR_EDIT_TEST_SECRET;
  }
});

test("native link operations keep links distinct from wires and reject return misuse", () => {
  const graph = structuredClone(require("../fixtures/native-cross-tab.flows.json"));
  const result = transformPlan(graph, {
    rev: "r",
    ops: [{ op: "link", action: "disconnect", from: "cross", to: "internal" }]
  });
  assert.deepEqual(result.flows.find((item) => item.id === "cross").links, []);
  assert.deepEqual(result.flows.find((item) => item.id === "cross").wires, []);
  assert.throws(
    () =>
      transformPlan(graph, {
        rev: "r",
        ops: [{ op: "link", action: "connect", from: "native-return", to: "internal" }]
      }),
    /return-mode/
  );
  assert.throws(
    () => transformPlan(graph, { rev: "r", ops: [{ op: "link", action: "delete", id: "cross" }] }),
    /while its links are connected/
  );
  const disconnected = transformPlan(graph, {
    rev: "r",
    ops: [
      { op: "disconnect", from: "entry", port: 0, to: "cross" },
      { op: "link", action: "disconnect", from: "cross", to: "internal" },
      { op: "link", action: "delete", id: "cross" }
    ]
  });
  assert.equal(
    disconnected.flows.some((item) => item.id === "cross"),
    false
  );
  assert.deepEqual(disconnected.flows.find((item) => item.id === "internal").links, []);
  const addedCall = transformPlan(graph, {
    rev: "r",
    ops: [
      {
        op: "link",
        action: "add",
        node: {
          id: "new-static-call",
          type: "link call",
          linkType: "static",
          z: "nested-tab",
          x: 400,
          y: 300,
          links: [],
          wires: [[]]
        }
      },
      { op: "link", action: "connect", from: "new-static-call", to: "inner-entry" }
    ]
  });
  assert.deepEqual(addedCall.flows.find((item) => item.id === "new-static-call").links, ["inner-entry"]);
  assert.throws(
    () =>
      transformPlan(graph, {
        rev: "r",
        ops: [
          {
            op: "link",
            action: "add",
            node: {
              id: "unconnected-static-call",
              type: "link call",
              linkType: "static",
              z: "nested-tab",
              x: 400,
              y: 300,
              links: [],
              wires: [[]]
            }
          }
        ]
      }),
    /exactly one target/
  );
});

test("subflow definitions use native descriptors and reject recursive instances and port mismatches", () => {
  const graph = structuredClone(require("../fixtures/native-cross-tab.flows.json"));
  assert.throws(
    () =>
      transformPlan(graph, {
        rev: "r",
        ops: [{ op: "subflow", action: "ports", id: "multiply", in: [], out: [] }]
      }),
    /mismatches instance/
  );
  assert.throws(
    () =>
      transformPlan(graph, {
        rev: "r",
        ops: [
          {
            op: "subflow",
            action: "add-instance",
            node: { id: "cycle", type: "subflow:multiply", z: "multiply", x: 1, y: 2, wires: [[]] }
          }
        ]
      }),
    /recursive|cyclic/
  );
  const nested = transformPlan(graph, {
    rev: "r",
    ops: [
      {
        op: "subflow",
        action: "add-instance",
        node: { id: "nested-instance", type: "subflow:returning", z: "multiply", x: 20, y: 30, wires: [] }
      }
    ]
  });
  assert.equal(nested.flows.at(-1).z, "multiply");
});

test("subflow instances require a unique string id and valid output target arrays", () => {
  const graph = structuredClone(require("../fixtures/native-cross-tab.flows.json"));
  const instance = { id: "new-instance", type: "subflow:multiply", z: "second", x: 1, y: 2, wires: [[]] };
  const result = transformPlan(graph, {
    rev: "r",
    ops: [{ op: "subflow", action: "add-instance", node: instance }]
  });
  assert.equal(result.flows.at(-1).id, "new-instance");
  for (const invalid of [
    { ...instance, id: 42 },
    { ...instance, id: "  " },
    { ...instance, id: "instance" },
    { ...instance, wires: [null] },
    { ...instance, wires: [[null]] },
    { ...instance, wires: [["missing-target"]] }
  ])
    assert.throws(() =>
      transformPlan(graph, {
        rev: "r",
        ops: [{ op: "subflow", action: "add-instance", node: invalid }]
      })
    );
});

test("subflow instance deletion cleans wires but refuses nested special references", () => {
  const graph = structuredClone(require("../fixtures/native-cross-tab.flows.json"));
  const cleaned = transformPlan(graph, {
    rev: "r",
    ops: [{ op: "subflow", action: "delete-instance", id: "instance" }]
  });
  assert.deepEqual(cleaned.flows.find((item) => item.id === "internal").wires, [[]]);
  assert.equal(
    cleaned.flows.some((item) => item.id === "instance"),
    false
  );

  const referenced = [
    ...graph,
    {
      id: "special-ref",
      type: "custom",
      z: "second",
      wires: [[]],
      config: { nested: { target: "instance" } }
    }
  ];
  assert.throws(
    () =>
      transformPlan(referenced, {
        rev: "r",
        ops: [{ op: "subflow", action: "delete-instance", id: "instance" }]
      }),
    /referenced at 'special-ref.config.nested.target'/
  );

  const grouped = [
    ...graph,
    { id: "group-instance", type: "group", z: "second", x: 100, y: 100, w: 300, h: 200, nodes: ["instance"] }
  ];
  grouped.find((item) => item.id === "instance").g = "group-instance";
  const ungrouped = transformPlan(grouped, {
    rev: "r",
    ops: [{ op: "subflow", action: "delete-instance", id: "instance" }]
  });
  assert.deepEqual(ungrouped.flows.find((item) => item.id === "group-instance").nodes, []);
});

test("subflow definition deletion uses exact references and only removes empty definitions", () => {
  const definition = { id: "empty-definition", type: "subflow", name: "Empty", in: [], out: [] };
  const removed = transformPlan([...flows, definition], {
    rev: "r",
    ops: [{ op: "subflow", action: "delete-definition", id: definition.id }]
  });
  assert.equal(
    removed.flows.some((item) => item.id === definition.id),
    false
  );

  const referenced = [
    ...flows,
    definition,
    { id: "consumer", type: "custom", configuration: { subflow: "empty-definition" } }
  ];
  assert.throws(
    () =>
      transformPlan(referenced, {
        rev: "r",
        ops: [{ op: "subflow", action: "delete-definition", id: definition.id }]
      }),
    /referenced at 'consumer.configuration.subflow'/
  );
});
