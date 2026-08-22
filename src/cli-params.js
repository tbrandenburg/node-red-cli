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

module.exports = { parseSetParam, applySetParams };
