"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const FLOW_DIRECTORIES = [
  "",
  "data",
  ".node-red",
  ".workflows",
  ".node-red-cli",
  "node-red",
  "workflows",
  "node-red-cli"
];

/** Returns whether a flow argument names a path rather than a discoverable filename. */
function isExplicitPath(value) {
  return path.isAbsolute(value) || value.includes("/") || value.includes("\\") || value.startsWith(".");
}

function getDefaultFlowDirs({ cwd, homeDir }) {
  return [
    ...FLOW_DIRECTORIES.map((directory) => path.join(cwd, directory)),
    path.join(homeDir, ".node-red"),
    path.join(homeDir, ".node-red-cli"),
    path.join(homeDir, ".workflows")
  ];
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Resolves an explicit flow path or discovers a bare filename in fixed locations. */
function resolveFlowFile({
  flowFileArg = "flows.json",
  flowDir,
  cwd = process.cwd(),
  homeDir = os.homedir()
}) {
  if (isExplicitPath(flowFileArg)) {
    const filePath = path.resolve(cwd, flowFileArg);
    if (isFile(filePath)) return filePath;
    throw new Error(`flow file not found: ${filePath}`);
  }

  const directories = flowDir ? [path.resolve(cwd, flowDir)] : getDefaultFlowDirs({ cwd, homeDir });
  const matches = directories.map((directory) => path.join(directory, flowFileArg)).filter(isFile);
  if (matches.length > 0) return matches[0];

  if (flowDir) {
    throw new Error(`flow file not found: ${path.join(path.resolve(cwd, flowDir), flowFileArg)}`);
  }
  throw new Error(`flow file not found: '${flowFileArg}' in the flow lookup locations`);
}

module.exports = { isExplicitPath, getDefaultFlowDirs, resolveFlowFile };
