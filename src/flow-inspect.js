"use strict";

function indexFlow(flow) {
  if (!Array.isArray(flow)) throw new Error("the flow JSON must be an array of node configs");
  const byId = new Map();
  for (const [position, node] of flow.entries()) {
    if (!node || typeof node !== "object" || Array.isArray(node))
      throw new Error(`flow config at index ${position} must be an object`);
    if (typeof node.id !== "string" || !node.id || typeof node.type !== "string" || !node.type)
      throw new Error(`flow config at index ${position} must have a non-empty id and type`);
    if (byId.has(node.id)) throw new Error(`duplicate config id '${node.id}'`);
    byId.set(node.id, node);
  }
  const tabs = flow
    .filter((node) => node?.type === "tab")
    .map((tab) => ({
      id: tab.id,
      label: tab.label || "",
      disabled: tab.disabled === true
    }));
  const entries = flow.filter((node) => node?.type === "link in" && byId.get(node.z)?.type === "tab");
  const returns = flow.filter((node) => node?.type === "link out" && node.mode === "return");
  const linkTargets = new Map();
  const addLink = (out, input) => {
    if (!linkTargets.has(out)) linkTargets.set(out, new Set());
    linkTargets.get(out).add(input);
  };
  for (const node of flow) {
    if (node?.type === "link out")
      for (const id of Array.isArray(node.links) ? node.links : []) addLink(node.id, id);
    if (node?.type === "link in")
      for (const id of Array.isArray(node.links) ? node.links : []) addLink(id, node.id);
  }
  const warnings = [];
  for (const node of flow) {
    if (node.wires !== undefined && !Array.isArray(node.wires))
      warnings.push(`wire list on '${node.id}' is malformed; wires must be an array`);
    if (Array.isArray(node.wires))
      for (const [port, targets] of node.wires.entries())
        if (!Array.isArray(targets)) warnings.push(`wire list on '${node.id}' output ${port} is malformed`);
    for (const targets of Array.isArray(node?.wires) ? node.wires : [])
      for (const targetId of Array.isArray(targets) ? targets : [])
        if (typeof targetId !== "string") warnings.push(`wire target on '${node.id}' is malformed`);
        else if (!byId.has(targetId))
          warnings.push(`wire target '${targetId}' referenced by '${node.id}' was not found`);
    if (
      (node?.type === "link in" || node?.type === "link out") &&
      node.links !== undefined &&
      !Array.isArray(node.links)
    )
      warnings.push(`Link relationship on '${node.id}' is malformed; links must be an array`);
    if (
      (node?.type === "link in" || node?.type === "link out") &&
      Array.isArray(node.links) &&
      node.links.some((id) => typeof id !== "string")
    )
      warnings.push(`Link relationship on '${node.id}' is malformed; link ids must be strings`);
    if (node.type === "subflow")
      for (const direction of ["in", "out"]) {
        if (node[direction] !== undefined && !Array.isArray(node[direction])) {
          warnings.push(`subflow ${direction} mappings on '${node.id}' are malformed`);
          continue;
        }
        for (const [mappingIndex, mapping] of (node[direction] || []).entries()) {
          if (!mapping || typeof mapping !== "object" || !Array.isArray(mapping.wires)) {
            warnings.push(`subflow ${direction} mapping ${mappingIndex} on '${node.id}' is malformed`);
            continue;
          }
          for (const wire of mapping.wires)
            if (!wire || typeof wire !== "object" || typeof wire.id !== "string")
              warnings.push(
                `subflow ${direction} mapping ${mappingIndex} on '${node.id}' has a malformed wire`
              );
        }
      }
    if (node?.type?.startsWith("subflow:") && !byId.has(node.type.slice("subflow:".length)))
      warnings.push(
        `subflow definition '${node.type.slice("subflow:".length)}' referenced by instance '${node.id}' was not found`
      );
  }
  for (const [outId, targets] of linkTargets) {
    if (byId.get(outId)?.type !== "link out")
      warnings.push(`link source '${outId}' referenced by Link In was not found or is not a Link Out`);
    for (const targetId of targets)
      if (byId.get(targetId)?.type !== "link in")
        warnings.push(`link target '${targetId}' referenced by '${outId}' was not found or is not a Link In`);
  }
  return { flow, byId, tabs, entries, returns, linkTargets, warnings: [...new Set(warnings)] };
}

function resolveTab(index, selector) {
  if (!selector) return undefined;
  const tab = index.byId.get(selector)?.type === "tab" ? index.byId.get(selector) : null;
  if (tab) return tab;
  const matches = index.flow.filter((node) => node?.type === "tab" && node.label === selector);
  if (matches.length !== 1)
    throw new Error(matches.length ? `tab label '${selector}' is ambiguous` : `tab '${selector}' not found`);
  return matches[0];
}

function container(index, config) {
  const parent = index.byId.get(config.z);
  return parent?.type === "tab"
    ? { kind: "tab", id: parent.id, label: parent.label || "" }
    : parent?.type === "subflow"
      ? { kind: "subflow", id: parent.id, label: parent.name || "" }
      : { kind: "unknown", id: config.z || "", label: "" };
}

function inventory(index, tab) {
  const tabs = index.tabs.filter((item) => !tab || item.id === tab.id);
  const entries = index.entries
    .filter((node) => !tab || node.z === tab.id)
    .map((node) => {
      const owner = container(index, node);
      return {
        id: node.id,
        name: node.name || "",
        tabId: owner.id,
        tabLabel: owner.label,
        disabled: node.d === true || index.byId.get(node.z)?.disabled === true
      };
    });
  const returns = index.returns
    .filter((node) => !tab || node.z === tab.id)
    .map((node) => ({
      id: node.id,
      name: node.name || "",
      container: container(index, node),
      disabled: node.d === true || index.byId.get(node.z)?.disabled === true
    }));
  return { tabs, entries, returns };
}

function resolveEntry(index, selector, tab) {
  const eligible = index.entries.filter((node) => !tab || node.z === tab.id);
  const byId =
    eligible.find((node) => node.id === selector) || index.entries.find((node) => node.id === selector);
  if (byId) {
    if (tab && byId.z !== tab.id)
      throw new Error(`entry '${selector}' is not in tab '${tab.label || tab.id}'`);
    return byId;
  }
  const matches = eligible.filter((node) => node.name === selector);
  if (matches.length !== 1)
    throw new Error(
      matches.length ? `entry name '${selector}' is ambiguous` : `entry '${selector}' not found`
    );
  return matches[0];
}

function graph(index, root, depthLimit) {
  const nodes = new Map();
  const edges = [];
  const edgeKeys = new Set();
  const queue = [];
  let truncated = false;
  const disabledFor = (config, context) => {
    if (config.d === true || index.byId.get(config.z)?.disabled === true) return true;
    if (
      context.some((id) => {
        const instance = index.byId.get(id);
        return instance?.d === true || index.byId.get(instance?.type?.slice("subflow:".length))?.d === true;
      })
    )
      return true;
    const workspaceInstance = context.length ? index.byId.get(context[0]) : config;
    const workspaceTab = index.byId.get(workspaceInstance?.z);
    return workspaceTab?.disabled === true;
  };
  const warn = (message) => {
    if (!index.warnings.includes(message)) index.warnings.push(message);
  };
  const addNode = (config, context, depth, boundary = false) => {
    const key = [...context, config.id].map(encodeURIComponent).join("/");
    if (!nodes.has(key)) {
      nodes.set(key, {
        key,
        sourceId: config.id,
        type: config.type,
        name: config.name || "",
        depth,
        instancePath: context,
        container: container(index, config),
        disabled: disabledFor(config, context),
        boundary
      });
      queue.push({ config, context, depth, key });
    }
    return key;
  };
  const addEdge = (from, to, kind, extra = {}) => {
    const edge = { from, to, kind, ...extra };
    const identity = JSON.stringify(edge);
    if (!edgeKeys.has(identity)) {
      edgeKeys.add(identity);
      edges.push(edge);
    }
  };
  const rootKey = addNode(root, [], 0);
  while (queue.length) {
    const current = queue.shift();
    if (current.depth >= depthLimit) {
      if (hasOutgoing(index, current.config)) truncated = true;
      continue;
    }
    const { config, context, depth, key } = current;
    const visit = (targetId, kind, extra = {}, targetContext = context) => {
      const target = index.byId.get(targetId);
      if (!target) {
        warn(`${kind} target '${targetId}' referenced by '${config.id}' was not found`);
        addEdge(key, null, kind, { ...extra, targetId, unresolved: true });
        return;
      }
      const targetContainer = index.byId.get(target.z);
      const targetInSubflow = targetContainer?.type === "subflow";
      const instanceId = targetContext.at(-1);
      const instance = instanceId && index.byId.get(instanceId);
      if (targetInSubflow && instance?.type !== `subflow:${targetContainer.id}`) {
        warn(
          `subflow template node '${targetId}' referenced by '${config.id}' has no matching instance context`
        );
        addEdge(key, null, kind, { ...extra, targetId, unresolved: true });
        return;
      }
      const nextContext = targetInSubflow ? targetContext : [];
      const targetKey = addNode(target, nextContext, depth + 1);
      addEdge(key, targetKey, kind, extra);
    };
    if (!config.type?.startsWith("subflow:") && Array.isArray(config.wires))
      config.wires.forEach((targets, port) => {
        if (!Array.isArray(targets)) return;
        for (const id of targets) visit(id, config.type === "link call" ? "after-return" : "wire", { port });
      });
    if (config.type === "link out" && config.mode !== "return") {
      for (const id of index.linkTargets.get(config.id) || []) {
        if (index.byId.get(id)?.type !== "link in") {
          addEdge(key, null, "link", { targetId: id, unresolved: true });
          continue;
        }
        visit(id, "link");
      }
    }
    if (config.type === "link call") {
      if (config.linkType === "dynamic") addEdge(key, null, "call-dynamic", { target: "msg.target" });
      else {
        const targets =
          typeof config.links === "string" ? [config.links] : Array.isArray(config.links) ? config.links : [];
        if (targets.length > 1)
          warn(`static link call '${config.id}' contains multiple targets; only the first is used`);
        if (targets[0]) {
          if (index.byId.get(targets[0])?.type && index.byId.get(targets[0]).type !== "link in") {
            warn(`static link call target '${targets[0]}' referenced by '${config.id}' is not a Link In`);
            addEdge(key, null, "call", { targetId: targets[0], unresolved: true });
          } else visit(targets[0], "call");
        }
      }
    }
    const definition = index.byId.get(config.z);
    const instanceId = context.at(-1);
    const instance = instanceId && index.byId.get(instanceId);
    if (definition?.type === "subflow" && instance?.type === `subflow:${definition.id}`) {
      for (const [outputIndex, output] of (Array.isArray(definition.out) ? definition.out : []).entries()) {
        for (const mapping of Array.isArray(output?.wires) ? output.wires : []) {
          if (mapping?.id !== config.id) continue;
          const port = mapping.port || 0;
          for (const targetId of Array.isArray(instance.wires?.[outputIndex])
            ? instance.wires[outputIndex]
            : [])
            visit(targetId, "subflow-exit", { output: outputIndex, port }, context.slice(0, -1));
        }
      }
    }
    if (config.type?.startsWith("subflow:")) {
      const definitionId = config.type.slice("subflow:".length);
      const definition = index.byId.get(definitionId);
      if (!definition) {
        warn(`subflow definition '${definitionId}' referenced by instance '${config.id}' was not found`);
        continue;
      }
      for (const input of Array.isArray(definition.in) ? definition.in : [])
        for (const wire of Array.isArray(input?.wires) ? input.wires : [])
          if (typeof wire?.id === "string") visit(wire.id, "subflow-enter", {}, [...context, config.id]);
      for (const [outputIndex, output] of (Array.isArray(definition.out) ? definition.out : []).entries())
        if (Array.isArray(output?.wires) && output.wires.some((wire) => wire?.id === definitionId))
          for (const targetId of Array.isArray(config.wires?.[outputIndex]) ? config.wires[outputIndex] : [])
            visit(targetId, "subflow-exit", { output: outputIndex });
    }
  }
  return { root: rootKey, depth: depthLimit, truncated, nodes: [...nodes.values()], edges };
}

function hasOutgoing(index, config) {
  return (
    (Array.isArray(config.wires) && config.wires.some((list) => Array.isArray(list) && list.length)) ||
    (config.type === "link out" &&
      config.mode !== "return" &&
      (index.linkTargets.get(config.id)?.size || 0) > 0) ||
    config.type === "link call" ||
    config.type?.startsWith("subflow:")
  );
}

function formatInspection(result) {
  const lines = [`Flow: ${result.source.path}`, "", "Tabs:"];
  for (const tab of result.tabs) lines.push(`  ${tab.id}  ${tab.label}${tab.disabled ? " [disabled]" : ""}`);
  lines.push("", "Entries:");
  for (const entry of result.entries)
    lines.push(`  ${entry.id}  ${entry.name} (${entry.tabLabel})${entry.disabled ? " [disabled]" : ""}`);
  lines.push("", "Returns:");
  for (const item of result.returns)
    lines.push(
      `  ${item.id}  ${item.name} (${item.container.kind}: ${item.container.label || item.container.id})${item.disabled ? " [disabled]" : ""}`
    );
  if (result.graph) {
    lines.push(
      "",
      `Entry: ${result.graph.nodes[0]?.name || result.graph.root} (${result.graph.root})`,
      `Depth: ${result.graph.depth}`,
      ""
    );
    for (const node of result.graph.nodes)
      lines.push(
        `${"  ".repeat(node.depth)}${node.name || node.type} [${node.type}] (${node.key})${node.disabled ? " [disabled]" : ""}`
      );
    if (result.graph.edges.length) {
      lines.push("", "Connections:");
      for (const edge of result.graph.edges) {
        const source = result.graph.nodes.find((node) => node.key === edge.from);
        const target = result.graph.nodes.find((node) => node.key === edge.to);
        const port = edge.port === undefined ? "" : ` port ${edge.port}`;
        const endpoint = target?.key || edge.target || edge.targetId || "unresolved";
        lines.push(`  ${source?.name || edge.from} --${edge.kind}${port}--> ${target?.name || endpoint}`);
      }
    }
    if (result.graph.truncated) lines.push("... depth limit reached");
  }
  if (result.warnings.length)
    lines.push("", "Warnings:", ...result.warnings.map((warning) => `  - ${warning}`));
  return lines.join("\n");
}

module.exports = { indexFlow, resolveTab, inventory, resolveEntry, graph, formatInspection };
