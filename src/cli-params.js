"use strict";

/**
 * Parses a single `key=value` pair as used by `--set key=value`.
 *
 * The value is JSON-parsed when possible (numbers, booleans, null, objects,
 * arrays), so `--set x=4` yields the number `4`, not the string `"4"`. Values
 * that aren't valid JSON (e.g. `--set name=alice`) are kept as plain strings.
 */
function parseSetParam(pair) {
  if (typeof pair !== "string") {
    throw new Error("--set requires a key=value argument");
  }
  const eq = pair.indexOf("=");
  if (eq <= 0) {
    throw new Error(`invalid --set value '${pair}', expected key=value`);
  }
  const key = pair.slice(0, eq);
  const raw = pair.slice(eq + 1);
  try {
    return { key, value: JSON.parse(raw) };
  } catch {
    return { key, value: raw };
  }
}

/**
 * Maps `--set key=value` CLI params onto `msg.payload` attributes.
 *
 * Existing payload attributes are kept; `--set` params are applied on top,
 * in the given order, so later params win on key collisions. If the current
 * payload isn't a plain object (e.g. absent, a primitive, or an array), it is
 * replaced by a fresh object built from the params.
 */
function applySetParams(payload, pairs) {
  if (pairs.length === 0) return payload;

  const base = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  const merged = { ...base };
  for (const pair of pairs) {
    const { key, value } = parseSetParam(pair);
    merged[key] = value;
  }
  return merged;
}

/**
 * Resolves a `--flow-json <value>` CLI option into a parsed flow array.
 *
 * Supports three forms:
 * - `-`: read the flow JSON from stdin, via the injected `readStdin()`.
 * - `@<path>`: read the flow JSON from the file at `<path>` (resolved
 *   relative to `cwd`), mirroring the positional `<flows.json>` argument.
 * - anything else: treated as an inline JSON string.
 *
 * Throws a clear `Error` when the value isn't valid JSON, or when it parses
 * to something other than an array (Node-RED flow files are JSON arrays of
 * node configs).
 */
async function parseFlowJsonParam(value, { readStdin, cwd = process.cwd() } = {}) {
  let raw;
  let source;
  if (value === "-") {
    if (typeof readStdin !== "function") {
      throw new Error("--flow-json - requires stdin support");
    }
    raw = await readStdin();
    source = "stdin";
  } else if (value.startsWith("@")) {
    const fs = require("node:fs");
    const path = require("node:path");
    const filePath = path.resolve(cwd, value.slice(1));
    source = filePath;
    try {
      raw = fs.readFileSync(filePath, "utf8");
    } catch (error) {
      throw new Error(`could not read --flow-json file '${filePath}': ${error.message}`, { cause: error });
    }
  } else {
    raw = value;
    source = "--flow-json value";
  }

  let flows;
  try {
    flows = JSON.parse(raw);
  } catch (error) {
    throw new Error(`invalid JSON from ${source}: ${error.message}`, { cause: error });
  }

  if (!Array.isArray(flows)) {
    throw new Error(`the flow JSON from ${source} must be an array of node configs`);
  }

  return flows;
}

const VALID_FORMATS = ["json", "plain"];

/**
 * Validates the `--format` CLI option value.
 *
 * Returns the format unchanged when valid (`"json"` or `"plain"`); throws
 * otherwise so the CLI can report a clear error and exit non-zero.
 */
function parseFormatParam(format) {
  if (!VALID_FORMATS.includes(format)) {
    throw new Error(`invalid --format value '${format}', expected one of: ${VALID_FORMATS.join(", ")}`);
  }
  return format;
}

/**
 * Renders a link-out result for `--format=plain`: just the raw payload,
 * as text. Strings are printed as-is; other JSON-compatible values
 * (numbers, booleans, null, objects, arrays) are JSON-stringified.
 */
function formatPlain(payload) {
  return typeof payload === "string" ? payload : JSON.stringify(payload);
}

module.exports = {
  parseSetParam,
  applySetParams,
  parseFlowJsonParam,
  parseFormatParam,
  formatPlain,
  VALID_FORMATS
};
