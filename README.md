# OKF Vault

A pluggable [Model Context Protocol (MCP)](https://modelcontextprotocol.io)
server and headless CLI for the **Open Knowledge Format (OKF)**. Knowledge is
stored in **PostgreSQL** for fast, ranked retrieval, but every read still
round-trips as OKF markdown — so the wire format stays human- and
agent-friendly while the storage is optimized.

## Features

- **REST API** — Full CRUD for bundles and concepts, OpenAPI docs at `/docs`
- **MCP server** — 9 tools, resource templates (`okf://{bundle}/{path+}`), prompts, stdio or SSE transport
- **Full-text search** — Postgres `tsvector` + `pg_trgm` with typo-tolerant fuzzy matching
- **Scope-based organization** — Global, named, and project scopes
- **Live directory synthesis** — `index.md` (§6) and `log.md` (§7) synthesized on read
- **Graph traversal** — `{concept}.links` and `{concept}.backlinks` extract OKF references
- **Rate limiting** — Sliding-window (configurable RPS), per-IP
- **Correlation IDs** — `x-request-id` tracing across all requests
- **Auth** — Bearer token via `API_KEY` config
- **CORS** — Configurable origin allowlist or `*`

## Architecture

Controller–Service–Repository over Postgres + Drizzle ORM:

| Layer          | Location                             | Responsibility                                     |
| -------------- | ------------------------------------ | -------------------------------------------------- |
| **Controller** | `src/cli.ts`, `src/mcp/`, `src/api/` | Parse CLI args, MCP tool calls, and HTTP requests. |
| **Service**    | `src/services/`                      | Core OKF logic (CRUD, search, index synthesis).    |
| **Repository** | `src/repository/`                    | Drizzle queries against Postgres.                  |
| **Database**   | `src/db/`                            | Schema, client pool, and migrations.               |
| **Domain**     | `src/domain/`                        | Types, schemas, and error definitions.             |

## Requirements

- Node.js >= 22.13
- PostgreSQL >= 14

## Getting started

```bash
npm install
cp .env.example .env          # or okfvault.example.json -> okfvault.json
docker compose up -d          # Postgres + vault server
npm run build
node dist/cli.js migrate      # apply database migrations
node dist/cli.js serve        # REST API + MCP (stdio)
```

## Configuration

Resolved with precedence **CLI flags > environment variables > config file >
defaults**. Config file: `./okfvault.json`, `~/.config/okfvault/config.json`,
or `$OKFVAULT_CONFIG`.

| Key              | Default                   | Description                        |
| ---------------- | ------------------------- | ---------------------------------- |
| `DATABASE_URL`   | `postgres://okfvault:...` | Postgres connection string         |
| `HOST`           | `127.0.0.1`               | HTTP listen address                |
| `PORT`           | `3000`                    | HTTP listen port                   |
| `LOG_LEVEL`      | `info`                    | pino log level                     |
| `CORS_ORIGINS`   | (empty)                   | Comma-separated origins or `*`     |
| `API_KEY`        | (empty)                   | Bearer token (disabled when empty) |
| `MAX_BODY_SIZE`  | `1048576`                 | Max request body in bytes          |
| `RATE_LIMIT_RPS` | `100`                     | Max requests per second per IP     |
| `MCP_TRANSPORT`  | `stdio`                   | MCP transport: `stdio` or `sse`    |

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

## MCP tools

| Tool                 | Description                        |
| -------------------- | ---------------------------------- |
| `okf_bundle_list`    | List all bundles                   |
| `okf_bundle_create`  | Create a bundle                    |
| `okf_bundle_delete`  | Soft-delete a bundle               |
| `okf_bundle_index`   | Directory listing (progressive)    |
| `okf_concept_search` | Full-text + structured search      |
| `okf_concept_get`    | Read a concept (tracks read count) |
| `okf_concept_create` | Create a concept                   |
| `okf_concept_update` | Update a concept                   |
| `okf_concept_delete` | Soft-delete a concept              |

### MCP Resources

| Pattern                  | Description                  |
| ------------------------ | ---------------------------- |
| `okf://{bundle}/{path+}` | Concept document as markdown |

### MCP Prompts

| Prompt           | Description                               |
| ---------------- | ----------------------------------------- |
| `create_concept` | Guides concept creation with correct args |

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

## Development

```bash
npm run dev          # CLI with hot reload (tsx watch)
npm run typecheck    # Type-check with tsc
npm run lint         # Lint with ESLint
npm run db:generate  # Generate a new migration from schema changes
npm test             # Vitest (integration tests skip without DATABASE_URL)
```

## Docker

```bash
docker compose up            # Postgres + vault server
docker compose up postgres   # Postgres only (local dev)
```

Build the image separately:

```bash
docker build -t okf-vault .
docker run -e DATABASE_URL=... okf-vault
```

## License

MIT
