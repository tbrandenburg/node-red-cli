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
test/fixtures/       Example Node-RED flow used as a test asset
.github/workflows/   CI (Checks: Format, Lint, Tests)
.githooks/           pre-push hook running make ci
```

## Make targets

- `make install` — install dependencies, wire up the pre-push hook
- `make install-global` — install the `node-red-cli` command globally (`npm install -g .`)
- `make format` — check formatting (prettier --check)
- `make lint` — lint (eslint)
- `make test` — run the test suite (node --test)
- `make ci` — format + lint + test (same as CI and the pre-push hook)
- `make clean` — remove node_modules
- `make release bump=patch|minor|major` — bump the version, tag, push, and create a GitHub release

## Lessons Learned

- 2026-09-05: Pitfall: assumed `npm audit fix` clears all fixable vulns after a dependency bump; it silently no-ops when only a `--force` path exists. Prevention: re-run `npm audit` after every `fix` and use `overrides` for stuck transitive deps instead of `--force`.
- 2026-09-05: Pitfall: `make release`'s two separate `git push` calls each re-ran the full pre-push `make ci` (3x total per release), reliably exceeding automation timeouts mid-release. Prevention: push branch+tag together (`git push --no-verify --follow-tags`) when `make ci` already ran moments earlier in the same target.
- 2026-09-06: Pitfall: `node --test` runs test files concurrently by default, so `test/e2e`'s "no leftover temp dirs" check can false-positive on another test file's in-flight `os.tmpdir()` entry (see #26). Prevention: don't assume a lone CI test failure is a real regression before ruling out cross-file concurrency races; re-run once before investigating code changes.
