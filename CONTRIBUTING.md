# Contributing to OKF Vault

Thank you for your interest in contributing! This document covers the
guidelines for contributing to the project.

## Getting Started

1. Fork the repository.
2. Clone your fork:
   ```bash
   git clone https://github.com/alexandre-leites/okf-vault && cd okf-vault
   ```
3. Install dependencies:
   ```bash
   npm install
   ```
4. Create a branch for your change:
   ```bash
   git checkout -b feat/my-feature
   ```

## Development

See the [Architecture doc](docs/ARCHITECTURE.md) for the full architecture breakdown.

```bash
npm run dev          # CLI with hot reload
npm run typecheck    # Type-check with tsc
npm run lint         # Lint with ESLint
npm test             # Run tests (Vitest)
```

Integration tests require a running PostgreSQL instance. Set `DATABASE_URL`
in your environment or `.env` file. Tests auto-skip when no database is
available.

## Pull Request Process

1. Run `npm run typecheck` and `npm run lint` — both must pass.
2. Run `npm test` — all tests must pass.
3. Keep changes focused. A PR should do one thing and do it well.
4. Write a clear commit message describing what and why, not how.
5. Open a PR against the `main` branch.

## Code Style

- This project uses **ESLint** (flat config with type-aware rules) and
  **Prettier** for formatting.
- TypeScript with strict mode enabled. No `any` unless absolutely necessary.
- Follow the existing patterns — the codebase is well-structured; match the
  conventions you see.
- Every public API must have a JSDoc comment.
- Do not add code comments that explain what the code does — the code
  should be self-documenting. Use comments to explain _why_.

## Licensing

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](LICENSE). You must include the required attribution
notices as specified in the [NOTICE](NOTICE) file.
