# Security Policy

## Supported Versions

Security fixes are currently considered for the latest version on the `main`
branch. This project is under active development and does not yet promise a
long-term support window.

## Reporting a Vulnerability

Please do not report security vulnerabilities in a public issue.

Use GitHub's private vulnerability reporting for this repository when
available. If it is not available, contact the repository owner privately
through GitHub with:

- a clear description of the issue
- affected versions or configuration
- reproducible steps or a minimal example
- potential impact
- a suggested mitigation, if known

Do not include secrets or private production flows in a report. Replace them
with minimal synthetic examples.

You can expect an acknowledgement within seven days. We will investigate,
coordinate a fix, and publish appropriate disclosure information after a
solution is available.

## Security Considerations

The runtime executes the loaded Node-RED flow with the permissions of the host
process. Run untrusted flows only in an isolated environment and use suitable
OS-level restrictions. Do not expose credentials, private flow definitions, or
runtime diagnostics through command output.
