# OKF Vault

A pluggable [Model Context Protocol (MCP)](https://modelcontextprotocol.io)
server and headless CLI for the **Open Knowledge Format (OKF)**. Knowledge is
stored in **PostgreSQL** for fast, ranked retrieval, but every read still
round-trips as OKF markdown — so the wire format stays human- and
agent-friendly while the storage is optimized.

## Features

- **REST API** — Full CRUD for bundles and concepts, OpenAPI docs at `/docs`
- **MCP server** — Agent-optimized tools, resource templates (`okf://{bundle}/{path+}`), prompts, stdio or SSE transport
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

| Key              | Default                   | Description                                |
| ---------------- | ------------------------- | ------------------------------------------ |
| `DATABASE_URL`   | `postgres://okfvault:...` | Postgres connection string                 |
| `HOST`           | `0.0.0.0`                 | HTTP listen address                        |
| `PORT`           | `3000`                    | HTTP listen port                           |
| `LOG_LEVEL`      | `info`                    | pino log level                             |
| `CORS_ORIGINS`   | (empty)                   | Comma-separated origins or `*`             |
| `API_KEY`        | (empty)                   | Bearer token (disabled when empty)         |
| `MAX_BODY_SIZE`  | `1048576`                 | Max request body in bytes                  |
| `RATE_LIMIT_RPS` | `100`                     | Max requests per second per IP             |
| `MCP_TRANSPORT`  | `both`                    | MCP transport: `both`/`stdio`/`http`/`sse` |

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

### Connecting an MCP client

The server exposes MCP two ways at once:

- **Streamable HTTP** at `/mcp` — **always mounted**, so any client can connect
  by **URL** (multi-client, session-based). Recommended for opencode, Cursor,
  and remote/shared setups.
- **stdio** — the client launches `okfvault serve` as a subprocess and talks
  over stdin/stdout. Connected when `MCP_TRANSPORT` is `both` (default) or
  `stdio`.

`MCP_TRANSPORT` values:

| Value            | Streamable HTTP `/mcp` | stdio |
| ---------------- | ---------------------- | ----- |
| `both` (default) | ✅                     | ✅    |
| `stdio`          | ✅                     | ✅    |
| `http`           | ✅                     | ❌    |
| `sse` (legacy)   | ✅                     | ❌    |

First, start the server and apply migrations once:

```bash
okfvault serve --host 0.0.0.0 --port 3000 --migrate
# MCP endpoint URL:  http://<host>:3000/mcp
```

The endpoint URL is `http://<host>:3000/mcp` (use `https://` behind a TLS proxy
for remote access). If `API_KEY` is set, send `Authorization: Bearer <API_KEY>`.

#### opencode

Connect by URL (`type: "remote"`). Add to `opencode.json` (project root) or
`~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "okf-vault": {
      "type": "remote",
      "url": "http://localhost:3000/mcp",
      "enabled": true
    }
  }
}
```

With auth enabled, add headers:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "okf-vault": {
      "type": "remote",
      "url": "http://localhost:3000/mcp",
      "enabled": true,
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}
```

Prefer opencode to launch the server itself? Use `type: "local"`:

```json
{
  "mcp": {
    "okf-vault": {
      "type": "local",
      "command": ["node", "/absolute/path/to/okf-vault/dist/cli.js", "serve"],
      "enabled": true,
      "environment": { "DATABASE_URL": "postgres://okfvault:okfvault@localhost:5432/okf_vault" }
    }
  }
}
```

#### Claude

**Claude Code (CLI)** — connect by URL (HTTP transport):

```bash
claude mcp add --transport http okf-vault http://localhost:3000/mcp
# with auth:
claude mcp add --transport http okf-vault http://localhost:3000/mcp \
  --header "Authorization: Bearer YOUR_API_KEY"
```

Or have Claude Code spawn it over stdio:

```bash
claude mcp add okf-vault -- node /absolute/path/to/okf-vault/dist/cli.js serve
```

**Claude Desktop** — edit `claude_desktop_config.json`
(macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`)
and restart Claude. URL (HTTP) form:

```json
{
  "mcpServers": {
    "okf-vault": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

stdio (spawned subprocess) form:

```json
{
  "mcpServers": {
    "okf-vault": {
      "command": "node",
      "args": ["/absolute/path/to/okf-vault/dist/cli.js", "serve"],
      "env": { "DATABASE_URL": "postgres://okfvault:okfvault@localhost:5432/okf_vault" }
    }
  }
}
```

#### Cursor

Edit `~/.cursor/mcp.json` (global) or `.cursor/mcp.json` (project), then reload.
Cursor connects by URL:

```json
{
  "mcpServers": {
    "okf-vault": {
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

With auth:

```json
{
  "mcpServers": {
    "okf-vault": {
      "url": "http://localhost:3000/mcp",
      "headers": { "Authorization": "Bearer YOUR_API_KEY" }
    }
  }
}
```

> **stdio note:** when a client spawns the server over stdio, keep `LOG_LEVEL`
> quiet — MCP clients require clean stdout for the JSON-RPC stream.

#### Verify the connection

Once connected the client should list the tools (`okf_concept_search`,
`okf_concept_upsert`, …). An agent then calls `okf_concept_search` to recall
memory and `okf_concept_upsert` to store new facts.

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
