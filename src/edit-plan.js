"use strict";

const FORBIDDEN = new Set([
  "id",
  "type",
  "z",
  "g",
  "wires",
  "links",
  "outputs",
  "credentials",
  "__proto__",
  "prototype",
  "constructor"
]);
const WORKSPACE_EXCLUDED = new Set(["tab", "group", "subflow"]);
const DANGEROUS_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function parsePlan(text) {
  let plan;
  try {
    plan = JSON.parse(text);
  } catch {
    throw new Error("plan file must contain valid JSON");
  }
  if (
    !plan ||
    typeof plan !== "object" ||
    Array.isArray(plan) ||
    Object.keys(plan).some((key) => !["rev", "ops"].includes(key))
  )
    throw new Error("plan must contain only rev and ops");
  if (typeof plan.rev !== "string" || !plan.rev.trim()) throw new Error("plan rev must be a nonempty string");
  if (!Array.isArray(plan.ops) || plan.ops.length === 0) throw new Error("plan ops must be a nonempty array");
  return plan;
}

function transformPlan(flows, plan, { resolveCredentialValues = false, credentialSchemas = {} } = {}) {
  if (!Array.isArray(flows)) throw new Error("flows must be an array");
  const ids = new Set();
  for (const node of flows) {
    if (!node || typeof node !== "object" || Array.isArray(node))
      throw new Error("flows must contain only node objects");
    if (typeof node.id !== "string" || !node.id.trim())
      throw new Error("every flow node needs a nonempty string id");
    if (ids.has(node.id)) throw new Error(`duplicate flow node id '${node.id}'`);
    ids.add(node.id);
  }
  const result = structuredClone(flows);
  for (const op of plan.ops) {
    if (!op || typeof op !== "object" || Array.isArray(op) || typeof op.op !== "string")
      throw new Error("unsupported or invalid plan operation");
    const handler = OPERATIONS[op.op];
    if (!handler) throw new Error(`unsupported plan operation '${op.op}'`);
    handler(result, op, { resolveCredentialValues, credentialSchemas });
  }
  const structures = require("./edit-structures");
  structures.validateLinks(result);
  structures.validateSubflows(result);
  structures.validateGroups(result);
  validateOrdinaryWires(result);
  const changes = [];
  const beforeById = new Map(flows.map((node) => [node.id, node]));
  const afterById = new Map(result.map((node) => [node.id, node]));
  for (const [id, before] of beforeById) {
    const after = afterById.get(id);
    if (!after) {
      changes.push({ id, type: before.type, action: "removed" });
      continue;
    }
    const fields = {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
      if (JSON.stringify(before[key]) !== JSON.stringify(after[key]))
        fields[key] = { before: before[key], after: after[key] };
    }
    if (Object.keys(fields).length)
      changes.push({ id, type: after.type, action: "updated", fields: redactFields(fields) });
  }
  for (const [id, after] of afterById) {
    if (!beforeById.has(id)) changes.push({ id, type: after.type, action: "added", node: redactNode(after) });
  }
  if (flows.map((node) => node.id).join("\u0000") !== result.map((node) => node.id).join("\u0000"))
    changes.push({ id: "flow-order", type: "flow", action: "reordered" });
  if (changes.length === 0) throw new Error("plan does not change any flow fields");
  return {
    flows: result,
    changes,
    summary: `${changes.length} node${changes.length === 1 ? "" : "s"} changed`
  };
}

// Keep operation families isolated here so later structural handlers can be added
// without changing the shared preview/apply transformation contract.
const OPERATIONS = {
  set(result, op) {
    assertOperationKeys(op, ["op", "id", "fields"]);
    if (typeof op.id !== "string" || !op.id) throw new Error("set requires an exact node id");
    const node = findOrdinaryNode(result, op.id, "set");
    if (
      !op.fields ||
      typeof op.fields !== "object" ||
      Array.isArray(op.fields) ||
      Object.keys(op.fields).length === 0
    )
      throw new Error("set fields must be a nonempty object");
    validateFields(op.fields);
    Object.assign(node, structuredClone(op.fields));
  },
  credential(result, op, context) {
    assertOperationKeys(op, ["op", "action", "id", "values", "keys"]);
    if (typeof op.id !== "string" || !op.id) throw new Error("credential requires an exact node id");
    const node = result.find((item) => item?.id === op.id);
    if (!node) throw new Error(`node '${op.id}' was not found`);
    const schema = context.credentialSchemas[node.type];
    if (!schema || typeof schema !== "object" || Array.isArray(schema) || Object.keys(schema).length === 0)
      throw new Error(
        `credential schema for node type '${node.type}' could not be verified; refusing credential edit`
      );
    if (op.action === "set") {
      if (
        !op.values ||
        typeof op.values !== "object" ||
        Array.isArray(op.values) ||
        Object.keys(op.values).length === 0
      )
        throw new Error("credential set requires a nonempty values object");
      assertOperationKeys(op, ["op", "action", "id", "values"]);
      const credentials = {};
      for (const [key, entry] of Object.entries(op.values)) {
        if (!Object.hasOwn(schema, key))
          throw new Error(`credential '${key}' is not defined for node type '${node.type}'`);
        if (
          !entry ||
          typeof entry !== "object" ||
          Array.isArray(entry) ||
          Object.keys(entry).length !== 1 ||
          typeof entry.env !== "string" ||
          !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.env)
        )
          throw new Error(`credential '${key}' must reference one environment variable name`);
        if (!Object.hasOwn(process.env, entry.env))
          throw new Error(`required environment variable '${entry.env}' is not set`);
        if (context.resolveCredentialValues) credentials[key] = process.env[entry.env];
      }
      if (context.resolveCredentialValues) node.credentials = credentials;
      else node.credentials = Object.fromEntries(Object.keys(op.values).map((key) => [key, "[REDACTED]"]));
      return;
    }
    if (op.action === "clear") {
      assertOperationKeys(op, ["op", "action", "id", "keys"]);
      if (!Array.isArray(op.keys) || op.keys.length === 0 || new Set(op.keys).size !== op.keys.length)
        throw new Error("credential clear requires a nonempty unique keys array");
      for (const key of op.keys) {
        if (typeof key !== "string" || !Object.hasOwn(schema, key))
          throw new Error(`credential '${key}' is not defined for node type '${node.type}'`);
      }
      node.credentials = Object.fromEntries(op.keys.map((key) => [key, ""]));
      return;
    }
    throw new Error("credential action must be set or clear");
  },
  add(result, op) {
    assertOperationKeys(op, ["op", "node"]);
    const node = op.node;
    validateJsonObject(node, "add node");
    validateAddInput(node);
    if (result.some((item) => item?.id === node.id)) throw new Error(`duplicate flow node id '${node.id}'`);
    if (result.some((item) => item?.type === node.type && isConfigObject(item)))
      throw new Error(`'${node.type}' is a config node type; use the config operation`);
    if (!result.some((item) => (item?.type === "tab" || item?.type === "subflow") && item.id === node.z))
      throw new Error(`add node '${node.id}' requires an existing tab or subflow owner in z`);
    if (result.some((item) => item?.type === "subflow" && item.id === node.type))
      throw new Error("add cannot create subflow instances");
    result.push(structuredClone(node));
  },
  connect(result, op) {
    assertOperationKeys(op, ["op", "from", "port", "to"]);
    const { source, targets } = resolveWire(result, op);
    if (targets.includes(op.to))
      throw new Error(`wire '${op.from}' port ${op.port} to '${op.to}' already exists`);
    targets.push(op.to);
    source.wires[op.port] = targets;
  },
  disconnect(result, op) {
    assertOperationKeys(op, ["op", "from", "port", "to"]);
    const { source, targets } = resolveWire(result, op);
    const index = targets.indexOf(op.to);
    if (index === -1) throw new Error(`wire '${op.from}' port ${op.port} to '${op.to}' was not found`);
    targets.splice(index, 1);
    source.wires[op.port] = targets;
  },
  delete(result, op) {
    assertOperationKeys(op, ["op", "id"]);
    if (typeof op.id !== "string" || !op.id) throw new Error("delete requires an exact node id");
    const target = result.find((item) => item?.id === op.id);
    if (!target) throw new Error(`node '${op.id}' was not found`);
    assertOrdinaryNode(result, target, "delete");
    assertNoUnknownReferences(result, target);
    for (const node of result) {
      if (Array.isArray(node.wires))
        node.wires = node.wires.map((targets) =>
          Array.isArray(targets) ? targets.filter((id) => id !== op.id) : targets
        );
      if (node.type === "group" && Array.isArray(node.nodes))
        node.nodes = node.nodes.filter((id) => id !== op.id);
    }
    result.splice(result.indexOf(target), 1);
  },
  tab(result, op) {
    return require("./edit-structures").tab(result, op);
  },
  group(result, op) {
    return require("./edit-structures").group(result, op);
  },
  config(result, op) {
    return require("./edit-structures").config(result, op);
  },
  link(result, op) {
    return require("./edit-structures").link(result, op);
  },
  subflow(result, op) {
    return require("./edit-structures").subflow(result, op);
  }
};

function assertOperationKeys(op, allowed) {
  if (Object.keys(op).some((key) => !allowed.includes(key)))
    throw new Error(`invalid '${op.op}' operation fields`);
}

function findOrdinaryNode(flows, id, operation) {
  const node = flows.find((item) => item?.id === id);
  if (!node) throw new Error(`node '${id}' was not found`);
  assertOrdinaryNode(flows, node, operation);
  return node;
}

function assertOrdinaryNode(flows, node, operation) {
  if (
    !node?.z ||
    !flows.some((item) => (item?.type === "tab" || item?.type === "subflow") && item.id === node.z) ||
    WORKSPACE_EXCLUDED.has(node.type) ||
    isSpecialType(node.type)
  )
    throw new Error(`${operation} is only supported for ordinary workspace nodes ('${node?.id || ""}')`);
}

function isSpecialType(type) {
  return typeof type !== "string" || type.startsWith("subflow:") || /^link (in|out|call)$/.test(type);
}

function resolveWire(flows, op) {
  if (typeof op.from !== "string" || !op.from || typeof op.to !== "string" || !op.to)
    throw new Error(`${op.op} requires exact from and to node ids`);
  if (!Number.isSafeInteger(op.port) || op.port < 0)
    throw new Error(`${op.op} port must be a nonnegative integer`);
  const source = findWireNode(flows, op.from, op.op, "source");
  const target = findWireNode(flows, op.to, op.op, "target");
  if (source.z !== target.z) throw new Error(`${op.op} cannot connect ordinary nodes across tabs or graphs`);
  if (!Array.isArray(source.wires) || !Array.isArray(source.wires[op.port]))
    throw new Error(`${op.op} source '${op.from}' has no declared output port ${op.port}`);
  if (Number.isSafeInteger(source.outputs) && op.port >= source.outputs)
    throw new Error(`${op.op} port ${op.port} is outside source '${op.from}' outputs`);
  return { source, targets: [...source.wires[op.port]] };
}

function findWireNode(flows, id, operation, direction) {
  const node = flows.find((item) => item?.id === id);
  if (!node) throw new Error(`node '${id}' was not found`);
  const ownerExists = flows.some(
    (item) => (item?.type === "tab" || item?.type === "subflow") && item.id === node.z
  );
  if (
    !ownerExists ||
    !Array.isArray(node.wires) ||
    WORKSPACE_EXCLUDED.has(node.type) ||
    (direction === "source" && node.type === "link out") ||
    (direction === "target" && node.type === "link in")
  )
    throw new Error(`${operation} requires nodes with compatible ordinary wire ${direction}s ('${id}')`);
  return node;
}

function validateAddInput(node) {
  if (typeof node.id !== "string" || !node.id.trim())
    throw new Error("add node requires a nonempty explicit id");
  if (
    typeof node.type !== "string" ||
    !node.type.trim() ||
    WORKSPACE_EXCLUDED.has(node.type) ||
    isSpecialType(node.type)
  )
    throw new Error("add requires an ordinary installed node type");
  if (typeof node.z !== "string" || !node.z.trim())
    throw new Error("add node requires an existing tab or subflow owner id in z");
  if (!Number.isFinite(node.x) || !Number.isFinite(node.y))
    throw new Error("add node requires finite numeric x and y");
  if (
    !Array.isArray(node.wires) ||
    node.wires.some((port) => !Array.isArray(port) || port.some((id) => typeof id !== "string"))
  )
    throw new Error("add node wires must be an array of arrays of node ids");
  if (
    node.outputs !== undefined &&
    (!Number.isSafeInteger(node.outputs) || node.outputs < 0 || node.wires.length !== node.outputs)
  )
    throw new Error("add node wires must match its nonnegative integer outputs");
}

function isConfigObject(node) {
  return (
    node &&
    typeof node.type === "string" &&
    !["tab", "group", "subflow"].includes(node.type) &&
    !Object.hasOwn(node, "x") &&
    !Object.hasOwn(node, "y") &&
    !Object.hasOwn(node, "wires")
  );
}

function validateJsonObject(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error(`${label} must be a plain JSON object`);
  const visit = (entry) => {
    if (!entry || typeof entry !== "object") return;
    for (const [key, child] of Object.entries(entry)) {
      if (DANGEROUS_KEYS.has(key)) throw new Error(`unsafe key '${key}' in ${label}`);
      if (/credential|password|secret|token|api.?key|private.?key/i.test(key))
        throw new Error(`sensitive field '${key}' is not allowed in ${label}`);
      visit(child);
    }
  };
  visit(value);
}

function assertNoUnknownReferences(flows, target) {
  const scan = (value, nodeId, path, key, groupMembership = false) => {
    if (key === "wires" || (key === "nodes" && groupMembership)) return;
    if (value === target.id)
      throw new Error(`cannot delete '${target.id}': unsafe reference at '${nodeId}.${path}'`);
    if (!value || typeof value !== "object") return;
    for (const [childKey, child] of Object.entries(value))
      scan(child, nodeId, `${path}.${childKey}`, childKey, groupMembership);
  };
  for (const node of flows) {
    if (node === target) continue;
    for (const [key, value] of Object.entries(node)) {
      if (key !== "id") scan(value, node.id || "unknown", key, key, node.type === "group");
    }
  }
}

function validateOrdinaryWires(flows) {
  const nodesById = new Map(flows.map((node) => [node?.id, node]));
  const owners = new Set(
    flows.filter((node) => node?.type === "tab" || node?.type === "subflow").map((node) => node.id)
  );
  for (const node of flows) {
    if (!Array.isArray(node?.wires)) continue;
    if (
      !owners.has(node.z) ||
      (node.type === "link out" && node.wires.some((port) => Array.isArray(port) && port.length > 0))
    )
      throw new Error(`node '${node.id}' cannot own ordinary output wires`);
    if (Number.isSafeInteger(node.outputs) && node.wires.length !== node.outputs)
      throw new Error(`node '${node.id}' wires do not match its declared output count`);
    for (const [portIndex, port] of node.wires.entries()) {
      if (!Array.isArray(port)) throw new Error(`node '${node.id}' output ${portIndex} must be an array`);
      for (const targetId of port) {
        if (typeof targetId !== "string") throw new Error(`node '${node.id}' has a non-string wire target`);
        const target = nodesById.get(targetId);
        if (!target) throw new Error(`node '${node.id}' has a dangling wire to '${targetId}'`);
        if (!Array.isArray(target.wires))
          throw new Error(`node '${node.id}' cannot wire to non-workspace node '${targetId}'`);
        if (target.type === "link in")
          throw new Error(`node '${node.id}' cannot wire to Link In '${targetId}'`);
        if (node.z !== target.z)
          throw new Error(`wire '${node.id}' to '${targetId}' crosses workspace owners`);
      }
    }
  }
}

function redactNode(node) {
  const safe = structuredClone(node);
  delete safe.credentials;
  return redactFields(
    Object.fromEntries(Object.entries(safe).map(([key, value]) => [key, { before: undefined, after: value }]))
  );
}

function validateFields(value) {
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN.has(key)) throw new Error(`set cannot change protected field '${key}'`);
    if (/(credential|password|secret|token|api.?key|private.?key)/i.test(key))
      throw new Error(`set cannot change sensitive field '${key}'`);
    if (entry && typeof entry === "object") {
      if (Array.isArray(entry))
        entry.forEach((item) => item && typeof item === "object" && validateFields(item));
      else validateFields(entry);
    }
  }
}

function redactFields(fields) {
  return Object.fromEntries(
    Object.entries(fields).map(([key, change]) => [
      key,
      isSensitiveKey(key) ? redactChange(change) : redactNested(change)
    ])
  );
}

function redactChange(change) {
  if (!change || typeof change !== "object" || Array.isArray(change)) return "[REDACTED]";
  return { before: "[REDACTED]", after: "[REDACTED]" };
}

function redactNested(value) {
  if (Array.isArray(value)) return value.map(redactNested);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      isSensitiveKey(key) ? "[REDACTED]" : redactNested(entry)
    ])
  );
}

function isSensitiveKey(key) {
  return /(credential|password|secret|token|api.?key|private.?key)/i.test(key);
}

module.exports = { parsePlan, transformPlan };
