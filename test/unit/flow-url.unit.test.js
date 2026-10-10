"use strict";

const assert = require("node:assert/strict");
const { ReadableStream } = require("node:stream/web");
const test = require("node:test");
const { parseFlowUrl, fetchFlowUrl, displayFlowUrl } = require("../../src/flow-url");
const { AbortSignal, Response } = globalThis;

function response(status, body, headers = {}) {
  return new Response(body, { status, headers });
}

test("explicit HTTP(S) URLs are parsed while local paths retain file treatment", () => {
  assert.equal(parseFlowUrl("https://example.org/flows.json").hostname, "example.org");
  assert.equal(parseFlowUrl("http://example.org/flows.json").protocol, "http:");
  assert.equal(parseFlowUrl("relative:flows.json"), null);
  assert.equal(parseFlowUrl("./folder:flows.json"), null);
  assert.equal(parseFlowUrl("C:\\flows.json"), null);
  assert.throws(() => parseFlowUrl("ftp://example.org/flows.json"), /unsupported/);
  assert.throws(() => parseFlowUrl("ftp:example.org/flows.json"), /unsupported/);
  assert.throws(() => parseFlowUrl("https://%zz"), /invalid/);
  assert.throws(() => parseFlowUrl("https://user:secret@example.org/flows.json"), /credentials/);
});

test("redirects are manual, relative targets work, and query data is redacted", async () => {
  const calls = [];
  const flow = [{ id: "tab", type: "tab" }];
  const result = await fetchFlowUrl("https://example.org/start?token=secret", {
    fetchImpl: async (url, options) => {
      calls.push([url.href, options.redirect]);
      return calls.length === 1
        ? response(302, null, { location: "/flows.json?token=secret" })
        : response(200, JSON.stringify(flow), { "content-type": "text/plain" });
    }
  });
  assert.deepEqual(result, flow);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([, redirect]) => redirect === "manual"));
  assert.equal(
    displayFlowUrl("https://example.org/flows.json?token=secret#frag"),
    "https://example.org/flows.json"
  );
});

test("redirect loops, excessive redirects, missing locations, and downgrade fail", async () => {
  await assert.rejects(
    fetchFlowUrl("https://example.org/a", {
      fetchImpl: async () => response(302, null, { location: "/a" })
    }),
    /loop/
  );
  await assert.rejects(
    fetchFlowUrl("https://example.org/a", {
      fetchImpl: async (url) => response(302, null, { location: `${url.pathname}-next` })
    }),
    /5 redirects/
  );
  await assert.rejects(
    fetchFlowUrl("https://example.org/a", { fetchImpl: async () => response(302, null) }),
    /missing Location/
  );
  await assert.rejects(
    fetchFlowUrl("https://example.org/a", {
      fetchImpl: async () => response(302, null, { location: "http://example.org/b" })
    }),
    /downgrade/
  );
  await assert.rejects(
    fetchFlowUrl("https://example.org/a", {
      fetchImpl: async () => response(302, null, { location: "file:///etc/passwd" })
    }),
    /HTTP or HTTPS/
  );
});

test("HTTP failures, invalid JSON, non-arrays, and oversized bodies fail without leaking URL tokens", async () => {
  for (const [status, body, expected] of [
    [404, "private response", /HTTP 404/],
    [200, "not json", /not valid JSON/],
    [200, "{}", /JSON array/],
    [200, "[]", null]
  ]) {
    if (expected) {
      await assert.rejects(
        fetchFlowUrl("https://example.org/flows?token=secret", {
          fetchImpl: async () => response(status, body)
        }),
        (error) =>
          expected.test(error.message) && !error.message.includes("secret") && !error.message.includes(body)
      );
    }
  }
  await assert.rejects(
    fetchFlowUrl("https://example.org/flows", {
      fetchImpl: async () => response(200, "[]", { "content-length": String(11 * 1024 * 1024) })
    }),
    /10 MiB/
  );
  const huge = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(10 * 1024 * 1024));
      controller.enqueue(new Uint8Array([1]));
    }
  });
  await assert.rejects(
    fetchFlowUrl("https://example.org/flows", {
      fetchImpl: async () => new Response(huge)
    }),
    /10 MiB/
  );
});

test("one timeout signal bounds both response headers and streamed body reads", async () => {
  const timeoutSignal = () => AbortSignal.timeout(10);
  await assert.rejects(
    fetchFlowUrl("https://example.org/flows", {
      timeoutSignal,
      fetchImpl: (_url, { signal }) =>
        new Promise((resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        })
    }),
    /timed out after 15 seconds/
  );
  await assert.rejects(
    fetchFlowUrl("https://example.org/flows", {
      timeoutSignal,
      fetchImpl: async (_url, { signal }) =>
        new Response(
          new ReadableStream({
            start(controller) {
              signal.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
            },
            pull() {}
          })
        )
    }),
    /timed out after 15 seconds/
  );
});
