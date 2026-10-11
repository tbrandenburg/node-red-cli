"use strict";

const fs = require("node:fs");
const path = require("node:path");

function resolveWorkingDirectory(value, originalCwd = process.cwd()) {
  if (value === undefined) return undefined;
  return path.resolve(originalCwd, value);
}

function applyWorkingDirectory(value, originalCwd = process.cwd()) {
  const directory = resolveWorkingDirectory(value, originalCwd);
  if (directory === undefined) return;

  let stats;
  try {
    stats = fs.statSync(directory);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR")
      throw new Error(`working directory not found: ${directory}`, { cause: error });
    throw new Error(`cannot access working directory ${directory}: ${error.code || error.message}`, {
      cause: error
    });
  }
  if (!stats.isDirectory()) throw new Error(`not a working directory: ${directory}`);

  try {
    process.chdir(directory);
  } catch (error) {
    throw new Error(`cannot use working directory ${directory}: ${error.code || error.message}`, {
      cause: error
    });
  }
}

module.exports = { applyWorkingDirectory, resolveWorkingDirectory };
