"use strict";

const crypto = require("node:crypto");

function getConfigs(RED, errors) {
  const configs = new Map();
  RED.nodes.eachNode((config) => {
    if (configs.has(config.id)) errors.push(`duplicate node id '${config.id}'`);
    configs.set(config.id, config);
  });
  return configs;
}

/** Resolve a Node-RED workspace tab by id or label. */
function resolveFlow(RED, flowSelector) {
  const errors = [];
  const configs = getConfigs(RED, errors);
  const flows = [...configs.values()].filter((config) => config.type === "tab");

  if (typeof flowSelector === "undefined" || flowSelector === null || flowSelector === "") {
    if (flows.length === 1) {
      return { ok: errors.length === 0, errors, flow: flows[0], configs, selectedBy: "fallback" };
    }
    errors.push(
      flows.length === 0
        ? "the loaded flow configuration contains no workspace tabs"
        : `flow must be specified because ${flows.length} workspace tabs are present`
    );
    return { ok: false, errors, configs };
  }

  if (typeof flowSelector !== "string") {
    errors.push("flow must be a workspace tab id or label");
    return { ok: false, errors, configs };
  }

  let matches = flows.filter((flow) => flow.id === flowSelector);
  let selectedBy = "id";
  if (matches.length === 0) {
    matches = flows.filter((flow) => flow.label === flowSelector);
    selectedBy = "label";
  }
  if (matches.length === 1) {
    return { ok: errors.length === 0, errors, flow: matches[0], configs, selectedBy };
  }
  errors.push(
    matches.length === 0
      ? `flow '${flowSelector}' was not found`
      : `flow label '${flowSelector}' is ambiguous`
  );
  return { ok: false, errors, configs };
}

function validateTarget(RED, targetSelector, { flow } = {}) {
  const flowResolution = resolveFlow(RED, flow);
  const errors = [...flowResolution.errors];
  const configs = flowResolution.configs;

  if (typeof targetSelector !== "string" || targetSelector.length === 0) {
    errors.push("target must be a non-empty link-in id or name");
  }

  // Validate all ordinary wires before following the requested target.
  for (const config of configs.values()) {
    for (const output of config.wires || []) {
      for (const destinationId of output || []) {
        if (!configs.has(destinationId)) {
          errors.push(`node '${config.id}' wires to missing node '${destinationId}'`);
        }
      }
    }
  }

  const selectedFlow = flowResolution.flow;
  let targetConfig = configs.get(targetSelector);
  if (targetConfig && selectedFlow && targetConfig.z !== selectedFlow.id) {
    errors.push(`target '${targetSelector}' does not belong to flow '${selectedFlow.id}'`);
    targetConfig = undefined;
  }
  if (!targetConfig && selectedFlow && typeof targetSelector === "string") {
    const matches = [...configs.values()].filter((config) =>
      config.type === "link in" && config.z === selectedFlow.id && config.name === targetSelector
    );
    if (matches.length === 1) targetConfig = matches[0];
    else if (matches.length > 1) errors.push(`link in name '${targetSelector}' is ambiguous in flow '${selectedFlow.id}'`);
  }
  if (!targetConfig && selectedFlow) errors.push(`target '${targetSelector}' is not present in flow '${selectedFlow.id}'`);
  if (targetConfig && targetConfig.type !== "link in") {
    errors.push(`target '${targetConfig.id}' has type '${targetConfig.type}', expected 'link in'`);
  }

  const targetNode = targetConfig && RED.nodes.getNode(targetConfig.id);
  if (targetConfig && !targetNode) errors.push(`target '${targetConfig.id}' is not instantiated in the runtime`);
  else if (targetNode && targetNode.type !== "link in") errors.push(`runtime target '${targetConfig.id}' is not a 'link in' node`);

  const reachable = new Set();
  const returnIds = new Set();
  function walk(id) {
    if (reachable.has(id)) return;
    reachable.add(id);
    const config = configs.get(id);
    if (!config) return;
    if (config.type === "link out" && config.mode === "return") returnIds.add(id);
    for (const output of config.wires || []) {
      for (const destinationId of output || []) walk(destinationId);
    }
  }
  if (targetConfig) walk(targetConfig.id);

  if (targetConfig && (!targetConfig.wires || targetConfig.wires.every((output) => !output?.length))) {
    errors.push(`target '${targetConfig.id}' has no outgoing wires`);
  }
  if (targetConfig && returnIds.size === 0) {
    errors.push(`target '${targetConfig.id}' has no reachable link out with mode 'return'`);
  }
  for (const returnId of returnIds) {
    if (!RED.nodes.getNode(returnId)) errors.push(`return node '${returnId}' is not instantiated in the runtime`);
  }

  if (!RED.hooks || typeof RED.hooks.add !== "function" || typeof RED.hooks.remove !== "function") {
    errors.push("Node-RED runtime hooks are not available");
  }

  return {
    ok: errors.length === 0,
    flowId: selectedFlow?.id,
    flowLabel: selectedFlow?.label,
    selectedFlowBy: flowResolution.selectedBy,
    targetId: targetConfig?.id,
    targetName: targetConfig?.name,
    errors: [...new Set(errors)],
    reachableNodeIds: [...reachable],
    returnLinkOutIds: [...returnIds]
  };
}

/**
 * Adapter for Node-RED 5.0.x link-in/link-out(return) flows.
 *
 * This intentionally uses Node-RED's current internal message convention
 * (_linkSource) and the documented runtime onReceive hook. Keep it isolated
 * and covered by integration tests; it is not a public Node-RED call API.
 */
function createHostLinkCaller(RED) {
  const callerId = `__nr-call-host-${crypto.randomBytes(8).toString("hex")}`;
  const pending = new Map();
  const returnLinkOutIds = new Set();
  const hookId = `onReceive.${callerId}`;

  // RED.nodes is internal. We only read the deployed node configuration;
  // no node is added, rewired, deployed or removed.
  RED.nodes.eachNode((config) => {
    if (config.type === "link out" && config.mode === "return") {
      returnLinkOutIds.add(config.id);
    }
  });

  RED.hooks.add(hookId, ({ msg, destination }) => {
    if (!returnLinkOutIds.has(destination.id)) return;

    const stack = msg?._linkSource;
    const source = stack?.[stack.length - 1];
    if (source?.node !== callerId) return;

    // Mirror LinkCallNode/FunctionNode cleanup before returning the result.
    stack.pop();
    if (stack.length === 0) delete msg._linkSource;

    const operation = pending.get(source.id);
    if (operation) {
      pending.delete(source.id);
      clearTimeout(operation.timer);
      operation.resolve(msg);
    }

    // Do not let LinkOutNode continue: it would try RED.nodes.getNode(callerId),
    // but the host intentionally is not a configured Node-RED node.
    return false;
  });

  function call(target, msg, { flow, timeout = 5000, clone = true } = {}) {
    const validation = validateTarget(RED, target, { flow });
    if (!validation.ok) {
      return Promise.reject(new Error(`preflight validation failed:\n- ${validation.errors.join("\n- ")}`));
    }
    if (!Number.isFinite(timeout) || timeout <= 0) {
      return Promise.reject(new TypeError("timeout must be a positive number of milliseconds"));
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      return Promise.reject(new TypeError("msg must be an object"));
    }

    const targetNode = RED.nodes.getNode(validation.targetId);
    if (!targetNode || targetNode.type !== "link in") {
      return Promise.reject(new Error(`link in '${validation.targetId}' not found`));
    }

    const callId = crypto.randomBytes(14).toString("hex");
    const input = clone ? RED.util.cloneMessage(msg) : msg;
    input._linkSource ??= [];
    input._linkSource.push({ node: callerId, id: callId });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(callId);
        reject(new Error(`link call timed out after ${timeout} ms`));
      }, timeout);

      pending.set(callId, { resolve, reject, timer });
      try {
        targetNode.receive(input);
      } catch (error) {
        pending.delete(callId);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  function close(reason = new Error("host link caller closed")) {
    RED.hooks.remove(hookId);
    for (const operation of pending.values()) {
      clearTimeout(operation.timer);
      operation.reject(reason);
    }
    pending.clear();
  }

  return { call, close };
}

module.exports = { createHostLinkCaller, resolveFlow, validateTarget };
