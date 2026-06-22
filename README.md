# OKF Vault

[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22.13-brightgreen)](package.json)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

A pluggable [Model Context Protocol (MCP)](https://modelcontextprotocol.io)
server and headless CLI for the **Open Knowledge Format (OKF)**. Knowledge is
stored in **PostgreSQL** for fast, ranked retrieval, but every read still
round-trips as OKF markdown — so the wire format stays human- and
agent-friendly while the storage is optimized.

## Features

- **REST API** — Full CRUD for bundles and concepts, OpenAPI docs at `/docs`
- **MCP server** — Agent-optimized tools, resource templates (`okf://{bundle}/{path+}`), prompts, stdio or Streamable HTTP transport
- **Full-text search** — Postgres `tsvector` + `pg_trgm` with typo-tolerant fuzzy matching
- **Scope-based organization** — Global, named, and project scopes
- **Live directory synthesis** — `index.md` (§6) and `log.md` (§7) synthesized on read
- **Graph traversal** — `{concept}.links` and `{concept}.backlinks` extract OKF references
- **Rate limiting** — Sliding-window (configurable RPS), per-IP
- **Correlation IDs** — `x-request-id` tracing across all requests
- **Auth** — Bearer token via `API_KEY` config
- **CORS** — Configurable origin allowlist or `*`

## How to Use

### Docker Compose (recommended)

```bash
git clone https://github.com/alexandre-leites/okf-vault && cd okf-vault
cp .env.example .env
docker compose up -d            # Postgres + vault server
# Server is running at http://localhost:3000
```

### Dockerfile only

```bash
docker build -t okf-vault server/
docker run -d \
  -e DATABASE_URL=postgres://okfvault:okfvault@host:5432/okf_vault \
  -p 3000:3000 \
  okf-vault
```

### Manual build

```bash
# Requirements: Node.js >= 22.13, PostgreSQL >= 14
npm install
cp .env.example .env            # or cp server/okfvault.example.yaml okfvault.yaml
npm run build
node dist/cli.js migrate        # apply database migrations
node dist/cli.js serve          # REST API + MCP
```

## How to Connect Using MCP

The server exposes MCP via two transports:

| Transport           | URL/Mechanism            | When to use                   |
| ------------------- | ------------------------ | ----------------------------- |
| **Streamable HTTP** | `http://<host>:3000/mcp` | Remote clients, shared setups |
| **stdio**           | spawned as subprocess    | Local, no network needed      |

Start the server:

```bash
okfvault serve --host 0.0.0.0 --port 3000 --migrate
# MCP endpoint:  http://<host>:3000/mcp
```

If `API_KEY` is set, include `Authorization: Bearer <API_KEY>` in HTTP headers
or pass it in the client's environment. Set `MCP_TRANSPORT` to `stdio` or `http`
to restrict to a single transport (default `both`).

See the client's own docs for wiring details:

- [opencode MCP docs](https://opencode.ai)
- [Claude MCP docs](https://docs.anthropic.com/en/docs/build-with-claude/mcp)
- [Cursor MCP docs](https://docs.cursor.com/context/model-context-protocol)

## MCP Tools

| Tool                       | Description                                                          |
| -------------------------- | -------------------------------------------------------------------- |
| `okf_concept_search`       | Search memory; returns lightweight previews (link, title, snippet)   |
| `okf_concept_get`          | Hydrate one concept by `link` or `bundle`+`path` (tracks read count) |
| `okf_concept_upsert`       | Create-or-update a concept (saves a version snapshot on update)      |
| `okf_bundle_index`         | Directory listing of a bundle (progressive disclosure)               |
| `okf_bundle_list`          | List all bundles                                                     |
| `okf_bundle_create`        | Create a bundle                                                      |
| `okf_concept_links`        | Outbound OKF references from a concept's body                        |
| `okf_concept_backlinks`    | Concepts referencing a given concept                                 |
| `okf_concept_history`      | List a concept's version snapshots                                   |
| `okf_concept_read_version` | Read a specific historical version                                   |
| `okf_bundle_delete`        | _Destructive — soft-delete a bundle and its concepts_                |
| `okf_concept_delete`       | _Destructive — soft-delete a concept_                                |

Bundle naming: use the reserved **`global`** bundle (always present, case-insensitive)
for cross-project knowledge (preferences, standards); use the git repository or
project name for project-specific knowledge. Bundle slugs, concept paths, and
`okf://` URIs are case-insensitive and normalized to lowercase.

### MCP Resources

| Pattern                  | Description                  |
| ------------------------ | ---------------------------- |
| `okf://{bundle}/{path+}` | Concept document as markdown |

### MCP Prompts

| Prompt           | Description                               |
| ---------------- | ----------------------------------------- |
| `create_concept` | Guides concept creation with correct args |

## REST API

| Method   | Path                                        | Description                          |
| -------- | ------------------------------------------- | ------------------------------------ |
| `GET`    | `/health`                                   | Health check                         |
| `POST`   | `/okf/bundles`                              | Create a bundle                      |
| `GET`    | `/okf/bundles`                              | List bundles                         |
| `DELETE` | `/okf/bundles/{bundle}`                     | Soft-delete a bundle (cascades)      |
| `GET`    | `/okf/bundles/{bundle}`                     | Directory listing (markdown)         |
| `GET`    | `/okf/bundles/{bundle}/index.md`            | Directory listing (§6)               |
| `GET`    | `/okf/bundles/{bundle}/log.md`              | Update history (§7)                  |
| `GET`    | `/okf/bundles/{bundle}/{concept}.md`        | Read a concept                       |
| `POST`   | `/okf/bundles/{bundle}/{concept}.md`        | Create a concept                     |
| `PUT`    | `/okf/bundles/{bundle}/{concept}.md`        | Update a concept                     |
| `DELETE` | `/okf/bundles/{bundle}/{concept}.md`        | Soft-delete a concept                |
| `GET`    | `/okf/bundles/{bundle}/{concept}.links`     | Links from this concept              |
| `GET`    | `/okf/bundles/{bundle}/{concept}.backlinks` | Links to this concept                |
| `GET`    | `/okf/search`                               | Ranked full-text + structured search |

Interactive docs at `/docs`; OpenAPI spec at `/openapi.json`.

## CLI

```bash
okfvault migrate                                            # apply migrations
okfvault bundle create acme-sales --title "Acme Sales"
okfvault bundle list
okfvault bundle index acme-sales --markdown                 # progressive disclosure
okfvault concept create acme-sales tables/orders --type "BigQuery Table" --title Orders
okfvault concept read acme-sales tables/orders
okfvault search --bundle acme-sales --type Playbook "revenue"
okfvault serve --migrate                                    # migrate then serve
```

## Configuration

Resolved with precedence **CLI flags > `OKFVAULT_*` environment variables >
config file > defaults**. Config file: `./okfvault.yaml`,
`~/.config/okfvault/config.yaml`, or `$OKFVAULT_CONFIG` (YAML, supports comments).

All config keys require the `OKFVAULT_*` prefix to avoid collisions with
CI/Docker/orchestrator environment variables.

| Config key               | Environment variable              | CLI argument              | Type / Example                            | Default                                                 |
| ------------------------ | --------------------------------- | ------------------------- | ----------------------------------------- | ------------------------------------------------------- |
| `DATABASE_URL`           | `OKFVAULT_DATABASE_URL`           | `--database-url`          | `postgres://user:pass@host:5432/db`       | `postgres://okfvault:okfvault@localhost:5432/okf_vault` |
| `DATABASE_TEST_URL`      | `OKFVAULT_DATABASE_TEST_URL`      | (test-only)               | `postgres://user:pass@host:5432/okf_test` | (empty — integration tests skip)                        |
| `HOST`                   | `OKFVAULT_HOST`                   | `--host`                  | `0.0.0.0`                                 | `0.0.0.0`                                               |
| `PORT`                   | `OKFVAULT_PORT`                   | `--port`                  | `3000`                                    | `3000`                                                  |
| `LOG_LEVEL`              | `OKFVAULT_LOG_LEVEL`              | `--log-level`             | `info`, `debug`, `warn`, `error`, `trace` | `info`                                                  |
| `LOG_PRETTY`             | `OKFVAULT_LOG_PRETTY`             | `--log-pretty`            | `true`, `false`, `1`, `0`                 | `false`                                                 |
| `CORS_ORIGINS`           | `OKFVAULT_CORS_ORIGINS`           | `--cors-origins`          | `*` or `http://a.com,http://b.com`        | (empty — disabled)                                      |
| `API_KEY`                | `OKFVAULT_API_KEY`                | `--api-key`               | `my-secret-token`                         | (empty — auth disabled)                                 |
| `MAX_BODY_SIZE`          | `OKFVAULT_MAX_BODY_SIZE`          | `--max-body-size`         | `1048576`                                 | `1048576`                                               |
| `RATE_LIMIT_RPS`         | `OKFVAULT_RATE_LIMIT_RPS`         | `--rate-limit-rps`        | `100`                                     | `100`                                                   |
| `MCP_TRANSPORT`          | `OKFVAULT_MCP_TRANSPORT`          | `--mcp-transport`         | `both`, `stdio`, `http`, `sse`            | `both`                                                  |
| `BUNDLE_STORAGE_ENABLED` | `OKFVAULT_BUNDLE_STORAGE_ENABLED` | `--enable-bundle-storage` | `true`, `false`                           | `false`                                                 |
| `BUNDLE_STORAGE_PATH`    | `OKFVAULT_BUNDLE_STORAGE_PATH`    | `--bundle-storage-path`   | `/data/okf-vault`                         | (empty — disabled)                                      |

## Development

```bash
# All commands run from the project root; npm delegates to server/
npm run dev          # CLI with hot reload (tsx watch)
npm run typecheck    # Type-check with tsc
npm run lint         # Lint with ESLint
npm run db:generate  # Generate a new migration from schema changes
npm test             # Vitest (integration tests skip without
                      # OKFVAULT_DATABASE_TEST_URL)

# You can also run commands directly inside server/
cd server && npm test
```

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full architecture breakdown.

The server source lives in [`server/`](server/).

## Community

- [Code of Conduct](CODE_OF_CONDUCT.md)
- [Contributing Guide](CONTRIBUTING.md)
- [Changelog](CHANGELOG.md)
- [Security Policy](SECURITY.md)

## License

[Apache License 2.0](LICENSE) with [NOTICE](NOTICE).

---

### Non-Affiliation Disclaimer

This project is an independent implementation of the [Open Knowledge Format
(OKF) specification](https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md)
and is not affiliated with, sponsored by, or endorsed by Google LLC. All code
in this repository was written independently from scratch.
