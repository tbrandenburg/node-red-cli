"use strict";

const { URL } = require("node:url");
const { AbortSignal } = globalThis;

const MAX_BYTES = 10 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15_000;
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const UNSUPPORTED_SCHEMES = new Set(["data", "file", "ftp", "git", "ssh"]);

function parseFlowUrl(value) {
  if (typeof value !== "string" || /^([a-zA-Z]):[\\/]/.test(value)) return null;
  const scheme = /^([a-zA-Z][a-zA-Z\d+.-]*):/.exec(value)?.[1];
  if (
    !scheme ||
    (!/^https?$/i.test(scheme) &&
      !UNSUPPORTED_SCHEMES.has(scheme.toLowerCase()) &&
      !value.slice(scheme.length + 1).startsWith("//"))
  )
    return null;
  if (!/^https?$/i.test(scheme)) throw new Error(`unsupported flow URL scheme '${scheme}'`);
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("invalid flow URL");
  }
  validateUrl(url);
  return url;
}

function validateUrl(url) {
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error("flow URL redirect must use HTTP or HTTPS");
  if (url.username || url.password) throw new Error("flow URL must not contain credentials");
}

function displayFlowUrl(value) {
  const url = value instanceof URL ? value : new URL(value);
  return `${url.protocol}//${url.host}${url.pathname}`;
}

async function fetchFlowUrl(
  input,
  { fetchImpl = globalThis.fetch, timeoutSignal = AbortSignal.timeout } = {}
) {
  const initial = input instanceof URL ? input : parseFlowUrl(input);
  if (!initial) throw new Error("flow source is not an HTTP(S) URL");
  validateUrl(initial);
  const signal = timeoutSignal(TIMEOUT_MS);
  const visited = new Set();
  let current = new URL(initial);
  let redirects = 0;

  try {
    while (true) {
      validateUrl(current);
      const key = current.href;
      if (visited.has(key)) throw new Error("flow URL redirect loop detected");
      visited.add(key);
      const response = await fetchImpl(current, { redirect: "manual", signal });
      if (REDIRECTS.has(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error("flow URL redirect is missing Location");
        if (redirects >= MAX_REDIRECTS) throw new Error("flow URL exceeded 5 redirects");
        let next;
        try {
          next = new URL(location, current);
        } catch {
          throw new Error("flow URL redirect target is invalid");
        }
        validateUrl(next);
        if (current.protocol === "https:" && next.protocol === "http:")
          throw new Error("flow URL redirect cannot downgrade HTTPS to HTTP");
        current = next;
        redirects += 1;
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel();
        throw new Error(`flow URL request failed with HTTP ${response.status}`);
      }
      const declared = response.headers.get("content-length");
      if (declared !== null && /^\d+$/.test(declared) && Number(declared) > MAX_BYTES) {
        await response.body?.cancel();
        throw new Error("flow URL response exceeds the 10 MiB limit");
      }
      if (!response.body) throw new Error("flow URL response is empty");
      const reader = response.body.getReader();
      const chunks = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) {
          await reader.cancel();
          throw new Error("flow URL response exceeds the 10 MiB limit");
        }
        chunks.push(Buffer.from(value));
      }
      let flow;
      try {
        flow = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        throw new Error("flow URL response is not valid JSON");
      }
      if (!Array.isArray(flow)) throw new Error("flow URL response must be a JSON array");
      return flow;
    }
  } catch (error) {
    if (error.message?.startsWith("flow URL ")) throw new Error(error.message, { cause: error });
    if (signal.aborted) throw new Error("flow URL request timed out after 15 seconds", { cause: error });
    throw new Error("could not fetch flow URL (network or TLS error)", { cause: error });
  }
}

module.exports = { parseFlowUrl, fetchFlowUrl, displayFlowUrl };
