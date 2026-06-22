# OKF Vault — Technical Architecture

## Overview

OKF Vault is an application that stores, serves, and searches Open Knowledge Format (OKF) markdown documents in PostgreSQL.
Three controllers share one service layer:

```
CLI (Commander) ─┐
REST API (Hono) ─┼──→ Service Layer ──→ Repository (Drizzle) ──→ PostgreSQL
MCP (SDK)  ──────┘
```

## Layer breakdown

### Controller layer (`src/controllers/`)

Three frontends backed by a shared service layer:

- **CLI** (`src/cli.ts`) — Commander-based, 13 commands (bundle CRUD, concept CRUD, search, migrate, serve)
- **REST API** (`src/api/server.ts`) — Hono + OpenAPIHono with Swagger UI at `/docs`, OpenAPI spec at `/openapi.json`
- **MCP server** (`src/mcp/server.ts`) — MCP SDK with 9 tools, 1 resource template (`okf://{bundle}/{path+}`), 1 prompt (`create_concept`)

### API middleware stack (`src/api/middleware.ts`)

Applied in order on every `/okf/*` request:

1. **correlationId** — Set or propagate `x-request-id` header (request tracing)
2. **httpLogger** — Log method, path, status via pino
3. **CORS** — Configurable origin allowlist or `*`
4. **RateLimiter** — In-memory sliding-window, keyed by `x-forwarded-for` or `x-real-ip` (default 100 RPS)
5. **bodySizeLimit** — Reject requests where `Content-Length` exceeds `MAX_BODY_SIZE` (default 1 MB)
6. **bearerAuth** — Optional bearer token, disabled when `API_KEY` is empty

### Service layer (`src/services/`)

| Service          | File                 | Responsibility                                                    |
| ---------------- | -------------------- | ----------------------------------------------------------------- |
| `BundleService`  | `bundle-service.ts`  | Bundle tree CRUD, slug resolution, subtree traversals             |
| `ConceptService` | `concept-service.ts` | Concept CRUD, frontmatter validation, path normalization          |
| `SearchService`  | `search-service.ts`  | Full-text + structured search, bundle scoping, snippet extraction |
| `IndexService`   | `index-service.ts`   | `index.md` (§6) and `log.md` (§7) live synthesis                  |

### Repository layer (`src/repository/`)

| Repository          | File                    | Key queries                                                       |
| ------------------- | ----------------------- | ----------------------------------------------------------------- |
| `BundleRepository`  | `bundle-repository.ts`  | Root/child bundle CRUD, subtree listing                           |
| `ConceptRepository` | `concept-repository.ts` | Concept CRUD, soft-delete, FTS, scope filtering, trigram fallback |

### Domain layer (`src/domain/`)

- **`okf.ts`** — OKF types (`Frontmatter`, `Concept`, `Scope`), Zod schemas for frontmatter validation, reserved filename checks
- **`concept-types.ts`** — Normalized concept types (e.g. `"BigQuery Table"` → `"bigquery-table"`)
- **`scope-resolver.ts`** — Resolve scope kind/key from directory path (`scopes/tech/ts` → named scope `tech/ts`)
- **`errors.ts`** — `OkfValidationError`, `ConflictError`, `ConceptNotFoundError`, `BundleNotFoundError`, `ReservedConceptIdError`

## Database schema (`src/db/schema.ts`)

### `bundles` table

A tree of knowledge bundles (subdirectories are child bundles). Soft-deleted via `deleted_at`.

| Column                     | Type         | Notes                                       |
| -------------------------- | ------------ | ------------------------------------------- |
| `id`                       | UUID         | PK, default `gen_random_uuid()`             |
| `parent_id`                | UUID?        | FK to `bundles.id`, NULL for roots          |
| `slug`                     | TEXT         | Unique within parent (partial unique index) |
| `title`, `description`     | TEXT?        | Optional metadata                           |
| `okf_version`              | TEXT         | Default `"0.1"`                             |
| `created_at`, `updated_at` | TIMESTAMPTZ  |                                             |
| `deleted_at`               | TIMESTAMPTZ? | Soft-delete                                 |

Partial unique indexes: one for roots (`parent_id IS NULL`), one for children (composite `parent_id, slug`).

### `concepts` table

One OKF document per row. Structured columns for filtering; arbitrary producer keys stored in `frontmatter` JSONB.

| Column                     | Type         | Notes                                     |
| -------------------------- | ------------ | ----------------------------------------- |
| `id`                       | UUID         | PK                                        |
| `bundle_id`                | UUID         | FK to `bundles.id` (CASCADE)              |
| `slug`                     | TEXT         | Filename without `.md`                    |
| `type`                     | TEXT         | Concept type (e.g. Playbook, Reference)   |
| `title`, `description`     | TEXT?        |                                           |
| `resource`                 | TEXT?        | External resource URL                     |
| `tags`                     | TEXT[]       | Default `{}`                              |
| `scope_kind`               | TEXT         | `global` / `named` / `project`            |
| `scope_key`                | TEXT?        | Scope key for named/project scopes        |
| `frontmatter`              | JSONB        | Full frontmatter including extension keys |
| `body`                     | TEXT         | Markdown body                             |
| `read_count`               | INTEGER      | Post-increment counter                    |
| `created_at`, `updated_at` | TIMESTAMPTZ  |                                           |
| `deleted_at`               | TIMESTAMPTZ? |                                           |

Indexes: GIN on `tags`, GIN on `to_tsvector(title || ' ' || description || ' ' || body)` for FTS, GIN on `(title || ' ' || description || ' ' || body) gin_trgm_ops` for fuzzy search.

## Search

### Full-text search

Postgres `tsvector` GIN index over `(title, description, body)` with `ts_rank` ordering. Query via `plainto_tsquery('english', text)`. Filterable by:

- `bundlePath` — Restrict to bundle subtree
- `type` — Exact (case-insensitive)
- `tags` — Array superset (`@>`)
- `scopes` / `project` — Scope matching (global always included)
- `limit` / `offset` — Pagination (default 20, max 100)

### Fuzzy / typo-tolerant search

When `text` is provided, the search condition is:

```sql
tsvector @@ plainto_tsquery('english', text)
  OR similarity(concat(title, description, body), text) > 0.15
```

Ranking uses `GREATEST(ts_rank(...), similarity(...))` so trigram matches appear alongside FTS results. The `pg_trgm` extension is enabled via migration `0001_pg_trgm.sql` with a GIN trigram index.

### Search result snippets

Each search result includes a `snippet` field: the first 200 characters of `body` (whitespace-collapsed), omitted when body is empty.

## Graph traversal

The API supports extracting links from and to concepts via two resource-oriented suffixes:

- **`{concept}.links`** — Parses concept body for `[text](okf://bundle/path)` and `[text](./relative-path.md)` references, returns deduplicated list
- **`{concept}.backlinks`** — Scans all concepts in the same bundle for references to the target concept path (via `includes` match on `okf://bundle/path` or bare path in body)

Implemented as inline routes in `src/api/server.ts:extractLinks()` and `findBacklinks()`.

## MCP integration

### Transport

Two transports, configured via `MCP_TRANSPORT` env:

- **`stdio`** (default) — Standard MCP stdio transport, starts automatically in the `serve()` function
- **`sse`** — HTTP SSE transport, exposes `GET /mcp` (SSE stream) and `POST /mcp` (message receiver) on the REST API server

### Resources

A resource template `okf://{bundle}/{path+}` resolves concept paths to OKF markdown via `serializeConcept`. The RFC 6570 URI template captures bundle slug and the remaining path including slashes.

### Prompts

The `create_concept` prompt takes `bundle`, `path`, and `type` arguments and returns a user message guiding the agent to use `okf_concept_create` with correct parameters.

## Configuration (`src/config.ts`)

Configuration is resolved with precedence: **CLI > env > config file > defaults**.

Config file locations (in order): `./okfvault.json`, `~/.config/okfvault/config.json`, `$OKFVAULT_CONFIG`.

The Zod schema (`EnvSchema`) validates all values at startup and fails fast with a clear error message.

## Docker

### `Dockerfile`

Multi-stage build:

1. **Builder** — `node:22-alpine`, installs all deps (`npm ci`), runs `npm run build`
2. **Production** — `node:22-alpine`, installs `tini`, copies `dist/` and `drizzle/`, runs `node dist/cli.js serve`

### `docker-compose.yml`

Two services:

- **postgres** — `postgres:17-alpine` with healthcheck
- **vault** — Built from Dockerfile, depends on healthy postgres, exposes port 3000

## Key design decisions

### Database-backed, not filesystem-backed

PostgreSQL provides transactional integrity, soft-delete, and ranked FTS — things a filesystem cannot. Every read still round-trips as OKF markdown.

### Live synthesis of index.md / log.md

`index.md` (§6) and `log.md` (§7) are never stored — derived live from the bundle tree and concept metadata each time they are requested. Guarantees zero drift.

### Scope-based organization

Concepts resolve to `global`, `named <key>`, or `project <key>` scopes based on directory path. `global` concepts are always included in search regardless of scope filter.

### Soft-delete everywhere

Both bundles and concepts use `deleted_at` columns. Active-row uniqueness enforced by partial unique indexes (`WHERE deleted_at IS NULL`), allowing slug reuse after deletion.

### Post-increment read_count

`read_count` is incremented atomically via `SET read_count = read_count + 1`. The response includes the count _after_ increment (the call that just happened).
