"use strict";

const js = require("@eslint/js");

module.exports = [
  {
    ignores: ["node_modules/**", ".worktrees/**", "test/fixtures/**"]
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "commonjs",
      globals: {
        process: "readonly",
        require: "readonly",
        module: "writable",
        __dirname: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        Promise: "readonly",
        fetch: "readonly",
        URL: "readonly",
        AbortController: "readonly",
        structuredClone: "readonly"
      }
    },
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_" }]
    }
  }
];
