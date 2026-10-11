"use strict";

function listNodes(flows, options = {}) {
  if (!Array.isArray(flows)) throw new Error("flows must be an array");
  const kind = options.kind || "workspace";
  if (!["workspace", "config"].includes(kind)) throw new Error("kind must be workspace or config");
  const tabs = flows.filter((node) => node?.type === "tab");
  const tabById = new Map(tabs.map((tab) => [tab.id, tab]));
  let selectedTab;
  if (options.tab !== undefined) {
    const byId = tabs.find((tab) => tab.id === options.tab);
    const byLabel = tabs.filter((tab) => tab.label === options.tab);
    if (byId) selectedTab = byId;
    else if (byLabel.length === 1) selectedTab = byLabel[0];
    else if (byLabel.length > 1) throw new Error(`tab label '${options.tab}' is ambiguous`);
    else throw new Error(`tab '${options.tab}' was not found`);
  }
  const search = options.search?.toLocaleLowerCase();
  const matches = [];
  for (const node of flows) {
    if (
      !node ||
      typeof node !== "object" ||
      node.type === "tab" ||
      node.type === "group" ||
      node.type === "subflow"
    )
      continue;
    const config = isConfigShape(node);
    if ((kind === "config") !== config) continue;
    const tab = tabById.get(node.z);
    if (kind === "workspace" && !tab) continue;
    if (selectedTab && node.z !== selectedTab.id) continue;
    if (options.type && node.type !== options.type) continue;
    const matchIn = search
      ? ["name", "type", "func", "template", "action", "data"].filter(
          (key) => typeof node[key] === "string" && node[key].toLocaleLowerCase().includes(search)
        )
      : [];
    if (search && matchIn.length === 0) continue;
    matches.push({
      id: node.id,
      type: node.type,
      name: typeof node.name === "string" ? node.name : "",
      tabId: tab?.id || null,
      tabLabel: tab?.label || "",
      matchIn
    });
  }
  const limit = options.limit === undefined ? 50 : Number(options.limit);
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error("limit must be a positive safe integer");
  const capped = Math.min(limit, 500);
  const nodes = matches.slice(0, capped);
  const tabCounts = new Map();
  for (const node of flows) {
    if (
      node &&
      typeof node.z === "string" &&
      tabById.has(node.z) &&
      node.type !== "group" &&
      !isConfigShape(node)
    ) {
      tabCounts.set(node.z, (tabCounts.get(node.z) || 0) + 1);
    }
  }
  return {
    tabs: tabs
      .filter((tab) => !selectedTab || tab.id === selectedTab.id)
      .map((tab) => ({ id: tab.id, label: tab.label || "", nodeCount: tabCounts.get(tab.id) || 0 })),
    nodes,
    total: matches.length,
    truncated: matches.length > nodes.length
  };
}

function isConfigShape(node) {
  return (
    typeof node?.type === "string" &&
    !["tab", "group", "subflow"].includes(node.type) &&
    !Object.hasOwn(node, "x") &&
    !Object.hasOwn(node, "y") &&
    !Object.hasOwn(node, "wires")
  );
}

function getNodeContext(flows, id) {
  if (!Array.isArray(flows)) throw new Error("flows must be an array");
  const matches = flows.filter((node) => node?.id === id);
  if (matches.length !== 1)
    throw new Error(matches.length ? `node id '${id}' is ambiguous` : `node '${id}' was not found`);
  const node = matches[0];
  const safeNode = structuredClone(node);
  delete safeNode.credentials;
  const redactedNode = redactSensitive(safeNode);
  const tabs = new Map(flows.filter((item) => item?.type === "tab").map((tab) => [tab.id, tab]));
  const tab = tabs.get(node.z) || (node.type === "tab" ? node : null);
  const subflowOwner = flows.find((item) => item?.type === "subflow" && item.id === node.z);
  const groups = flows.filter((item) => item?.type === "group");
  const group =
    groups.find(
      (item) => item.id === node.g || (Array.isArray(item.nodes) && item.nodes.includes(node.id))
    ) || null;
  const incoming = [];
  const outgoing = [];
  for (const candidate of flows) {
    if (!candidate || !Array.isArray(candidate.wires)) continue;
    candidate.wires.forEach((targets, port) => {
      if (!Array.isArray(targets)) return;
      for (const target of targets) {
        if (target === node.id) incoming.push({ from: candidate.id, port });
      }
      if (candidate.id === node.id) outgoing.push(...targets.map((to) => ({ to, port })));
    });
  }
  return {
    node: redactedNode,
    tab: tab ? { id: tab.id, label: tab.label || "" } : null,
    subflow: subflowOwner ? { id: subflowOwner.id, name: subflowOwner.name || "" } : null,
    group: group ? redactSensitive(structuredClone(group)) : null,
    incoming,
    outgoing
  };
}

function redactSensitive(value) {
  if (Array.isArray(value)) return value.map(redactSensitive);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      /(credential|password|secret|token|api.?key|private.?key)/i.test(key)
        ? "[REDACTED]"
        : redactSensitive(entry)
    ])
  );
}

module.exports = { listNodes, getNodeContext };
