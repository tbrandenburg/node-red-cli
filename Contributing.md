# Contributing

Thanks for your interest in improving `nr-call`.

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

The test suite starts the embedded Node-RED runtime and verifies successful
returns, preflight validation, timeout behavior, and that the flow file is not
modified.

## Pull Requests

1. Create a focused branch from `main`.
2. Add or update tests for behavior changes.
3. Run `make test` locally.
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
