# OKF Vault — Agent Guide

## Project

A pluggable MCP server + headless CLI + REST API for the Open Knowledge Format (OKF). Knowledge stored in PostgreSQL, served as OKF markdown.

## Key constraints

- `docs/OKF-SPEC.md` was removed in favor of the official spec at https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
- `index.md` files must have no frontmatter (per §6 strict reading)
- `read_count` is post-increment: response includes the current call
- All improvements must maintain ALL passing tests

## Architecture

Controller (CLI/REST/MCP) → Service (CRUD, search, index, scope) → Repository (Drizzle) → PostgreSQL

## Development commands

| Command                      | Description                  |
| ---------------------------- | ---------------------------- |
| `npm test`                   | Run all tests (Vitest)       |
| `npm run dev`                | Hot-reload CLI               |
| `npm run typecheck`          | `tsc --noEmit`               |
| `npm run lint`               | ESLint                       |
| `npm run build`              | tsup build                   |
| `npm run start`              | `node server/dist/cli.js`    |
| `cd server && npm run start` | or run from server/ directly |

## Test files

| File                                         | Type        | Coverage                                   |
| -------------------------------------------- | ----------- | ------------------------------------------ |
| `server/src/config.test.ts`                  | Unit        | Config loading                             |
| `server/src/domain/*.test.ts`                | Unit        | OKF types, scope, concept types            |
| `server/src/services/*.test.ts`              | Unit        | Concept path parsing, mapper, document     |
| `server/src/api/middleware.test.ts`          | Unit        | Rate limiter, body limit, correlation ID   |
| `server/src/api/server.test.ts`              | Integration | REST API 25+ routes                        |
| `server/src/mcp/server.test.ts`              | Integration | MCP tools, resources, prompts              |
| `server/src/integration/okf.pg.test.ts`      | Integration | Bundle/concept CRUD, search, edge cases    |
| `server/src/integration/concurrency.test.ts` | Integration | Parallel writes, races                     |
| `server/src/integration/security.test.ts`    | Integration | Path traversal, SQL injection, auth bypass |

## Key files

- `server/src/api/server.ts` — REST API routes + middleware (rate limit, body size, CORS, auth, correlation ID)
- `server/src/api/middleware.ts` — RateLimiter, bodySizeLimit, correlationId
- `server/src/mcp/server.ts` — MCP tools, resources (`okf://{bundle}/{path+}`), prompts
- `server/src/services/concept-service.ts` — Concept CRUD
- `server/src/services/bundle-service.ts` — Bundle tree CRUD
- `server/src/services/search-service.ts` — Full-text + structured search (tsvector + trigram)
- `server/src/services/index-service.ts` — index.md + log.md synthesis
- `server/src/repository/concept-repository.ts` — Drizzle queries, FTS, scope filtering
- `server/src/domain/okf.ts` — OKF types, frontmatter schema, reserved names
- `server/src/config.ts` — Config schema (env/file/CLI), CORS parsing
- `docker-compose.yml` — Postgres + vault services
- `server/Dockerfile` — Multi-stage Node 22 Alpine build

## Graph traversal

- `{path}.links` — extracts `okf://` and `./` references from body
- `{path}.backlinks` — finds concepts linking to the given path

## MCP extras

- Resources: `okf://{bundle}/{path+}` template returns concept as markdown
- Prompts: `create_concept` with bundle/path/type args
- Transport: stdio (default) or SSE (`MCP_TRANSPORT=sse`)
