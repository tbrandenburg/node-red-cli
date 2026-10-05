"use strict";

const fs = require("node:fs");
const path = require("node:path");

/** A separator or absolute prefix makes the flow-file argument an exact path. */
function isExplicitPath(value) {
  return path.isAbsolute(value) || value.includes("/") || value.includes("\\");
}

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/** Resolves one exact flow-file path without searching fallback locations. */
function resolveFlowFile({ flowFileArg = "flows.json", flowDir, cwd = process.cwd() }) {
  const filename = flowFileArg ?? "flows.json";
  let filePath;

  if (isExplicitPath(filename)) {
    filePath = path.resolve(cwd, filename);
  } else if (flowDir) {
    const directory = path.resolve(cwd, flowDir);
    let stats;
    try {
      stats = fs.statSync(directory);
    } catch {
      throw new Error(`flow directory not found: ${directory}`);
    }
    if (!stats.isDirectory()) throw new Error(`flow directory is not a directory: ${directory}`);
    filePath = path.join(directory, filename);
  } else {
    filePath = path.join(cwd, filename);
  }

  if (!fs.existsSync(filePath)) throw new Error(`flow file not found: ${filePath}`);
  if (!isFile(filePath)) throw new Error(`flow path is not a regular file: ${filePath}`);
  return path.resolve(filePath);
}

module.exports = { isExplicitPath, resolveFlowFile };
