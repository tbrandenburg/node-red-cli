"use strict";

const DEFAULT_ADMIN_URL = "http://127.0.0.1:1880";
const REQUEST_TIMEOUT_MS = 15000;

function isLoopback(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "::1" || /^127(?:\.\d{1,3}){3}$/.test(host);
}

function createEditClient({
  adminUrl = DEFAULT_ADMIN_URL,
  token = process.env.NODE_RED_TOKEN,
  fetchImpl = fetch
} = {}) {
  let base;
  try {
    base = new URL(adminUrl);
  } catch {
    throw new Error("--admin-url must be a valid HTTP(S) URL");
  }
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error("--admin-url must be an HTTP(S) URL without credentials, query, or fragment");
  }
  if (base.protocol === "http:" && !isLoopback(base.hostname)) {
    throw new Error("--admin-url for a remote host must use HTTPS");
  }
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/`;

  async function request(method, body, resource = "flows") {
    const headers = { "Node-RED-API-Version": "v2", Accept: "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      headers["Node-RED-Deployment-Type"] = "full";
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const url = new URL(resource, base);
      const response = await fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: controller.signal
      });
      if (!response.ok) {
        const errors = {
          401: "Node-RED rejected authentication (401); check NODE_RED_TOKEN",
          403: "Node-RED denied Admin API access (403); check flows.read/flows.write, nodes.read for add operations, and credentials.read for credential operations",
          404: "Node-RED Admin API endpoint not found (404); check --admin-url and Admin API base path",
          409: "Node-RED flows changed since they were read (409); refresh and review the plan"
        };
        throw new Error(
          errors[response.status] || `Node-RED Admin API request failed (HTTP ${response.status})`
        );
      }
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Node-RED Admin API returned an invalid JSON response");
      }
      if (method === "GET" && resource === "flows") {
        if (
          !payload ||
          typeof payload !== "object" ||
          Array.isArray(payload) ||
          !validRevision(payload.rev) ||
          !Array.isArray(payload.flows)
        ) {
          throw new Error("Node-RED Admin API v2 response must contain a nonempty rev and flows array");
        }
        return { rev: payload.rev, flows: payload.flows };
      }
      if (method === "GET" && resource === "nodes") {
        if (!Array.isArray(payload)) throw new Error("Node-RED Admin API node list must be an array");
        return payload
          .filter((nodeSet) => nodeSet?.enabled !== false && Array.isArray(nodeSet?.types))
          .flatMap((nodeSet) => nodeSet.types.filter((type) => typeof type === "string"));
      }
      if (method === "GET") {
        if (!payload || typeof payload !== "object" || Array.isArray(payload))
          throw new Error("Node-RED Admin API returned an invalid credential response");
        return payload;
      }
      if (!payload || typeof payload !== "object" || Array.isArray(payload) || !validRevision(payload.rev)) {
        throw new Error("Node-RED Admin API v2 deploy response must contain a nonempty rev");
      }
      return { rev: payload.rev };
    } catch (error) {
      if (error.name === "AbortError")
        throw new Error("Node-RED Admin API request timed out after 15 seconds", { cause: error });
      if (error instanceof TypeError)
        throw new Error("Could not connect to the Node-RED Admin API", { cause: error });
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    getFlows: () => request("GET"),
    getNodeTypes: () => request("GET", undefined, "nodes"),
    async getCredentialSchema(type, id) {
      if (typeof type !== "string" || !type || typeof id !== "string" || !id)
        throw new Error("credential schema lookup requires node type and ID");
      const safeCredentials = await request(
        "GET",
        undefined,
        `credentials/${encodeURIComponent(type)}/${encodeURIComponent(id)}`
      );
      return Object.fromEntries(
        Object.entries(safeCredentials).map(([key, value]) => {
          if (key.startsWith("has_") && typeof value === "boolean") return [key.slice(4), "password"];
          return [key, "text"];
        })
      );
    },
    postFlows({ rev, flows, credentials }) {
      if (!validRevision(rev)) throw new Error("A nonempty revision is required to deploy flows");
      if (!Array.isArray(flows)) throw new Error("flows must be an array");
      return request("POST", { rev, flows, ...(credentials ? { credentials } : {}) });
    }
  };
}

function validRevision(rev) {
  return typeof rev === "string" && rev.trim().length > 0;
}

module.exports = { createEditClient, DEFAULT_ADMIN_URL };
