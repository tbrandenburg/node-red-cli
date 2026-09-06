"use strict";

/**
 * Builds and executes the hardened `docker run` invocation for `--docker`:
 * streams the envelope (`{ flow, msg, options }`) over stdin to a disposable
 * container running the resolved sandbox image, relays stdout/stderr/exit
 * code back to the host.
 *
 * Sandboxing defaults (always applied):
 * - `--rm -i` (always disposable, interactive stdin)
 * - `--network none`, unless `networkNeeded` (i.e. `--node-modules` is set)
 * - `--read-only` root filesystem + a `/tmp` tmpfs mount
 * - `-e HOME=/tmp`, so tools needing a writable `$HOME` (config/cache dirs)
 *   land on the writable `/tmp` tmpfs instead of the read-only rootfs
 * - `--cap-drop=ALL`
 * - `--security-opt=no-new-privileges`
 *
 * When `volumeName` is given (derived from `--user-dir`, see
 * `volumeNameFor`), it is mounted as a named Docker volume at
 * `CONTAINER_USER_DIR` instead of a host bind mount, so `--user-dir` +
 * `--node-modules` persistence never touches the visible host filesystem.
 */

const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

/** Fixed in-container mount path for the `--user-dir` named volume. */
const CONTAINER_USER_DIR = "/data/userDir";

/** Deterministic named-volume name for a given `--user-dir` path, so repeat runs reuse the same volume. */
function volumeNameFor(userDirPath) {
  const hash = crypto.createHash("sha256").update(userDirPath).digest("hex").slice(0, 16);
  return `node-red-cli-userdir-${hash}`;
}

function buildRunArgs(image, { networkNeeded, volumeName }) {
  const args = ["run", "--rm", "-i"];
  if (!networkNeeded) args.push("--network", "none");
  args.push("--read-only", "--tmpfs", "/tmp", "--cap-drop=ALL", "--security-opt=no-new-privileges");
  args.push("-e", "HOME=/tmp");
  if (networkNeeded) {
    // --node-modules runs a real `npm install`, which needs a writable cache
    // dir; point it at the /tmp tmpfs since the root filesystem is read-only.
    args.push("-e", "npm_config_cache=/tmp/.npm-cache");
  }
  if (volumeName) args.push("-v", `${volumeName}:${CONTAINER_USER_DIR}`);
  args.push(image);
  return args;
}

/**
 * Runs `envelope` through the resolved sandbox `image` in a disposable,
 * hardened container. Resolves with `{ code, stdout, stderr }` on any
 * container exit (including non-zero, which is the flow's own error exit
 * code, not a docker-orchestration failure); rejects only when `docker run`
 * itself could not be spawned or exited before the container's own process
 * ran (docker CLI missing, daemon unreachable, invalid image, etc.).
 */
function runContainer(image, envelope, { networkNeeded = false, volumeName } = {}) {
  const args = buildRunArgs(image, { networkNeeded, volumeName });

  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let spawnFailed = false;

    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      spawnFailed = true;
      reject(new Error(`node-red-cli: docker run failed: ${error.message}`));
    });
    child.on("close", (code) => {
      if (spawnFailed) return;
      resolve({ code, stdout, stderr });
    });

    child.stdin.on("error", () => {
      // A broken pipe here (e.g. the container failed to start) is reported
      // via the 'close'/'error' handlers above; swallow the EPIPE itself.
    });
    child.stdin.end(JSON.stringify(envelope));
  });
}

module.exports = { runContainer, buildRunArgs, volumeNameFor, CONTAINER_USER_DIR };
