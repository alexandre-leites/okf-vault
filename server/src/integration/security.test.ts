import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb, type DbHandle } from "../db/client.js";
import { createServices, type Services } from "../services/factory.js";
import { createApiServer } from "../api/server.js";
import { createLogger } from "../logger.js";
import { OkfValidationError } from "../domain/errors.js";
import type { Database } from "../db/client.js";

const url = process.env["DATABASE_TEST_URL"];

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

suite("Security", () => {
  let handle: DbHandle;
  let bundles: Services["bundleService"];
  let concepts: Services["conceptService"];
  let db: Database;
  const slug = `sec-${Date.now().toString(36)}`;
  const log = createLogger({ LOG_LEVEL: "silent", LOG_PRETTY: false });

  beforeAll(async () => {
    handle = createDb(url!);
    db = handle.db;
    const svc = createServices(db);
    bundles = svc.bundleService;
    concepts = svc.conceptService;
    await bundles.create({ slug });
  });

  afterAll(async () => {
    if (handle) await handle.close();
  });

  function authedApp() {
    return createApiServer({
      config: {
        DATABASE_URL: url!,
        HOST: "127.0.0.1",
        PORT: 0,
        LOG_LEVEL: "silent",
        LOG_PRETTY: false,
        CORS_ORIGINS: "",
        API_KEY: "test-key-789",
      },
      log,
      db,
    });
  }

  // ── Path traversal ────────────────────────────────────────────────────

  it("rejects ../ in concept path via service", async () => {
    await expect(concepts.create(slug, "../etc/passwd", { type: "Test" })).rejects.toThrow(
      OkfValidationError,
    );
  });

  it("handles absolute path by stripping leading slash (not a security issue — no filesystem involved)", async () => {
    const c = await concepts.create(slug, "/etc/passwd", { type: "Test" });
    expect(c.id).toBe("etc/passwd");
  });

  it("rejects double-dot segments in nested paths", async () => {
    await expect(concepts.create(slug, "good/../../evil", { type: "Test" })).rejects.toThrow(
      OkfValidationError,
    );
  });

  it("allows index as a directory segment (only the leaf concept slug is checked against reserved names)", async () => {
    const c = await concepts.create(slug, "good/index/doc", { type: "Test" });
    expect(c.id).toBe("good/index/doc");
  });

  it("API rejects path traversal (URL normalization removes ../ before reaching handler)", async () => {
    const app = authedApp();
    const res = await app.request(`/okf/bundles/${slug}/../evil.md`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key-789",
      },
      body: JSON.stringify({ type: "Test" }),
    });
    // URL normalization resolves the path to /okf/bundles/evil.md which
    // matches the POST /okf/bundles/:bundle/* route with bundle="evil.md"
    // but fails because the concept path is empty → 422 validation error
    expect(res.status).toBe(422);
  });

  // ── Injection resistance (parameterized queries — should not crash) ────

  it("handles SQL-like strings in type field without crash", async () => {
    await expect(
      concepts.create(slug, "sql-inject-type", {
        type: "1; DROP TABLE concepts; --",
        title: "SQLi",
      }),
    ).resolves.toBeDefined();
  });

  it("handles SQL-like strings in title field without crash", async () => {
    await expect(
      concepts.create(slug, "sql-inject-title", {
        type: "Reference",
        title: "'; DELETE FROM concepts WHERE 1=1; --",
      }),
    ).resolves.toBeDefined();
  });

  it("handles SQL-like strings in body without crash", async () => {
    await expect(
      concepts.create(slug, "sql-inject-body", {
        type: "Reference",
        body: "'; DROP TABLE bundles; --",
      }),
    ).resolves.toBeDefined();
  });

  it("handles SQL-like strings in search text without crash", async () => {
    const search = createServices(db).searchService;
    const results = await search.search({
      bundlePath: slug,
      text: "'; SELECT * FROM pg_tables; --",
    });
    expect(Array.isArray(results)).toBe(true);
  });

  // ── No-auth access to protected routes ─────────────────────────────────

  it("returns 401 on protected route without token", async () => {
    const app = authedApp();
    const res = await app.request("/okf/bundles");
    expect(res.status).toBe(401);
  });

  it("returns 401 on concept read without token", async () => {
    const app = authedApp();
    const res = await app.request(`/okf/bundles/${slug}/some-concept.md`);
    expect(res.status).toBe(401);
  });

  it("returns 401 on search without token", async () => {
    const app = authedApp();
    const res = await app.request("/okf/search");
    expect(res.status).toBe(401);
  });

  it("returns 401 on DELETE without token", async () => {
    const app = authedApp();
    const res = await app.request(`/okf/bundles/${slug}`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  // ── Body size / edge cases ─────────────────────────────────────────────

  it("handles very long body without crashing", async () => {
    const longBody = "x".repeat(100_000);
    await expect(
      concepts.createFromMarkdown(
        slug,
        "large-body",
        `---\ntype: Reference\ntitle: Large\n---\n\n${longBody}\n`,
      ),
    ).resolves.toBeDefined();
  });

  it("handles deep unicode and emoji in frontmatter", async () => {
    await expect(
      concepts.create(slug, "unicode-test", {
        type: "Reference",
        title: "Unicode ★ 🎉 äéñ",
        description: "Café résumé 中文",
      }),
    ).resolves.toBeDefined();
  });

  it("rejects null bytes in body (Postgres UTF-8 validation)", async () => {
    await expect(
      concepts.create(slug, "null-bytes", {
        type: "Reference",
        body: "Valid content before \0 null byte after",
      }),
    ).rejects.toThrow();
  });

  // ── Reserved filename edge cases ───────────────────────────────────────

  it("rejects concept named log.md via API", async () => {
    const app = authedApp();
    const res = await app.request(`/okf/bundles/${slug}/log.md`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key-789",
      },
      body: JSON.stringify({ type: "Test" }),
    });
    expect(res.status).toBe(422);
  });

  it("rejects concept named index.md via API", async () => {
    const app = authedApp();
    const res = await app.request(`/okf/bundles/${slug}/index.md`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-key-789",
      },
      body: JSON.stringify({ type: "Test" }),
    });
    expect(res.status).toBe(422);
  });

  // ── GET /log.md and GET /index.md return synthesized content, not stored concepts ──

  it("GET log.md returns synthesized content, not a stored concept", async () => {
    const app = authedApp();
    const res = await app.request(`/okf/bundles/${slug}/log.md`, {
      headers: { authorization: "Bearer test-key-789" },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("Update Log");
  });

  it("GET index.md returns synthesized content, not a stored concept", async () => {
    const app = authedApp();
    const res = await app.request(`/okf/bundles/${slug}/index.md`, {
      headers: { authorization: "Bearer test-key-789" },
    });
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("#");
  });
});
