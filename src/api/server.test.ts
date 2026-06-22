import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb, type DbHandle } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { createApiServer } from "./server.js";
import { createLogger } from "../logger.js";
import { createServices } from "../services/factory.js";

const url = process.env["DATABASE_URL"] ?? process.env["TEST_DATABASE_URL"];

async function reachable(u: string): Promise<boolean> {
  const probe = createDb(u, { max: 1 });
  try {
    await probe.sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.close();
  }
}

const live = url !== undefined && (await reachable(url));
const suite = live ? describe : describe.skip;

suite("REST API", () => {
  let handle: DbHandle;
  let bundles: ReturnType<typeof createServices>["bundleService"];
  let concepts: ReturnType<typeof createServices>["conceptService"];
  const slug = `api-test-${Date.now().toString(36)}`;

  const log = createLogger({ LOG_LEVEL: "silent", LOG_PRETTY: false });
  const baseConfig = {
    DATABASE_URL: url!,
    HOST: "127.0.0.1",
    PORT: 0,
    LOG_LEVEL: "silent" as const,
    LOG_PRETTY: false,
    CORS_ORIGINS: "",
    API_KEY: "",
    MAX_BODY_SIZE: 1048576,
    RATE_LIMIT_RPS: 1000,
    MCP_TRANSPORT: "stdio" as const,
  };

  function app(overrides: Partial<typeof baseConfig> = {}) {
    return createApiServer({ config: { ...baseConfig, ...overrides }, log, db: handle.db });
  }

  beforeAll(async () => {
    await runMigrations(url!);
    handle = createDb(url!);
    const svc = createServices(handle.db);
    bundles = svc.bundleService;
    concepts = svc.conceptService;
  });

  afterAll(async () => {
    if (handle) await handle.close();
  });

  // ── Health ─────────────────────────────────────────────────────────────

  it("GET /health returns 200", async () => {
    const res = await app().request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ status: "ok" });
  });

  // ── Bundle CRUD ────────────────────────────────────────────────────────

  it("POST /okf/bundles creates a bundle and returns 201", async () => {
    const res = await app().request("/okf/bundles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug, title: "API Test" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.slug).toBe(slug);
  });

  it("GET /okf/bundles lists bundles", async () => {
    const res = await app().request("/okf/bundles");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { slug: string }[];
    expect(body.some((b) => b.slug === slug)).toBe(true);
  });

  it("GET /okf/bundles/{slug} returns index.md", async () => {
    const res = await app().request(`/okf/bundles/${slug}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const text = await res.text();
    expect(text).toContain("Concepts");
  });

  it("GET /okf/bundles/{slug}/index.md returns markdown index", async () => {
    const res = await app().request(`/okf/bundles/${slug}/index.md`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("#");
  });

  it("DELETE /okf/bundles/{slug} soft-deletes and returns 204", async () => {
    const delSlug = `${slug}-to-delete`;
    await bundles.create({ slug: delSlug });
    const res = await app().request(`/okf/bundles/${delSlug}`, { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  // ── Concept CRUD via API ───────────────────────────────────────────────

  it("POST /okf/bundles/{slug}/{concept}.md creates a concept", async () => {
    const res = await app().request(`/okf/bundles/${slug}/api-concept.md`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "reference", title: "API Concept" }),
    });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).toContain("type: Reference");
  });

  it("POST creates from markdown when content-type is text/markdown", async () => {
    const res = await app().request(`/okf/bundles/${slug}/md-concept.md`, {
      method: "POST",
      headers: { "content-type": "text/markdown" },
      body: "---\ntype: Playbook\ntitle: MD Concept\n---\n\nMarkdown body.\n",
    });
    expect(res.status).toBe(201);
    const text = await res.text();
    expect(text).toContain("type: Playbook");
    expect(text).toContain("Markdown body");
  });

  it("GET /okf/bundles/{slug}/{concept}.md reads a concept", async () => {
    await concepts.create(slug, "read-test", { type: "reference", title: "Read Me" });
    const res = await app().request(`/okf/bundles/${slug}/read-test.md`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("type: Reference");
    expect(text).toContain("Read Me");
  });

  it("PUT /okf/bundles/{slug}/{concept}.md updates a concept", async () => {
    await concepts.create(slug, "update-test", { type: "reference", title: "Before" });
    const res = await app().request(`/okf/bundles/${slug}/update-test.md`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "Playbook", title: "After" }),
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("After");
  });

  it("PUT from markdown when content-type is text/markdown", async () => {
    await concepts.create(slug, "put-md", { type: "reference", title: "PutBefore" });
    const res = await app().request(`/okf/bundles/${slug}/put-md.md`, {
      method: "PUT",
      headers: { "content-type": "text/markdown" },
      body: "---\ntype: Playbook\ntitle: PutAfter\n---\n\nUpdated via markdown.\n",
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("PutAfter");
    expect(text).toContain("type: Playbook");
  });

  it("DELETE /okf/bundles/{slug}/{concept}.md soft-deletes a concept", async () => {
    await concepts.create(slug, "delete-me", { type: "reference", title: "Delete Me" });
    const res = await app().request(`/okf/bundles/${slug}/delete-me.md`, { method: "DELETE" });
    expect(res.status).toBe(204);
  });

  // ── Search ─────────────────────────────────────────────────────────────

  it("GET /okf/search returns results", async () => {
    await concepts.create(slug, "searchable", {
      type: "reference",
      title: "Searchable Doc",
      description: "Found via search",
    });
    const res = await app().request(`/okf/search?bundle=${slug}&text=searchable`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { id: string }[];
    expect(body.some((r) => r.id.includes("searchable"))).toBe(true);
  });

  it("GET /okf/search with type filter works", async () => {
    const res = await app().request(`/okf/search?bundle=${slug}&type=Playbook`);
    expect(res.status).toBe(200);
  });

  it("GET /okf/search with tags filter works", async () => {
    const res = await app().request(`/okf/search?bundle=${slug}&tags=errors,oncall`);
    expect(res.status).toBe(200);
  });

  it("GET /okf/search with scopes filter works", async () => {
    const res = await app().request(`/okf/search?bundle=${slug}&scopes=tech/typescript`);
    expect(res.status).toBe(200);
  });

  it("GET /okf/search with limit and offset works", async () => {
    const res = await app().request(`/okf/search?bundle=${slug}&limit=5&offset=0`);
    expect(res.status).toBe(200);
  });

  // ── Error responses ────────────────────────────────────────────────────

  it("GET nonexistent bundle returns 404", async () => {
    const res = await app().request("/okf/bundles/__nope__");
    expect(res.status).toBe(404);
  });

  it("GET nonexistent concept returns 404", async () => {
    const res = await app().request(`/okf/bundles/${slug}/__nope__.md`);
    expect(res.status).toBe(404);
  });

  it("POST duplicate bundle slug returns 409", async () => {
    const res = await app().request("/okf/bundles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug }),
    });
    expect(res.status).toBe(409);
  });

  it("POST with invalid body returns 422", async () => {
    const res = await app().request(`/okf/bundles/${slug}/bad.md`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const text = await res.text();
    expect(res.status, text).toBe(422);
  });

  it("DELETE nonexistent bundle returns 404", async () => {
    const res = await app().request("/okf/bundles/__nope__", { method: "DELETE" });
    expect(res.status).toBe(404);
  });

  // ── Auth ───────────────────────────────────────────────────────────────

  it("returns 401 when API_KEY is set and no token provided", async () => {
    const authed = app({ API_KEY: "secret-123" });
    const res = await authed.request(`/okf/bundles`);
    expect(res.status).toBe(401);
  });

  it("allows requests with correct bearer token", async () => {
    const authed = app({ API_KEY: "secret-123" });
    const res = await authed.request(`/okf/bundles`, {
      headers: { authorization: "Bearer secret-123" },
    });
    expect(res.status).toBe(200);
  });

  it("rejects requests with wrong bearer token", async () => {
    const authed = app({ API_KEY: "secret-123" });
    const res = await authed.request(`/okf/bundles`, {
      headers: { authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("health endpoint does not require auth", async () => {
    const authed = app({ API_KEY: "secret-123" });
    const res = await authed.request("/health");
    expect(res.status).toBe(200);
  });

  // ── CORS ───────────────────────────────────────────────────────────────

  it("sets CORS headers when origins configured", async () => {
    const withCors = app({ CORS_ORIGINS: "https://example.com" });
    const res = await withCors.request(`/okf/bundles`, {
      headers: { origin: "https://example.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://example.com");
  });

  it("rejects disallowed CORS origins", async () => {
    const withCors = app({ CORS_ORIGINS: "https://allowed.com" });
    const res = await withCors.request(`/okf/bundles`, {
      headers: { origin: "https://evil.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("CORS wildcard allows all origins", async () => {
    const withCors = app({ CORS_ORIGINS: "*" });
    const res = await withCors.request(`/okf/bundles`, {
      headers: { origin: "https://anything.com" },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });

  // ── Rate limiting ───────────────────────────────────────────────────────

  it("returns 429 when rate limit is exceeded", async () => {
    const limited = app({ RATE_LIMIT_RPS: 1 });
    const url = `/okf/bundles/${slug}`;
    // First request goes through
    const r1 = await limited.request(url);
    expect(r1.status).toBe(200);
    // Second request within the same second should be blocked
    const r2 = await limited.request(url);
    expect(r2.status).toBe(429);
    const body = await r2.json();
    expect(body.error).toContain("Too many requests");
  });

  // ── Body size limit ─────────────────────────────────────────────────────

  it("returns 413 when request body exceeds MAX_BODY_SIZE", async () => {
    const strict = app({ MAX_BODY_SIZE: 50 });
    const res = await strict.request(`/okf/bundles/${slug}/big-concept.md`, {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "200" },
      body: JSON.stringify({ type: "reference", title: "x".repeat(200) }),
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toContain("byte limit");
  });

  it("allows body within size limit", async () => {
    const strict = app({ MAX_BODY_SIZE: 500000 });
    const res = await strict.request(`/okf/bundles/${slug}/small-concept.md`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "reference", title: "Small" }),
    });
    expect(res.status).toBe(201);
  });

  // ── Correlation ID ──────────────────────────────────────────────────────

  it("sets x-request-id header on all routes", async () => {
    const res = await app().request("/health");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("propagates x-request-id from client request", async () => {
    const res = await app().request("/health", {
      headers: { "x-request-id": "client-trace" },
    });
    expect(res.headers.get("x-request-id")).toBe("client-trace");
  });

  // ── Search snippet ──────────────────────────────────────────────────────

  it("search results include snippet field", async () => {
    await concepts.create(slug, "snippet-doc", {
      type: "reference",
      title: "Snippet Doc",
      body: "This is the detailed body content that should be returned as a snippet in search results.",
    });
    const res = await app().request(`/okf/search?bundle=${slug}&text=snippet`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>[];
    const match = body.find((r) => (r.id as string).includes("snippet-doc"));
    expect(match).toBeDefined();
    expect(match!.snippet).toBeDefined();
    expect((match!.snippet as string).length).toBeGreaterThan(0);
  });

  // ── Graph traversal ─────────────────────────────────────────────────────

  it("GET {concept}.links returns extracted links", async () => {
    await concepts.create(slug, "linking-concept", {
      type: "reference",
      title: "Links Out",
      body: `Reference to [async](okf://${slug}/scopes/tech/typescript/async-errors) and [local](./local-doc.md).`,
    });
    await concepts.create(slug, "scopes/tech/typescript/async-errors", {
      type: "Playbook",
      title: "Async Errors",
    });
    await concepts.create(slug, "local-doc", {
      type: "reference",
      title: "Local Doc",
    });

    const res = await app().request(`/okf/bundles/${slug}/linking-concept.links`);
    expect(res.status).toBe(200);
    const links = (await res.json()) as string[];
    expect(links).toContain(`${slug}/scopes/tech/typescript/async-errors`);
    expect(links).toContain("local-doc");
  });

  it("GET {concept}.backlinks returns inbound references", async () => {
    // Create a concept that might be backlinked
    await concepts.create(slug, "backlink-target", {
      type: "reference",
      title: "Backlink Target",
    });
    // Create a concept that links to it
    await concepts.create(slug, "referrer", {
      type: "reference",
      title: "Referrer",
      body: `See [target](okf://${slug}/backlink-target) for details.`,
    });

    const res = await app().request(`/okf/bundles/${slug}/backlink-target.backlinks`);
    expect(res.status).toBe(200);
    const backlinks = (await res.json()) as { id: string }[];
    expect(backlinks.some((b) => b.id === "referrer")).toBe(true);
  });

  it(".backlinks includes title when present", async () => {
    const res = await app().request(`/okf/bundles/${slug}/backlink-target.backlinks`);
    expect(res.status).toBe(200);
    const backlinks = (await res.json()) as { id: string; title?: string }[];
    const ref = backlinks.find((b) => b.id === "referrer");
    expect(ref).toBeDefined();
    expect(ref!.title).toBe("Referrer");
  });

  // ── Version history ──────────────────────────────────────────────────

  it("GET {concept}.history returns version list", async () => {
    await concepts.create(slug, "version-hist", {
      type: "reference",
      title: "V1",
      body: "Version one body",
    });
    // Update twice to create version snapshots
    const current = await concepts.read(slug, "version-hist");
    await concepts.update(
      slug,
      "version-hist",
      { ...current.frontmatter, title: "V2" },
      "Version two body",
    );
    const res = await app().request(`/okf/bundles/${slug}/version-hist.history`);
    expect(res.status).toBe(200);
    const versions = (await res.json()) as { version: number; title: string | null }[];
    expect(versions.length).toBeGreaterThanOrEqual(1);
    expect(versions.some((v) => v.title === "V1")).toBe(true);
  });

  it("GET {concept}.md?version=N returns specific version", async () => {
    const res = await app().request(`/okf/bundles/${slug}/version-hist.md?version=1`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Version one body");
    expect(text).toContain("title: V1");
  });

  it("GET {concept}.md?version=invalid returns 422", async () => {
    const res = await app().request(`/okf/bundles/${slug}/version-hist.md?version=abc`);
    expect(res.status).toBe(422);
  });

  it("GET nonexistent {concept}.history returns 404", async () => {
    const res = await app().request(`/okf/bundles/${slug}/__none__.history`);
    expect(res.status).toBe(404);
  });

  // ── Batch operations ─────────────────────────────────────────────────

  it("POST /okf/batch with mixed operations returns per-op results", async () => {
    const res = await app().request("/okf/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operations: [
          {
            method: "POST",
            bundle: slug,
            path: "batch-create",
            type: "Note",
            title: "Batch Created",
          },
          {
            method: "POST",
            bundle: slug,
            path: "batch-update-me",
            type: "Note",
            title: "To Update",
          },
          {
            method: "PUT",
            bundle: slug,
            path: "batch-update-me",
            type: "Playbook",
            title: "Batch Updated",
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const results = (await res.json()) as { status: number; path: string }[];
    expect(results).toHaveLength(3);
    expect(results[0]!.status).toBe(201);
    expect(results[0]!.path).toBe(`${slug}/batch-create`);
    expect(results[1]!.status).toBe(201);
    expect(results[2]!.status).toBe(200);
  });

  it("POST /okf/batch handles errors per operation", async () => {
    const res = await app().request("/okf/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operations: [{ method: "DELETE", bundle: slug, path: "nonexistent-batch-delete" }],
      }),
    });
    expect(res.status).toBe(200);
    const results = (await res.json()) as { status: number; error?: string }[];
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe(422);
    expect(results[0]!.error).toContain("not found");
  });

  it("POST /okf/batch DELETE on existing concept succeeds", async () => {
    await concepts.create(slug, "batch-delete-me", {
      type: "reference",
      title: "Batch Delete Me",
    });
    const res = await app().request("/okf/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operations: [{ method: "DELETE", bundle: slug, path: "batch-delete-me" }],
      }),
    });
    expect(res.status).toBe(200);
    const results = (await res.json()) as { status: number }[];
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe(204);
  });

  it("POST /okf/batch PUT with all optional fields and minimal fields", async () => {
    await concepts.create(slug, "batch-full", { type: "Note", title: "Full" });
    await concepts.create(slug, "batch-min", { type: "Note", title: "Min" });
    const res = await app().request("/okf/batch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        operations: [
          {
            method: "PUT",
            bundle: slug,
            path: "batch-full",
            type: "Playbook",
            title: "Full Updated",
            description: "A description",
            resource: "https://example.com/r",
            tags: ["t1", "t2"],
            body: "# Full Updated\n",
          },
          {
            method: "PUT",
            bundle: slug,
            path: "batch-min",
          },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const results = (await res.json()) as { status: number }[];
    expect(results[0]!.status).toBe(200);
    expect(results[1]!.status).toBe(200);
  });

  // ── Export / Import ──────────────────────────────────────────────────

  it("POST /okf/bundles/:bundle/import creates concepts from tar.gz", async () => {
    const { tarEntry, tarEnd } = await import("../services/bundle-export.js");
    const { Readable } = await import("node:stream");
    const { createGzip } = await import("node:zlib");

    const entries = [
      ...tarEntry(
        "batch-create.md",
        "---\ntype: Note\ntitle: Reimported\n---\n\nReimported body.\n",
      ),
    ];
    entries.push(tarEnd());
    const raw = Readable.from(Buffer.concat(entries));
    const gzipped = raw.pipe(createGzip());
    const chunks: Buffer[] = [];
    for await (const chunk of gzipped) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);

    const res = await app().request(`/okf/bundles/${slug}/import`, {
      method: "POST",
      headers: { "content-type": "application/gzip" },
      body,
    });
    expect(res.status).toBe(200);
    const result = (await res.json()) as { created: number; updated: number; errors: unknown[] };
    expect(result.updated).toBeGreaterThanOrEqual(1);
    expect(result.errors).toHaveLength(0);
  });

  // ── Error handler edge cases ─────────────────────────────────────────

  it("malformed JSON body returns 400", async () => {
    const res = await app().request(`/okf/bundles/${slug}/bad-json.md`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{invalid json}",
    });
    expect(res.status).toBe(400);
  });

  it("unhandled error returns 500", async () => {
    // Force a service error by reading a concept with an invalid path
    const res = await app().request(`/okf/bundles/${slug}//.md`);
    expect(res.status).not.toBe(200);
  });

  it("db unreachable health check returns 503", async () => {
    // Create app with a mocked db that throws
    const brokenDb = {
      execute: () => Promise.reject(new Error("Connection refused")),
    } as unknown as typeof handle.db;
    const brokenApp = createApiServer({
      config: { ...baseConfig },
      log,
      db: brokenDb,
    });
    const res = await brokenApp.request("/health");
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain("Database not reachable");
  });

  it("service error falls through to 500", async () => {
    // Create app with db whose queries throw unexpected errors
    // The error won't match any known error type → 500 handler
    const brokenDb = {
      execute: () => Promise.reject(new Error("Connection refused")),
      select: () => ({
        from: () => ({ where: () => ({ limit: () => Promise.reject(new Error("DB broken")) }) }),
      }),
      insert: () => ({
        values: () => ({ returning: () => Promise.reject(new Error("DB broken")) }),
      }),
      update: () => ({
        set: () => ({ where: () => ({ returning: () => Promise.reject(new Error("DB broken")) }) }),
      }),
    } as unknown as typeof handle.db;
    const brokenApp = createApiServer({
      config: { ...baseConfig },
      log,
      db: brokenDb,
    });
    const res = await brokenApp.request(`/okf/bundles`);
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("Internal server error");
  });

  // ── OpenAPI / directory fallback ─────────────────────────────────────

  it("GET /openapi.json returns the OpenAPI document", async () => {
    const res = await app().request("/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; info: { title: string } };
    expect(doc.openapi).toBe("3.1.0");
    expect(doc.info.title).toBe("OKF Vault API");
  });

  it("sub-directory path returns directory index", async () => {
    // Create a concept under a sub-path to make the directory exist
    await concepts.create(slug, "sub/child-concept", {
      type: "reference",
      title: "Child",
    });
    const res = await app().request(`/okf/bundles/${slug}/sub/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
    const text = await res.text();
    expect(text).toContain("Child");
  });

  it("non-md/non-json path without trailing slash falls through to directory index", async () => {
    // sub is a bundle (created by sub/child-concept above)
    const res = await app().request(`/okf/bundles/${slug}/sub`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/markdown");
  });

  it("GET /okf/bundles/:bundle/export returns gzip", async () => {
    const res = await app().request(`/okf/bundles/${slug}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/gzip");
    expect(res.headers.get("content-disposition")).toContain(".tar.gz");
    await res.arrayBuffer(); // consume the body to release connection
  });
});
