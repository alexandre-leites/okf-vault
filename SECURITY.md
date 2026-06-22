# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in OKF Vault, please report it
privately by opening a GitHub Security Advisory at:

https://github.com/alexandre-leites/okf-vault/security/advisories/new

Do **not** report security vulnerabilities via public GitHub issues.

You should receive a response within 48 hours. If you do not, please follow
up to ensure the message was received.

## Scope

The following items are in scope:

- The `okf-vault` npm package and its source code
- The Docker image
- The build pipeline (CI/CD)

The following are **out of scope**:

- The underlying PostgreSQL database (please report to PostgreSQL directly)
- Third-party dependencies (report to the respective maintainers)
- The OKF specification itself (report to the OKF maintainers)

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |

## Security Best Practices

- Always set `API_KEY` in production deployments.
- Use environment-specific `CORS_ORIGINS` to restrict cross-origin access.
- Run behind a reverse proxy (e.g., nginx) for TLS termination.
- Keep PostgreSQL behind a firewall — do not expose it publicly.
- Regularly update dependencies with `npm audit fix`.
