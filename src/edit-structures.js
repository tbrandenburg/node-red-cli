"use strict";

function keys(op, allowed) {
  if (Object.keys(op).some((key) => !allowed.includes(key)))
    throw new Error(`invalid '${op.op}' operation fields`);
}
function object(value, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error(`${label} must be a plain JSON object`);
  const visit = (item) => {
    if (!item || typeof item !== "object") return;
    for (const [key, child] of Object.entries(item)) {
      if (["__proto__", "constructor", "prototype"].includes(key))
        throw new Error(`unsafe key '${key}' in ${label}`);
      if (/credential|password|secret|token|api.?key|private.?key/i.test(key))
        throw new Error(`sensitive field '${key}' is not allowed in ${label}`);
      visit(child);
    }
  };
  visit(value);
}
function tab(flows, id) {
  const result = flows.find((node) => node?.id === id && node.type === "tab");
  if (!result) throw new Error(`tab '${id || ""}' was not found`);
  return result;
}
function node(flows, id) {
  const result = flows.find((item) => item?.id === id);
  if (!result) throw new Error(`node '${id}' was not found`);
  return result;
}
function structuralRef(flows, id, skip) {
  for (const item of flows) {
    if (item === skip) continue;
    const scan = (value, path) => {
      if (value === id) throw new Error(`cannot delete '${id}': referenced at '${item.id}.${path}'`);
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value))
        if (key !== "wires" && !(item.type === "group" && key === "nodes")) scan(child, `${path}.${key}`);
    };
    for (const [key, value] of Object.entries(item))
      if (key !== "id" && key !== "wires" && !(item.type === "group" && key === "nodes")) scan(value, key);
  }
}
function ordinary(flows, item, op) {
  if (
    !item.z ||
    !flows.some((other) => other?.type === "tab" && other.id === item.z) ||
    ["tab", "group", "subflow"].includes(item.type) ||
    !Number.isFinite(item.x) ||
    !Number.isFinite(item.y)
  )
    throw new Error(`${op} requires a positioned workspace node ('${item.id}')`);
}

function tabOp(flows, op) {
  keys(op, ["op", "action", "tab", "id", "fields", "order"]);
  if (op.action === "add") {
    object(op.tab, "tab");
    if (
      op.tab.type !== "tab" ||
      typeof op.tab.id !== "string" ||
      !op.tab.id.trim() ||
      flows.some((item) => item?.id === op.tab.id)
    )
      throw new Error("tab add requires unique explicit id and type 'tab'");
    flows.push(structuredClone(op.tab));
    return;
  }
  if (op.action === "reorder") {
    const tabs = flows.filter((item) => item?.type === "tab");
    if (
      !Array.isArray(op.order) ||
      op.order.length !== tabs.length ||
      new Set(op.order).size !== tabs.length ||
      tabs.some((item) => !op.order.includes(item.id))
    )
      throw new Error("tab reorder must list every tab id exactly once");
    let index = 0;
    const ordered = op.order.map((id) => tab(flows, id));
    for (let i = 0; i < flows.length; i++) if (flows[i]?.type === "tab") flows[i] = ordered[index++];
    return;
  }
  const target = tab(flows, op.id);
  if (op.action === "set") {
    if (
      !op.fields ||
      typeof op.fields !== "object" ||
      Array.isArray(op.fields) ||
      !Object.keys(op.fields).length ||
      Object.keys(op.fields).some((key) => !["label", "info", "disabled"].includes(key))
    )
      throw new Error("tab set supports label, info and disabled only");
    Object.assign(target, structuredClone(op.fields));
    return;
  }
  if (op.action === "delete") {
    if (flows.some((item) => item !== target && item?.z === target.id))
      throw new Error(`cannot delete nonempty tab '${target.id}'`);
    flows.splice(flows.indexOf(target), 1);
    return;
  }
  throw new Error(`unsupported tab action '${op.action}'`);
}

function groupOp(flows, op) {
  keys(op, ["op", "action", "group", "id", "fields", "add", "remove"]);
  const validate = (group, members) => {
    tab(flows, group.z);
    if (![group.x, group.y, group.w, group.h].every(Number.isFinite) || group.w <= 0 || group.h <= 0)
      throw new Error("group needs finite coordinates and positive dimensions");
    if (!Array.isArray(members) || new Set(members).size !== members.length)
      throw new Error("group nodes must be unique ids");
    for (const id of members) {
      const member = node(flows, id);
      ordinary(flows, member, "group");
      if (member.z !== group.z) throw new Error(`cross-tab group member '${id}'`);
      if (
        member.x < group.x ||
        member.x > group.x + group.w ||
        member.y < group.y ||
        member.y > group.y + group.h
      )
        throw new Error(`group '${group.id}' bounds do not contain member '${id}'`);
    }
  };
  if (op.action === "add") {
    const g = structuredClone(op.group);
    object(g, "group");
    if (
      g.type !== "group" ||
      typeof g.id !== "string" ||
      !g.id.trim() ||
      flows.some((item) => item?.id === g.id)
    )
      throw new Error("group add requires unique id and type 'group'");
    g.nodes ||= [];
    validate(g, g.nodes);
    for (const id of g.nodes) {
      const m = node(flows, id);
      if (m.g) throw new Error(`node '${id}' is already grouped`);
      m.g = g.id;
    }
    flows.push(structuredClone(g));
    return;
  }
  const g = flows.find((item) => item?.id === op.id && item.type === "group");
  if (!g) throw new Error(`group '${op.id || ""}' was not found`);
  if (op.action === "set") {
    if (
      !op.fields ||
      typeof op.fields !== "object" ||
      Array.isArray(op.fields) ||
      Object.keys(op.fields).some((k) => !["name", "x", "y", "w", "h", "style"].includes(k))
    )
      throw new Error("group set supports name, x, y, w, h and style only");
    Object.assign(g, structuredClone(op.fields));
    validate(g, g.nodes || []);
    return;
  }
  if (op.action === "members") {
    const add = op.add || [],
      remove = op.remove || [];
    if (
      !Array.isArray(add) ||
      !Array.isArray(remove) ||
      new Set(add).size !== add.length ||
      new Set(remove).size !== remove.length
    )
      throw new Error("group add/remove must be unique id arrays");
    const members = [...(g.nodes || [])];
    for (const id of remove) {
      if (!members.includes(id)) throw new Error(`'${id}' is not in group '${g.id}'`);
      members.splice(members.indexOf(id), 1);
      const m = node(flows, id);
      if (m.g === g.id) delete m.g;
    }
    for (const id of add) {
      const m = node(flows, id);
      ordinary(flows, m, "group members");
      if (m.z !== g.z || m.g) throw new Error(`invalid or already-grouped member '${id}'`);
      if (members.includes(id)) throw new Error(`duplicate member '${id}'`);
      members.push(id);
      m.g = g.id;
    }
    g.nodes = members;
    return;
  }
  if (op.action === "delete") {
    assertNoUnknownGroupReferences(flows, g);
    for (const id of g.nodes || []) {
      const m = node(flows, id);
      if (m.g && m.g !== g.id) throw new Error(`group '${g.id}' has inconsistent member '${id}'`);
      if (m.g === g.id) delete m.g;
    }
    flows.splice(flows.indexOf(g), 1);
    return;
  }
  throw new Error(`unsupported group action '${op.action}'`);
}

function assertNoUnknownGroupReferences(flows, group) {
  const scan = (value, item, key, path) => {
    if (
      key === "wires" ||
      (item === group && key === "nodes") ||
      (key === "g" && value === group.id && (group.nodes || []).includes(item.id))
    )
      return;
    if (value === group.id)
      throw new Error(`cannot delete group '${group.id}': referenced at '${item.id}.${path}'`);
    if (!value || typeof value !== "object") return;
    for (const [childKey, child] of Object.entries(value)) scan(child, item, childKey, `${path}.${childKey}`);
  };
  for (const item of flows) {
    if (item === group) continue;
    for (const [key, value] of Object.entries(item)) if (key !== "id") scan(value, item, key, key);
  }
}

function configOp(flows, op) {
  keys(op, ["op", "action", "node", "id", "fields"]);
  if (op.action === "add") {
    const n = op.node;
    object(n, "config node");
    if (
      typeof n.id !== "string" ||
      !n.id.trim() ||
      typeof n.type !== "string" ||
      !n.type.trim() ||
      ["x", "y", "wires", "g", "credentials"].some((key) => key in n) ||
      flows.some((item) => item?.id === n.id)
    )
      throw new Error("invalid config node shape");
    if (
      !flows.some((item) => item?.type === n.type && !("x" in item) && !("y" in item) && !("wires" in item))
    )
      throw new Error(`cannot prove '${n.type}' is a config type without an existing config example`);
    if (
      n.z !== undefined &&
      n.z !== "" &&
      !flows.some((item) => (item?.type === "tab" || item?.type === "subflow") && item.id === n.z)
    )
      throw new Error("config node z must be empty/global or an existing tab/subflow owner");
    flows.push(structuredClone(n));
    return;
  }
  const target = node(flows, op.id);
  if (
    "x" in target ||
    "y" in target ||
    "wires" in target ||
    ["tab", "group", "subflow"].includes(target.type)
  )
    throw new Error(`'${op.id}' is not a config node`);
  if (op.action === "set") {
    if (
      !op.fields ||
      typeof op.fields !== "object" ||
      Array.isArray(op.fields) ||
      ["id", "type", "z", "credentials"].some((key) => key in op.fields)
    )
      throw new Error("invalid config set fields");
    object(op.fields, "config fields");
    Object.assign(target, structuredClone(op.fields));
    return;
  }
  if (op.action === "delete") {
    structuralRef(flows, target.id, target);
    flows.splice(flows.indexOf(target), 1);
    return;
  }
  throw new Error(`unsupported config action '${op.action}'`);
}

function validateLinks(flows, { allowIncompleteStaticCalls = false } = {}) {
  for (const n of flows.filter((item) => /^link (in|out|call)$/.test(item?.type || ""))) {
    if (n.links === undefined && n.type === "link in") continue;
    if (!Array.isArray(n.links)) throw new Error(`Link node '${n.id}' needs links array`);
    if (new Set(n.links).size !== n.links.length) throw new Error(`Link node '${n.id}' has duplicate links`);
    if (
      n.type === "link call" &&
      n.linkType === "static" &&
      n.links.length !== 1 &&
      !(allowIncompleteStaticCalls && n.links.length === 0)
    )
      throw new Error(`static Link Call '${n.id}' requires exactly one target`);
    for (const id of n.links) {
      const t = flows.find((item) => item?.id === id);
      if (
        !t ||
        (n.type === "link out" && (n.mode !== "link" || t.type !== "link in")) ||
        (n.type === "link in" && t.type !== "link out") ||
        (n.type === "link call" && t.type !== "link in") ||
        (n.type === "link out" && !t.links?.includes(n.id)) ||
        (n.type === "link in" && !t.links?.includes(n.id))
      )
        throw new Error(`invalid Link relationship '${n.id}' -> '${id}'`);
    }
  }
}

function linkOp(flows, op) {
  keys(op, ["op", "action", "node", "from", "to", "id"]);
  const validate = () => validateLinks(flows, { allowIncompleteStaticCalls: true });
  if (op.action === "add") {
    const n = op.node;
    object(n, "Link node");
    if (
      !/^link (in|out|call)$/.test(n.type || "") ||
      typeof n.id !== "string" ||
      !n.id.trim() ||
      flows.some((item) => item?.id === n.id) ||
      !Number.isFinite(n.x) ||
      !Number.isFinite(n.y)
    )
      throw new Error("invalid Link node identity/type/coordinates");
    tab(flows, n.z);
    if (!Array.isArray(n.links) || !Array.isArray(n.wires))
      throw new Error("Link add requires native links and wires arrays");
    if (n.type === "link out" && !["link", "return"].includes(n.mode))
      throw new Error("link out mode must be link or return");
    if (n.type === "link call" && (n.linkType !== "static" || (n.links.length !== 0 && n.links.length !== 1)))
      throw new Error("only static single-target Link Call is supported");
    flows.push(structuredClone(n));
    validate();
    return;
  }
  if (op.action === "connect" || op.action === "disconnect") {
    const from = node(flows, op.from),
      to = node(flows, op.to);
    if (to.type !== "link in" || !["link out", "link call"].includes(from.type))
      throw new Error("link relationship requires Link Out/Call to Link In");
    if (from.type === "link out" && from.mode !== "link")
      throw new Error("return-mode Link Out cannot be a normal target/source");
    if (
      from.type === "link call" &&
      (from.linkType !== "static" ||
        from.links?.length > 1 ||
        (op.action === "connect" && (from.links?.length ?? 0) !== 0) ||
        (op.action === "disconnect" && from.links?.[0] !== to.id))
    )
      throw new Error("dynamic/return Link Call edits are unsupported");
    const edit = (n, id) => {
      n.links ||= [];
      const ix = n.links.indexOf(id);
      if (op.action === "connect") {
        if (ix !== -1) throw new Error("Link relationship already exists");
        n.links.push(id);
      } else {
        if (ix === -1) throw new Error("Link relationship was not found");
        n.links.splice(ix, 1);
      }
    };
    edit(from, to.id);
    if (from.type === "link out") edit(to, from.id);
    validate();
    return;
  }
  if (op.action === "delete") {
    const target = node(flows, op.id);
    if (!/^link (in|out|call)$/.test(target.type || "")) throw new Error("link delete requires Link node");
    if (target.type === "link call" && target.linkType !== "static")
      throw new Error("cannot safely delete a dynamic Link Call");
    if (Array.isArray(target.links) && target.links.length > 0)
      throw new Error(`cannot delete Link node '${target.id}' while its links are connected`);
    const referer = flows.find(
      (item) => item !== target && Array.isArray(item.links) && item.links.includes(target.id)
    );
    if (referer) throw new Error(`cannot delete Link node '${target.id}' referenced by '${referer.id}'`);
    const wireReferer = flows.find(
      (item) =>
        item !== target &&
        Array.isArray(item.wires) &&
        item.wires.some((port) => Array.isArray(port) && port.includes(target.id))
    );
    if (wireReferer) throw new Error(`cannot delete Link node '${target.id}' wired from '${wireReferer.id}'`);
    structuralRef(flows, target.id, target);
    flows.splice(flows.indexOf(target), 1);
    return;
  }
  throw new Error(`unsupported link action '${op.action}'`);
}

function subflowOp(flows, op) {
  keys(op, ["op", "action", "definition", "id", "fields", "in", "out", "node"]);
  const acyclic = () => {
    const defs = flows.filter((item) => item?.type === "subflow"),
      edges = new Map(
        defs.map((d) => [
          d.id,
          flows.filter((n) => n?.z === d.id && /^subflow:/.test(n.type || "")).map((n) => n.type.slice(8))
        ])
      );
    const visiting = new Set(),
      done = new Set();
    const visit = (id) => {
      if (visiting.has(id)) throw new Error(`recursive/cyclic subflow '${id}'`);
      if (done.has(id)) return;
      visiting.add(id);
      for (const child of edges.get(id) || []) {
        if (!edges.has(child)) throw new Error(`unknown nested subflow '${child}'`);
        visit(child);
      }
      visiting.delete(id);
      done.add(id);
    };
    for (const id of edges.keys()) visit(id);
  };
  if (op.action === "add-definition") {
    const d = op.definition;
    object(d, "subflow definition");
    if (
      d.type !== "subflow" ||
      typeof d.id !== "string" ||
      !d.id.trim() ||
      flows.some((n) => n?.id === d.id) ||
      !Array.isArray(d.in) ||
      !Array.isArray(d.out)
    )
      throw new Error("definition needs unique id, type subflow and explicit native in/out arrays");
    flows.push(structuredClone(d));
    acyclic();
    return;
  }
  if (op.action === "set-definition") {
    const d = flows.find((n) => n?.id === op.id && n.type === "subflow");
    if (!d) throw new Error("subflow definition not found");
    if (
      !op.fields ||
      typeof op.fields !== "object" ||
      Array.isArray(op.fields) ||
      Object.keys(op.fields).some(
        (k) => !["name", "info", "env", "meta", "color", "icon", "category"].includes(k)
      )
    )
      throw new Error("set-definition supports name/info/env/meta/appearance fields only");
    object(op.fields, "subflow fields");
    Object.assign(d, structuredClone(op.fields));
    return;
  }
  if (op.action === "ports") {
    const d = flows.find((n) => n?.id === op.id && n.type === "subflow");
    if (!d) throw new Error("subflow definition not found");
    if (!Array.isArray(op.in) || !Array.isArray(op.out))
      throw new Error("ports requires complete in and out arrays");
    for (const [kind, ports] of [
      ["in", op.in],
      ["out", op.out]
    ])
      for (const p of ports)
        if (
          !p ||
          !Number.isFinite(p.x) ||
          !Number.isFinite(p.y) ||
          !Array.isArray(p.wires) ||
          p.wires.some(
            (w) =>
              !w ||
              typeof w.id !== "string" ||
              !flows.some((n) => n.id === w.id && n.z === d.id) ||
              (kind === "out" && (!Number.isSafeInteger(w.port) || w.port < 0))
          )
        )
          throw new Error(`invalid native subflow ${kind} port descriptor`);
    d.in = structuredClone(op.in);
    d.out = structuredClone(op.out);
    for (const instance of flows.filter((n) => n?.type === `subflow:${d.id}`))
      if (instance.wires?.length !== d.out.length)
        throw new Error(`port change mismatches instance '${instance.id}' wires`);
    return;
  }
  if (op.action === "add-instance") {
    const n = op.node;
    object(n, "subflow instance");
    const d = flows.find((x) => x?.type === "subflow" && n.type === `subflow:${x.id}`);
    if (
      !d ||
      typeof n.id !== "string" ||
      !n.id.trim() ||
      flows.some((x) => x?.id === n.id) ||
      !Number.isFinite(n.x) ||
      !Number.isFinite(n.y) ||
      !Array.isArray(n.wires) ||
      n.wires.length !== d.out.length ||
      n.wires.some(
        (port) =>
          !Array.isArray(port) ||
          port.some((id) => typeof id !== "string" || !flows.some((target) => target?.id === id))
      )
    )
      throw new Error("invalid subflow instance id, output wire count, or target wires");
    if (!flows.some((owner) => (owner?.type === "tab" || owner?.type === "subflow") && owner.id === n.z))
      throw new Error(`subflow instance '${n.id}' needs an existing tab or subflow owner in z`);
    if (
      n.wires.some((port) =>
        port.some((id) => !flows.some((target) => target?.id === id && target.z === n.z))
      )
    )
      throw new Error("subflow instance output wires must target nodes in the same workspace");
    flows.push(structuredClone(n));
    acyclic();
    return;
  }
  if (op.action === "delete-instance") {
    const n = flows.find((x) => x?.id === op.id && /^subflow:/.test(x.type || ""));
    if (!n) throw new Error("subflow instance not found");
    structuralRef(flows, n.id, n);
    for (const x of flows) {
      if (Array.isArray(x.wires))
        x.wires = x.wires.map((p) => (Array.isArray(p) ? p.filter((id) => id !== n.id) : p));
      if (x.type === "group" && Array.isArray(x.nodes)) x.nodes = x.nodes.filter((id) => id !== n.id);
    }
    flows.splice(flows.indexOf(n), 1);
    return;
  }
  if (op.action === "delete-definition") {
    const d = flows.find((n) => n?.id === op.id && n.type === "subflow");
    if (!d) throw new Error("subflow definition not found");
    if (flows.some((n) => n !== d && n.type === `subflow:${d.id}`))
      throw new Error("cannot delete nonempty or referenced subflow definition");
    structuralRef(flows, d.id, d);
    flows.splice(flows.indexOf(d), 1);
    return;
  }
  throw new Error(`unsupported subflow action '${op.action}'`);
}

function validateSubflows(flows) {
  const definitions = new Map(
    flows.filter((item) => item?.type === "subflow").map((item) => [item.id, item])
  );
  const nodes = new Map(flows.map((item) => [item?.id, item]));
  const children = new Map([...definitions.keys()].map((id) => [id, []]));
  for (const definition of definitions.values()) {
    for (const [kind, ports] of [
      ["in", definition.in],
      ["out", definition.out]
    ]) {
      if (!Array.isArray(ports))
        throw new Error(`subflow '${definition.id}' requires native ${kind} port arrays`);
      for (const port of ports) {
        if (
          !port ||
          !Number.isFinite(port.x) ||
          !Number.isFinite(port.y) ||
          !Array.isArray(port.wires) ||
          port.wires.some((wire) => {
            if (!wire || typeof wire.id !== "string") return true;
            const child = nodes.get(wire.id);
            if (!child || child.z !== definition.id) return true;
            return (
              kind === "out" &&
              (!Number.isSafeInteger(wire.port) ||
                wire.port < 0 ||
                !Array.isArray(child.wires) ||
                wire.port >= child.wires.length)
            );
          })
        )
          throw new Error(`invalid native subflow ${kind} port descriptor in '${definition.id}'`);
      }
    }
  }
  for (const instance of flows.filter(
    (item) => typeof item?.type === "string" && item.type.startsWith("subflow:")
  )) {
    const definitionId = instance.type.slice("subflow:".length);
    const definition = definitions.get(definitionId);
    if (!definition)
      throw new Error(`subflow instance '${instance.id}' references missing definition '${definitionId}'`);
    if (
      !flows.some(
        (owner) => (owner?.type === "tab" || owner?.type === "subflow") && owner.id === instance.z
      ) ||
      !Number.isFinite(instance.x) ||
      !Number.isFinite(instance.y) ||
      !Array.isArray(instance.wires) ||
      instance.wires.length !== definition.out.length ||
      instance.wires.some(
        (port) =>
          !Array.isArray(port) ||
          port.some((id) => typeof id !== "string" || !nodes.has(id) || nodes.get(id).z !== instance.z)
      )
    )
      throw new Error(`invalid subflow instance '${instance.id}' owner or output wires`);
    if (definitions.has(instance.z)) children.get(instance.z).push(definitionId);
  }
  const active = new Set();
  const completed = new Set();
  const visit = (id) => {
    if (active.has(id)) throw new Error(`recursive/cyclic subflow '${id}'`);
    if (completed.has(id)) return;
    active.add(id);
    for (const child of children.get(id) || []) visit(child);
    active.delete(id);
    completed.add(id);
  };
  for (const id of definitions.keys()) visit(id);
}

function validateGroups(flows) {
  const groups = new Map(flows.filter((item) => item?.type === "group").map((item) => [item.id, item]));
  const memberGroups = new Map();
  for (const group of groups.values()) {
    if (!Array.isArray(group.nodes) || new Set(group.nodes).size !== group.nodes.length)
      throw new Error(`group '${group.id}' needs unique member IDs`);
    for (const id of group.nodes) {
      const member = nodesById(flows, id);
      ordinary(flows, member, "group");
      if (member.z !== group.z || member.g !== group.id)
        throw new Error(`group '${group.id}' and member '${id}' are inconsistent`);
      if (memberGroups.has(id)) throw new Error(`node '${id}' belongs to multiple groups`);
      memberGroups.set(id, group.id);
    }
  }
  for (const item of flows) {
    if (item?.g && (!groups.has(item.g) || memberGroups.get(item.id) !== item.g))
      throw new Error(`node '${item.id}' has dangling group reference '${item.g}'`);
  }
}

function nodesById(flows, id) {
  const result = flows.find((item) => item?.id === id);
  if (!result) throw new Error(`group member '${id}' was not found`);
  return result;
}

module.exports = {
  tab: tabOp,
  group: groupOp,
  config: configOp,
  link: linkOp,
  subflow: subflowOp,
  validateLinks,
  validateSubflows,
  validateGroups
};
