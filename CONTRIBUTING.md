# Contributing 🤝

Thanks for your interest in improving `node-red-cli`.

## Before You Start

- Check existing issues and pull requests before starting larger changes.
- For significant behavior changes, open an issue first so the approach can be
  discussed.
- Keep changes focused and avoid unrelated formatting or refactoring.

## Development

Requirements:

- Node.js 18 or newer
- npm

Install dependencies and run the verification suite:

```bash
make install
make test
```

`make install` also configures `git config core.hooksPath .githooks`, so a
`pre-push` hook runs the full CI suite (`make ci`) automatically before every
push.

The test suite has three layers under `test/`:

- `test/unit` — fast tests of `src/link-call.js` logic against a fake
  Node-RED runtime, no embedded runtime started.
- `test/integration` — tests of the adapter against a real embedded Node-RED
  runtime, focused on adapter/runtime interaction (cleanup, concurrency).
- `test/e2e` — the full round trip through the real runtime and the
  `test/fixtures/flows.json` example flow: successful calls, preflight
  validation, timeout behavior, and that the flow file is never modified.

Run all checks the same way CI does:

```bash
make format   # prettier --check
make lint     # eslint
make test     # node --test
make ci       # all three
```

## Pull Requests

1. Create a focused branch from `main`.
2. Add or update tests for behavior changes.
3. Run `make ci` locally.
4. Describe the motivation, implementation, and verification in the pull
   request.
5. Call out compatibility considerations for the supported Node-RED version.

Please do not include credentials, private flow data, generated dependencies,
or temporary archives in commits.

## Code Guidelines

- Prefer small, explicit changes.
- Preserve clean `stdout` output for command results.
- Send diagnostics and errors to `stderr`.
- Propagate failures with meaningful error messages and non-zero exit codes.
- Treat Node-RED internals as version-sensitive and add integration coverage
  when relying on them.

## License

By contributing, you agree that your contributions are provided under the MIT
License included in this repository.
