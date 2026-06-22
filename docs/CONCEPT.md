# OKF Vault — Architecture & Implementation

## Objective

A pluggable Model Context Protocol (MCP) server and headless CLI for the
Open Knowledge Format (OKF). Knowledge is stored in PostgreSQL and served
as OKF markdown on every read, with ranked full-text search, on-the-fly
directory synthesis, and scope-based organization.

## Architecture

Controller–Service–Repository over Postgres + Drizzle ORM:

- **Controllers**: CLI (Commander), REST API (Hono), MCP server
- **Service layer**: Bundle tree resolution, concept CRUD + validation, search,
  index/log synthesis, scope resolution
- **Repository layer**: Drizzle queries with soft-delete, GIN-indexed FTS
- **Database**: PostgreSQL with `bundles` (tree) and `concepts` (frontmatter + body) tables

## Key design decisions

### Database-backed, not filesystem-backed

The early plan called for Git-based file storage. The project evolved to use
PostgreSQL + Drizzle ORM for transactional integrity, soft-delete, and
ranked full-text search on `tsvector` GIN indexes. Every read still
round-trips as OKF markdown.

### Live synthesis of index.md / log.md

`index.md` (directory listing, §6) and `log.md` (update history, §7) are
never stored — they are derived live from the bundle tree each time they are
requested. This guarantees they never drift from reality.

### Scope-based organization

Concepts can belong to global, named, or project scopes, resolved from the
directory path (`scopes/<key>/...`, `projects/<key>/...`, or the root
bundle). Frontmatter `scope` field can further narrow within a scope.

### Full-text search

PostgreSQL `plainto_tsquery` + `ts_rank` over a GIN-indexed `tsvector` of
(title, description, body). Filterable by bundle, type, tags, scope, and
project, with pagination (limit/offset).

## Implementation status

| Feature                      | Status                          |
| ---------------------------- | ------------------------------- |
| Concept CRUD                 | Done                            |
| Bundle CRUD                  | Done                            |
| CLI (Commander)              | Done (13 commands)              |
| REST API (Hono)              | Done (10+ routes, OpenAPI docs) |
| MCP server                   | Done (9 tools, stdio transport) |
| Full-text search             | Done (GIN + ts_rank, paginated) |
| index.md synthesis           | Done (§6)                       |
| log.md synthesis             | Done (§7)                       |
| Scope resolution             | Done                            |
| Soft-delete                  | Done                            |
| Frontmatter validation (Zod) | Done                            |
| OKF conformance              | Done                            |
| SSE transport                | Not yet                         |
| MCP Resources                | Not yet                         |
| Rate limiting                | Not yet                         |
