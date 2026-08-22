# AGENTS.md

## Project

`node-red-cli` calls existing Node-RED `link in` / `link out (return)` flows
from a CLI or Node.js host, like ordinary functions, using the real embedded
Node-RED runtime. No flow mutation, no temporary nodes.

## Folder structure

```text
bin/                CLI entrypoint (node-red-cli)
src/                 Host-side link-call adapter (library API)
test/unit/           Fast tests against a fake Node-RED runtime
test/integration/    Adapter tests against a real embedded runtime
test/e2e/            Full round trip through the example flow
test/fixtures/       Example Node-RED flow used as a test asset
.github/workflows/   CI (Checks: Format, Lint, Tests)
.githooks/           pre-push hook running make ci
```

## Make targets

- `make install` — install dependencies, wire up the pre-push hook
- `make format` — check formatting (prettier --check)
- `make lint` — lint (eslint)
- `make test` — run the test suite (node --test)
- `make ci` — format + lint + test (same as CI and the pre-push hook)
- `make clean` — remove node_modules
