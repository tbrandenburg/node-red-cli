"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { parseSetParam, applySetParams, parseFormatParam, formatPlain } = require("../../src/cli-params");

test("unit: parseSetParam JSON-parses values when possible", () => {
  assert.deepEqual(parseSetParam("x=4"), { key: "x", value: 4 });
  assert.deepEqual(parseSetParam("flag=true"), { key: "flag", value: true });
  assert.deepEqual(parseSetParam('obj={"a":1}'), { key: "obj", value: { a: 1 } });
});

test("unit: parseSetParam keeps non-JSON values as plain strings", () => {
  assert.deepEqual(parseSetParam("name=alice"), { key: "name", value: "alice" });
});

test("unit: parseSetParam rejects params without a key", () => {
  assert.throws(() => parseSetParam("=4"), /expected key=value/);
  assert.throws(() => parseSetParam("novalue"), /expected key=value/);
});

test("unit: parseSetParam rejects a missing value (e.g. --set at the end of argv)", () => {
  assert.throws(() => parseSetParam(undefined), /requires a key=value argument/);
});

test("unit: applySetParams returns the payload unchanged when no params are given", () => {
  const payload = { x: 1 };
  assert.equal(applySetParams(payload, []), payload);
});

test("unit: applySetParams merges params onto an existing object payload", () => {
  const merged = applySetParams({ x: 4 }, ["y=5"]);
  assert.deepEqual(merged, { x: 4, y: 5 });
});

test("unit: applySetParams params override existing payload keys", () => {
  const merged = applySetParams({ x: 4, y: 1 }, ["y=5"]);
  assert.deepEqual(merged, { x: 4, y: 5 });
});

test("unit: applySetParams builds a fresh object when the payload isn't a plain object", () => {
  assert.deepEqual(applySetParams(undefined, ["x=4", "y=5"]), { x: 4, y: 5 });
  assert.deepEqual(applySetParams("scalar", ["x=4"]), { x: 4 });
  assert.deepEqual(applySetParams([1, 2], ["x=4"]), { x: 4 });
});

test("unit: parseFormatParam accepts 'json' and 'plain'", () => {
  assert.equal(parseFormatParam("json"), "json");
  assert.equal(parseFormatParam("plain"), "plain");
});

test("unit: parseFormatParam rejects unknown format values", () => {
  assert.throws(() => parseFormatParam("xml"), /invalid --format value 'xml'/);
});

test("unit: formatPlain returns strings as-is", () => {
  assert.equal(formatPlain("hello"), "hello");
});

test("unit: formatPlain JSON-stringifies non-string payloads", () => {
  assert.equal(formatPlain(9), "9");
  assert.equal(formatPlain(true), "true");
  assert.equal(formatPlain(null), "null");
  assert.equal(formatPlain({ a: 1 }), '{"a":1}');
});
