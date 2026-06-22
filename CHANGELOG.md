# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-06-24

### Added

- Initial release
- REST API with full CRUD for bundles and concepts
- MCP server with tools, resources (`okf://{bundle}/{path+}`), and prompts
- Full-text search via Postgres `tsvector` + `pg_trgm`
- Scope-based organization (global, named, and project scopes)
- Live `index.md` and `log.md` synthesis
- Graph traversal via `.links` and `.backlinks`
- Rate limiting, correlation IDs, Bearer auth, CORS
- Docker multi-stage build with Compose setup
- Comprehensive test suite (unit + integration + concurrency + security)
