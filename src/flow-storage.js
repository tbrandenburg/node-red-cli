"use strict";

/**
 * Builds a Node-RED `storageModule` that serves an in-memory flow array
 * instead of reading/writing a flow file on disk.
 *
 * Implements the minimal `storageModule` contract used by
 * `@node-red/runtime/lib/storage`: `init`, `getFlows`, `saveFlows`,
 * `getCredentials`/`saveCredentials`, `getSettings`/`saveSettings`. Since the
 * CLI never persists anything, all save operations are no-ops and settings
 * are not backed by storage.
 *
 * `saveFlows` is a no-op by design: this CLI never mutates the caller's
 * in-memory flow definition or persists it anywhere.
 */
function createMemoryStorageModule(flows) {
  return {
    async init() {},
    async getFlows() {
      return flows;
    },
    async saveFlows() {},
    async getCredentials() {
      return {};
    },
    async saveCredentials() {},
    async getSettings() {
      return null;
    },
    async saveSettings() {}
  };
}

module.exports = { createMemoryStorageModule };
