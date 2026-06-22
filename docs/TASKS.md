# OKF Vault — Production & AI-Agent Readiness Analysis

Last updated: June 2026.

---

## 0. Resolved gaps

The following gaps identified in the original audit have been closed:

| Gap                                  | Resolution                                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------------- |
| **No authentication**                | ✅ `API_KEY` bearer middleware wired (`server.ts:223-225`)                            |
| **No concept deletion**              | ✅ Soft-delete via CLI + REST + MCP (`concept delete`, `DELETE /okf/bundles/*`)       |
| **No pagination on search**          | ✅ `limit` (max 100) + `offset` parameters                                            |
| **No list/catalog endpoint**         | ✅ `GET /okf/bundles`, `GET /okf/bundles/{b}`, directory index                        |
| **No full-text index**               | ✅ GIN-indexed `tsvector` + `plainto_tsquery` + `ts_rank`                             |
| **No relevance scoring**             | ✅ `ts_rank DESC` ordering in search results                                          |
| **No index.md generation / serving** | ✅ Live synthesis via `IndexService` (§6)                                             |
| **No log.md auto-generation**        | ✅ Live synthesis via `IndexService` (§7)                                             |
| **No scope / type enumeration**      | ✅ Scope and type filters in search; scope resolution from directory paths            |
| **Only 2 MCP tools**                 | ✅ 9 tools: list, create, delete, index, search, get, create, update, delete concepts |
| **No config file support**           | ✅ `okfvault.json`, `~/.config/okfvault/config.json`, or `$OKFVAULT_CONFIG`           |
| **No `read_count` exposure**         | ✅ `read_count` tracked and returned in frontmatter as `read_count`                   |
| **No autoscoping**                   | ✅ Scope resolution (`scope-resolver.ts`) + `ScopeContext` for active agent session   |

---

## 1. Production Readiness Gaps

### Critical (blocks deployment)

| Gap                                | Details                                                                                                                    |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **No rate limiting / size limits** | No limit on JSON body size or request rate. A large POST body can exhaust memory.                                          |
| **No metrics / health depth**      | `/health` checks database. No Prometheus endpoint, no readiness/liveness distinction for K8s, no dependency health checks. |
| **No Dockerfile**                  | No container image. `docker-compose.yml` only provides Postgres.                                                           |

### Important

| Gap                              | Details                                                                                            |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| **No request tracing**           | No correlation IDs on requests. You cannot correlate a slow search to its log entries.             |
| **No audit trail for mutations** | Log.md is synthesized live from concept timestamps but no webhook, changefeed, or mutation events. |
| **No graceful degradation**      | If the database is unavailable, the server crashes or returns 500 with no recovery.                |
| **No backup/restore**            | Nothing snapshots the bundle. DB corruption = data loss.                                           |

### Nice-to-have

| Gap                               | Details                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| No OpenAPI operationId            | Auto-generated docs work but hard to wire codegen.                 |
| Tests skip error-safety scenarios | No tests for concurrent writes, disk-full, partial write recovery. |

---

## 2. AI Agent Optimization Gaps

### Discovery — agent doesn't know what exists

| Missing                | Impact                                                                                                                   |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **No graph traversal** | No endpoint for "what links to this concept?" or "what does this concept link to?" Agent can't walk the knowledge graph. |

### Search quality — low precision, no relevance

| Missing                                       | Impact                                                                                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **No fuzzy/typo tolerance**                   | A typo of 1 character returns zero results silently.                                                                       |
| **No result snippets**                        | Agent gets back only id/type/title/description — no body excerpt showing _why_ it matched. Must read each candidate fully. |
| **No faceted search**                         | Can't say "give me counts by type" or "by scope".                                                                          |
| **No search over arbitrary frontmatter keys** | Only `type` and `tags` are searchable. Concepts with custom fields (e.g. `owner`, `status`) are invisible to search.       |

### Efficiency — unnecessary round trips

| Missing                                | Impact                                                                                                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No batch read**                      | Need 5 concepts? That's 5 `concept_read` calls. No `POST /concepts/batch`.                                                                                                                |
| **No batch search**                    | Can't search for multiple queries in one round trip.                                                                                                                                      |
| **No `resolveLinks` option**           | When reading a concept, links are raw markdown paths. Agent must separately read every linked concept to know its title/summary. A `?resolveLinks=true` param could inline linked titles. |
| **No summarization / truncation**      | Body is returned in full. For large playbooks, agent wastes tokens on details it doesn't need. No `?maxBody=500` parameter.                                                               |
| **No "what changed since last visit"** | `read_count` is tracked but never exposed as a query filter. No way to say "show me concepts updated since my last access."                                                               |

### MCP-specific gaps

| Missing              | Impact                                                                                                                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **No MCP Resources** | OKF concepts map naturally to `okf://concept/{id}` resources, but none are registered. Agent can't use MCP's resource subscription or templating. |
| **No MCP Prompts**   | No pre-canned prompt templates for common agent workflows.                                                                                        |
| **No SSE transport** | Only stdio. Remote MCP clients (Claude Desktop via network) can't connect.                                                                        |

---

## 3. Prioritized Recommendations

### P0 — ship-blocking for production

1. ✅ ~~Wire API_KEY middleware~~
2. ✅ ~~Add concept DELETE~~
3. ✅ ~~Add pagination to search~~
4. **Add rate limiting / size limits** — Guard against large POST bodies and runaway requests.
5. **Dockerfile** — Ship a production container.

### P0 — ship-blocking for AI agents

6. ✅ ~~Add `list` / `catalog` endpoint~~
7. ✅ ~~Replace substring search with an FTS index~~
8. ✅ ~~Add `scopes` and `types` enumeration~~

### P1 — major efficiency wins

9.  **Batch read** — `POST /concepts/batch` with `{ ids: [...] }`. Cuts 5 round trips to 1.
10. **Resolve links** — `?resolveLinks=true` on `GET /concepts/:id` inlines linked concept titles/descriptions so the agent doesn't chase every link separately.
11. ✅ ~~Add `index.md` auto-generation~~
12. **Result snippets** — Return matching body excerpt in search results.

### P2 — polish

13. MCP Resources (`okf://concept/{id}`) + SSE transport
14. MCP Prompts for common workflows ("find relevant concepts for X")
15. Dockerfile + health check endpoint for K8s readiness/liveness
16. Metrics endpoint (prom-client)
17. Graph traversal endpoint (`GET /concepts/:id/links`, `GET /concepts/:id/backlinks`)
18. Fuzzy / typo-tolerant search
19. Faceted search (counts by type/scope)
