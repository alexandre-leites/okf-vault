# OKF Vault — Agent Guide

## Project

A pluggable MCP server + headless CLI + REST API for the Open Knowledge Format (OKF). Knowledge stored in PostgreSQL, served as OKF markdown.

## Key constraints

- `docs/OKF-FORMAT-SPEC.md` must not be modified
- `index.md` files must have no frontmatter (per §6 strict reading)
- `read_count` is post-increment: response includes the current call
- All improvements must maintain 162 passing tests

## Architecture

Controller (CLI/REST/MCP) → Service (CRUD, search, index, scope) → Repository (Drizzle) → PostgreSQL

## Development commands

| Command             | Description            |
| ------------------- | ---------------------- |
| `npm test`          | Run all tests (Vitest) |
| `npm run dev`       | Hot-reload CLI         |
| `npm run typecheck` | `tsc --noEmit`         |
| `npm run lint`      | ESLint                 |
| `npm run build`     | tsup build             |
| `npm run start`     | `node dist/cli.js`     |

## Test files

| File                                  | Type        | Coverage                                   |
| ------------------------------------- | ----------- | ------------------------------------------ |
| `src/config.test.ts`                  | Unit        | Config loading                             |
| `src/domain/*.test.ts`                | Unit        | OKF types, scope, concept types            |
| `src/services/*.test.ts`              | Unit        | Concept path parsing, mapper, document     |
| `src/api/middleware.test.ts`          | Unit        | Rate limiter, body limit, correlation ID   |
| `src/api/server.test.ts`              | Integration | REST API 25+ routes                        |
| `src/mcp/server.test.ts`              | Integration | MCP tools, resources, prompts              |
| `src/integration/okf.pg.test.ts`      | Integration | Bundle/concept CRUD, search, edge cases    |
| `src/integration/concurrency.test.ts` | Integration | Parallel writes, races                     |
| `src/integration/security.test.ts`    | Integration | Path traversal, SQL injection, auth bypass |

## Key files

- `src/api/server.ts` — REST API routes + middleware (rate limit, body size, CORS, auth, correlation ID)
- `src/api/middleware.ts` — RateLimiter, bodySizeLimit, correlationId
- `src/mcp/server.ts` — MCP tools, resources (`okf://{bundle}/{path+}`), prompts
- `src/services/concept-service.ts` — Concept CRUD
- `src/services/bundle-service.ts` — Bundle tree CRUD
- `src/services/search-service.ts` — Full-text + structured search (tsvector + trigram)
- `src/services/index-service.ts` — index.md + log.md synthesis
- `src/repository/concept-repository.ts` — Drizzle queries, FTS, scope filtering
- `src/domain/okf.ts` — OKF types, frontmatter schema, reserved names
- `src/config.ts` — Config schema (env/file/CLI), CORS parsing
- `docker-compose.yml` — Postgres + vault services
- `Dockerfile` — Multi-stage Node 22 Alpine build

## Graph traversal

- `{path}.links` — extracts `okf://` and `./` references from body
- `{path}.backlinks` — finds concepts linking to the given path

## MCP extras

- Resources: `okf://{bundle}/{path+}` template returns concept as markdown
- Prompts: `create_concept` with bundle/path/type args
- Transport: stdio (default) or SSE (`MCP_TRANSPORT=sse`)
