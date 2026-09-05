"use strict";

/**
 * Disk-diffing and npm install logic for `--node-modules`.
 *
 * Installation is done by shelling out to the npm CLI bundled as a
 * transitive dependency of `node-red` (the same binary Node-RED's own
 * palette manager uses, see `@node-red/registry/lib/installer.js`),
 * rather than going through `RED.nodes.installModule()`. That API only
 * works reliably once `RED.start()` has fully completed (it needs
 * runtime settings that aren't available until then), but by that point
 * the target flow has already been deployed with any node types it
 * references unresolved, and Node-RED does not hot-swap a "missing" node
 * into a freshly installed one without a fresh deploy. Installing via a
 * plain `npm install` into `userDir` before `RED.init()`/`RED.start()` is
 * simpler and avoids that ordering problem entirely: Node-RED's own
 * `localfilesystem` node loader always scans `<userDir>/node_modules` on
 * disk regardless of which flow storage module is used, so a module
 * installed this way is picked up like any other palette-installed node.
 */

const fs = require("node:fs");
const path = require("node:path");
const childProcess = require("node:child_process");

/**
 * Checks whether `<userDir>/node_modules/<name>` is already present and
 * consistent (has a readable `package.json` with a `node-red` key, and
 * matches `version` when given). Returns `false` for a partially-written
 * or otherwise inconsistent module directory so it gets (re)installed
 * rather than treated as already installed.
 */
function isModuleInstalled(userDir, name, version) {
  const pkgPath = path.join(userDir, "node_modules", name, "package.json");
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    return false;
  }
  if (!pkg || typeof pkg !== "object" || !pkg["node-red"]) {
    return false;
  }
  if (version && pkg.version !== version) {
    return false;
  }
  return true;
}

/** Returns the subset of `modules` not already present/consistent in `userDir`. */
function diffMissingModules(userDir, modules) {
  return modules.filter(({ name, version }) => !isModuleInstalled(userDir, name, version));
}

function npmCliPath() {
  return path.join(path.dirname(require.resolve("npm/package.json")), "bin", "npm-cli.js");
}

/**
 * Verifies the bundled npm CLI is usable, mirroring
 * `@node-red/registry/lib/installer.js`'s own `checkPrereq()` npm-version
 * check. Throws a clear error otherwise (e.g. missing/broken `npm` install
 * or unusable Node.js binary).
 */
function checkNpmAvailable() {
  return new Promise((resolve, reject) => {
    childProcess.execFile(process.execPath, [npmCliPath(), "-v"], (error) => {
      if (error) {
        reject(new Error(`npm is not available (required by --node-modules): ${error.message}`));
        return;
      }
      resolve();
    });
  });
}

/** Runs `npm install <name>[@version]` into `userDir`, returns on success, throws a clear error otherwise. */
function npmInstall(userDir, { name, version }, timeoutMs = 5 * 60 * 1000) {
  const installName = version ? `${name}@${version}` : name;
  const args = [
    npmCliPath(),
    "install",
    "--no-audit",
    "--no-update-notifier",
    "--no-fund",
    "--save",
    "--omit=dev",
    "--",
    installName
  ];
  return new Promise((resolve, reject) => {
    childProcess.execFile(
      process.execPath,
      args,
      { cwd: userDir, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          if (error.killed || error.signal) {
            reject(
              new Error(
                `failed to install --node-modules '${installName}': npm install timed out after ${timeoutMs}ms ` +
                  "(is the npm registry reachable?)"
              )
            );
            return;
          }
          const detail = (stderr || stdout || error.message).trim().split("\n").slice(-20).join("\n");
          reject(new Error(`failed to install --node-modules '${installName}': ${detail}`));
          return;
        }
        resolve();
      }
    );
  });
}

/**
 * Installs every module in `modules` that is missing/inconsistent in
 * `<userDir>/node_modules`, skipping any already present and consistent.
 * Installs run sequentially so a shared `userDir` isn't hit by concurrent
 * npm invocations from within a single CLI run. Throws on the first
 * failure (no partial-success reporting) and re-validates the module is a
 * genuine Node-RED node module afterwards.
 */
async function installMissingNodeModules(userDir, modules, { timeoutMs } = {}) {
  const missing = diffMissingModules(userDir, modules);
  if (missing.length === 0) return { installed: [], skipped: modules };

  await checkNpmAvailable();
  fs.mkdirSync(userDir, { recursive: true });

  for (const module of missing) {
    await npmInstall(userDir, module, timeoutMs);
    if (!isModuleInstalled(userDir, module.name, module.version)) {
      throw new Error(
        `failed to install --node-modules '${module.name}': installed package is not a valid Node-RED node module (missing "node-red" key in its package.json)`
      );
    }
  }
  return { installed: missing, skipped: modules.filter((m) => !missing.includes(m)) };
}

module.exports = {
  isModuleInstalled,
  diffMissingModules,
  installMissingNodeModules,
  checkNpmAvailable
};
