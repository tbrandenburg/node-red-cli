"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const {
  parseSetParam,
  applySetParams,
  parseFlowJsonParam,
  parseOutputParam,
  formatPayload
} = require("../../src/cli-params");

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

test("unit: parseOutputParam accepts payload and message", () => {
  assert.equal(parseOutputParam("payload"), "payload");
  assert.equal(parseOutputParam("message"), "message");
});

test("unit: parseOutputParam rejects unknown output values", () => {
  assert.throws(() => parseOutputParam("xml"), /invalid --output value 'xml'/);
});

test("unit: formatPayload returns strings as-is", () => {
  assert.equal(formatPayload("hello"), "hello");
});

test("unit: formatPayload JSON-stringifies non-string payloads", () => {
  assert.equal(formatPayload(9), "9");
  assert.equal(formatPayload(true), "true");
  assert.equal(formatPayload(null), "null");
  assert.equal(formatPayload({ a: 1 }), '{"a":1}');
});

test("unit: parseFlowJsonParam parses an inline JSON array", async () => {
  const flows = await parseFlowJsonParam('[{"id":"a","type":"tab"}]', {});
  assert.deepEqual(flows, [{ id: "a", type: "tab" }]);
});

test("unit: parseFlowJsonParam reads the flow JSON from stdin when value is '-'", async () => {
  const readStdin = async () => '[{"id":"a"}]';
  const flows = await parseFlowJsonParam("-", { readStdin });
  assert.deepEqual(flows, [{ id: "a" }]);
});

test("unit: parseFlowJsonParam treats @path as invalid inline JSON", async () => {
  await assert.rejects(parseFlowJsonParam("@/no/such/file.json", {}), /invalid JSON from --flow-json value/);
});

test("unit: parseFlowJsonParam rejects invalid JSON with a clear error", async () => {
  await assert.rejects(parseFlowJsonParam("{not json", {}), /invalid JSON from --flow-json value/);
});

test("unit: parseFlowJsonParam rejects a non-array result", async () => {
  await assert.rejects(
    parseFlowJsonParam('{"id":"a"}', {}),
    /the flow JSON from --flow-json value must be an array/
  );
});

test("unit: parseFlowJsonParam requires readStdin support for '-'", async () => {
  await assert.rejects(parseFlowJsonParam("-", {}), /requires stdin support/);
});
