"use strict";

/**
 * Parsing, validation, and userDir resolution for the
 * `--node-modules <name[@version]>[,...]` / `--user-dir [path]` CLI options.
 *
 * Actual disk-diffing and npm install logic lives in `./node-modules-install`
 * to keep this file focused and under the repo's soft per-file LOC limit.
 */

const os = require("node:os");
const path = require("node:path");

/** Simplified but strict npm package name validation (no external dep). */
const NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** Loose semver validation: major[.minor[.patch]] with optional -pre/+build, or a dist-tag word. */
const VERSION_RE = /^[a-zA-Z0-9][a-zA-Z0-9.+_-]*$/;

const DEFAULT_DENY_PATTERNS = [
  /\.\./, // path traversal
  /^\./, // hidden/relative
  /:\/\//, // URLs
  /\s/, // whitespace
  /^file:/i
];

/** Extra deny patterns configurable via NODE_RED_CLI_DENY_MODULES (comma-separated exact names or *-globs). */
function envDenyPatterns() {
  const raw = process.env.NODE_RED_CLI_DENY_MODULES;
  if (!raw) return [];
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => new RegExp(`^${entry.split("*").map(escapeRegExp).join(".*")}$`));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Checks `name` against the built-in security denylist (path traversal,
 * URLs, whitespace, `file:` refs) plus any patterns configured via
 * `NODE_RED_CLI_DENY_MODULES`.
 */
function isDenied(name) {
  return [...DEFAULT_DENY_PATTERNS, ...envDenyPatterns()].some((pattern) => pattern.test(name));
}

/**
 * Splits a single `--node-modules` value into its `name[@version]` entries
 * (comma-separated), also merging multiple repeated `--node-modules`
 * occurrences into one flat list.
 */
function splitEntries(values) {
  const list = Array.isArray(values) ? values : [values];
  return list.flatMap((value) => String(value).split(","));
}

/**
 * Parses one `name[@version]` entry. Handles scoped package names
 * (`@scope/name` or `@scope/name@version`) by only splitting on the last
 * `@` when it isn't the entry's leading scope marker.
 */
function parseEntry(raw) {
  const entry = raw.trim();
  if (entry.length === 0) {
    throw new Error("invalid --node-modules entry: empty module name");
  }

  const at = entry.startsWith("@") ? entry.indexOf("@", 1) : entry.indexOf("@");
  const name = at === -1 ? entry : entry.slice(0, at);
  const version = at === -1 ? undefined : entry.slice(at + 1);

  if (version === "") {
    throw new Error(`invalid --node-modules entry '${entry}': missing version after '@'`);
  }
  if (!NAME_RE.test(name)) {
    throw new Error(`invalid --node-modules entry '${entry}': '${name}' is not a valid npm package name`);
  }
  if (version !== undefined && !VERSION_RE.test(version)) {
    throw new Error(`invalid --node-modules entry '${entry}': '${version}' is not a valid version`);
  }
  if (isDenied(name)) {
    throw new Error(`invalid --node-modules entry '${entry}': module '${name}' is not allowed`);
  }

  return { name, version };
}

/**
 * Parses and validates the full `--node-modules` option value(s) into a
 * deduplicated list of `{ name, version }` entries. Throws a clear `Error`
 * on any malformed entry, before any npm process is spawned.
 */
function parseNodeModulesParam(values) {
  const modules = splitEntries(values).map(parseEntry);

  const seen = new Set();
  for (const { name } of modules) {
    if (seen.has(name)) {
      throw new Error(`invalid --node-modules value: module '${name}' is declared more than once`);
    }
    seen.add(name);
  }
  return modules;
}

/**
 * Default persistent userDir used when `--user-dir` is passed with no
 * explicit path (bare flag): `$XDG_CACHE_HOME/node-red-cli`, falling back
 * to `~/.cache/node-red-cli`.
 */
function defaultCacheDir() {
  const base = process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache");
  return path.join(base, "node-red-cli");
}

/**
 * Resolves the `--user-dir` CLI option into an absolute persistent path, or
 * `undefined` when the option wasn't given at all (ephemeral mode).
 * `--user-dir` (bare, no value) resolves to the default cache dir;
 * `--user-dir <path>` resolves `<path>` relative to `cwd`.
 */
function resolveUserDir(value, cwd = process.cwd()) {
  if (value === undefined) return undefined;
  if (value === true) return defaultCacheDir();
  return path.resolve(cwd, value);
}

module.exports = {
  parseNodeModulesParam,
  defaultCacheDir,
  resolveUserDir,
  isDenied
};
