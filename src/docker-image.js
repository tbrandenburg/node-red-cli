"use strict";

/**
 * Resolves a `--docker [value]` CLI argument into a concrete Docker image
 * reference, building/caching it via the local Docker daemon as needed.
 *
 * Three forms of `value`:
 * - bare (`true`/`undefined`/`""`): default sandbox image
 *   `node-red-cli-sandbox:<local package.json version>`, built on demand
 *   from `node:24-slim` + `npm install -g @tbrandenburg/node-red-cli@<version>`
 *   the first time that version is needed, then cached by Docker forever
 *   (npm registry versions are immutable, so the tag is a permanently valid
 *   cache key - a version bump is the only thing that changes it).
 * - `<image[:tag]>`: used as-is, no build. Assumed to already contain a
 *   compatible `node-red-cli` sandbox entrypoint.
 * - `@<path>` or `<http(s)-url>`: build from a user-supplied Dockerfile
 *   (local file or fetched URL), cached by content hash so an unchanged
 *   Dockerfile isn't rebuilt every run.
 *
 * All failures throw a plain `Error` already carrying the
 * `node-red-cli: docker ...` prefix convention used throughout the CLI.
 */

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync, spawn } = require("node:child_process");
const https = require("node:https");
const http = require("node:http");

/** Fixed path the default sandbox image installs itself into and the entrypoint runs from. */
const SANDBOX_ENTRY_PATH =
  "/usr/local/lib/node_modules/@tbrandenburg/node-red-cli/bin/node-red-cli-sandbox-entry.js";

function isBareValue(value) {
  return value === true || value === undefined || value === "";
}

function isDockerfilePath(value) {
  return typeof value === "string" && value.startsWith("@");
}

function isUrl(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

/** Fails fast with a clear error if the Docker CLI/daemon isn't reachable. */
function checkDockerAvailable() {
  const result = spawnSync("docker", ["info"], { stdio: ["ignore", "ignore", "pipe"] });
  if (result.error) {
    throw new Error(`node-red-cli: docker unavailable: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = (result.stderr || Buffer.alloc(0)).toString("utf8").trim();
    throw new Error(`node-red-cli: docker unavailable: ${detail || "docker info failed"}`);
  }
}

function imageExists(tag) {
  const result = spawnSync("docker", ["image", "inspect", tag], { stdio: ["ignore", "ignore", "ignore"] });
  return result.status === 0;
}

/** Runs `docker build -t <tag> -`, feeding `dockerfileContent` in via stdin (no build context needed). */
function dockerBuild(tag, dockerfileContent) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["build", "-t", tag, "-"], { stdio: ["pipe", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => {
      reject(new Error(`node-red-cli: docker build failed: ${error.message}`));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`node-red-cli: docker build failed: ${(stderr || stdout).trim()}`));
        return;
      }
      resolve();
    });
    child.stdin.end(dockerfileContent);
  });
}

function defaultDockerfile(version) {
  return [
    "FROM node:24-slim",
    `RUN npm install -g @tbrandenburg/node-red-cli@${version}`,
    `ENTRYPOINT ["node", "${SANDBOX_ENTRY_PATH}"]`,
    ""
  ].join("\n");
}

function customTag(content) {
  const hash = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
  return `node-red-cli-sandbox-custom:${hash}`;
}

function fetchText(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith("https://") ? https : http;
    client
      .get(url, (response) => {
        if (response.statusCode !== 200) {
          reject(new Error(`HTTP ${response.statusCode}`));
          response.resume();
          return;
        }
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        response.on("error", reject);
      })
      .on("error", reject);
  });
}

async function readDockerfileFrom(value, cwd) {
  if (isDockerfilePath(value)) {
    const filePath = path.resolve(cwd, value.slice(1));
    try {
      return fs.readFileSync(filePath, "utf8");
    } catch (error) {
      throw new Error(
        `node-red-cli: docker build failed: could not read Dockerfile '${filePath}': ${error.message}`,
        {
          cause: error
        }
      );
    }
  }

  try {
    return await fetchText(value);
  } catch (error) {
    throw new Error(
      `node-red-cli: docker build failed: could not fetch Dockerfile from '${value}': ${error.message}`,
      { cause: error }
    );
  }
}

/**
 * Resolves `dockerValue` (the `--docker [value]` option) into an image
 * reference, building it if not already cached. `version` is the local
 * `package.json` version, used for the default (bare) form.
 */
async function resolveImage(dockerValue, { version, cwd = process.cwd() } = {}) {
  checkDockerAvailable();

  if (isBareValue(dockerValue)) {
    const tag = `node-red-cli-sandbox:${version}`;
    if (!imageExists(tag)) {
      await dockerBuild(tag, defaultDockerfile(version));
    }
    return tag;
  }

  if (isDockerfilePath(dockerValue) || isUrl(dockerValue)) {
    const content = await readDockerfileFrom(dockerValue, cwd);
    const tag = customTag(content);
    if (!imageExists(tag)) {
      await dockerBuild(tag, content);
    }
    return tag;
  }

  // Explicit image[:tag] reference, used as-is.
  return dockerValue;
}

module.exports = { resolveImage, SANDBOX_ENTRY_PATH };
