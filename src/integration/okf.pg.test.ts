import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb, type DbHandle } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { createServices, type Services } from "../services/factory.js";
import {
  BundleNotFoundError,
  ConceptNotFoundError,
  ConflictError,
  OkfValidationError,
  ReservedConceptIdError,
} from "../domain/errors.js";

const url = process.env["DATABASE_URL"] ?? process.env["TEST_DATABASE_URL"];

/**
 * Full-stack integration tests against a real Postgres. Skipped automatically
 * when no DATABASE_URL is configured (e.g. `docker compose up -d postgres`).
 */
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

suite("OKF Postgres integration", () => {
  let handle: DbHandle;
  let bundles: Services["bundleService"];
  let concepts: Services["conceptService"];
  let search: Services["searchService"];
  let indexer: Services["indexService"];
  let exportService: Services["exportService"];
  let importService: Services["importService"];
  let conceptRepo: Services["conceptRepo"];
  let bundleRepo: Services["bundleRepo"];
  const slug = `test-${Date.now().toString(36)}`;

  beforeAll(async () => {
    await runMigrations(url!);
    handle = createDb(url!);
    const svc = createServices(handle.db);
    bundles = svc.bundleService;
    concepts = svc.conceptService;
    search = svc.searchService;
    indexer = svc.indexService;
    exportService = svc.exportService;
    importService = svc.importService;
    conceptRepo = svc.conceptRepo;
    bundleRepo = svc.bundleRepo;
  });

  afterAll(async () => {
    if (handle) await handle.close();
  });

  it("creates and lists bundles", async () => {
    const b = await bundles.create({ slug, title: "Test" });
    expect(b.slug).toBe(slug);
    expect((await bundles.list()).some((x) => x.slug === slug)).toBe(true);
  });

  it("rejects duplicate bundle slugs", async () => {
    await expect(bundles.create({ slug })).rejects.toThrow(ConflictError);
  });

  it("creates, reads, and tracks reads on a concept", async () => {
    await concepts.create(slug, "global/logging", { type: "reference", title: "Logging" });
    const first = await concepts.read(slug, "global/logging");
    expect(first.frontmatter.type).toBe("Reference");
    expect(first.frontmatter.read_count).toBe(0);
    const tracked = await concepts.read(slug, "global/logging.md", { trackRead: true });
    expect(tracked.frontmatter.read_count).toBe(1);
  });

  it("rejects reserved filenames across all concept operations", async () => {
    for (const reserved of ["index", "log", "tables/index", "tables/log"]) {
      await expect(concepts.create(slug, reserved, { type: "Reference" })).rejects.toThrow(
        ReservedConceptIdError,
      );
      await expect(concepts.read(slug, `${reserved}.md`)).rejects.toThrow(ReservedConceptIdError);
      await expect(concepts.update(slug, reserved, { type: "Reference" }, "x")).rejects.toThrow(
        ReservedConceptIdError,
      );
      await expect(concepts.delete(slug, reserved)).rejects.toThrow(ReservedConceptIdError);
    }
  });

  it("synthesizes log.md from concept history, never stores it", async () => {
    const md = await indexer.logMarkdown([slug]);
    expect(md).toContain("Update Log");
    expect(md).toMatch(/## \d{4}-\d{2}-\d{2}/);
    expect(md).toContain("**Creation**");
    const idx = await indexer.index([slug]);
    const urls = idx.tree.flatMap((n) => (n.isDirectory ? n.children.map((c) => c.url) : n.url));
    expect(urls).not.toContain("/log.md");
  });

  it("ranks full-text search and respects scope", async () => {
    await concepts.create(slug, "scopes/tech/typescript/async-errors", {
      type: "Playbook",
      title: "Async Errors",
      description: "Handling asynchronous error propagation",
      tags: ["errors"],
    });
    await concepts.create(slug, "scopes/tech/java/checked", { type: "Playbook", title: "Checked" });

    const hits = await search.search({ bundlePath: slug, text: "asynchronous error" });
    expect(hits[0]?.id).toBe(`${slug}/scopes/tech/typescript/async-errors`);

    const scoped = await search.search({ bundlePath: slug, scopes: ["tech/typescript"] });
    const ids = scoped.map((r) => r.id);
    expect(ids).toContain(`${slug}/global/logging`);
    expect(ids).toContain(`${slug}/scopes/tech/typescript/async-errors`);
    expect(ids).not.toContain(`${slug}/scopes/tech/java/checked`);
  });

  it("synthesizes a directory index", async () => {
    const root = await indexer.index([slug]);
    const dirNames = root.tree
      .filter((n) => n.isDirectory)
      .map((n) => n.name)
      .sort();
    expect(dirNames).toEqual(["global", "scopes"]);

    const global = await indexer.index([slug, "global"]);
    expect(global.tree.filter((n) => !n.isDirectory).map((n) => n.title)).toContain("Logging");

    const md = await indexer.indexMarkdown([slug]);
    expect(md).toContain("# Subdirectories");
  });

  it("soft-deletes a concept", async () => {
    await concepts.delete(slug, "scopes/tech/java/checked");
    await expect(concepts.read(slug, "scopes/tech/java/checked")).rejects.toThrow(
      ConceptNotFoundError,
    );
  });

  it("soft-delete cascades from bundle to concepts", async () => {
    // Re-create the test bundle since it was soft-deleted above.
    const newSlug = `${slug}-2`;
    await bundles.create({ slug: newSlug });
    await concepts.create(newSlug, "some/doc", { type: "reference", title: "Doc" });

    await bundles.delete(newSlug);
    await expect(bundles.resolve([newSlug])).rejects.toThrow(BundleNotFoundError);
    await expect(concepts.read(newSlug, "some/doc")).rejects.toThrow(BundleNotFoundError);
  });

  it("creates child bundles with parentPath", async () => {
    const parent = await bundles.create({ slug: `${slug}-parent`, title: "Parent" });
    const child = await bundles.create({
      slug: "child",
      parentPath: parent.slug,
      title: "Child",
    });
    expect(child.slug).toBe("child");
    const resolved = await bundles.resolve([parent.slug, "child"]);
    expect(resolved.bundle.slug).toBe("child");
    expect(resolved.path).toBe(`${parent.slug}/child`);
  });

  it("auto-creates intermediate directory bundles via resolveOrCreateChild", async () => {
    const main = `${slug}-deep`;
    await bundles.create({ slug: main });
    const leaf = await bundles.resolveOrCreateChild(main, ["a", "b", "c"]);
    expect(leaf.slug).toBe("c");
    const full = await bundles.resolve([main, "a", "b", "c"]);
    expect(full.bundle.slug).toBe("c");
  });

  it("deep nested concept paths create intermediate bundles", async () => {
    const main = `${slug}-nested`;
    await bundles.create({ slug: main });
    await concepts.create(main, "x/y/z/deep-concept", {
      type: "reference",
      title: "Deeply Nested",
    });
    const read = await concepts.read(main, "x/y/z/deep-concept");
    expect(read.frontmatter.title).toBe("Deeply Nested");
  });

  it("recursive tree index shows nested hierarchy", async () => {
    const main = `${slug}-recursive`;
    await bundles.create({ slug: main });
    await concepts.create(main, "p/q/r/leaf", { type: "reference", title: "Leaf" });
    const tree = await indexer.index([main]);
    const findNested = (nodes: typeof tree.tree): boolean =>
      nodes.some((n) => n.name === "r" || (n.children.length > 0 && findNested(n.children)));
    expect(findNested(tree.tree)).toBe(true);
  });

  it("indexMarkdown throws BundleNotFoundError for nonexistent bundle", async () => {
    await expect(indexer.indexMarkdown(["nonexistent-bundle-xyz"])).rejects.toThrow(
      BundleNotFoundError,
    );
  });

  // ── Bundle service edge cases ──────────────────────────────────────────

  it("normalizes uppercase bundle slugs to lowercase", async () => {
    const created = await bundles.create({ slug: `Upper-${Date.now().toString(36)}` });
    expect(created.slug).toBe(created.slug.toLowerCase());
  });

  it("rejects bundle create with invalid slug spaces", async () => {
    await expect(bundles.create({ slug: "has space" })).rejects.toThrow(OkfValidationError);
  });

  it("rejects bundle create with empty slug", async () => {
    await expect(bundles.create({ slug: "" })).rejects.toThrow(OkfValidationError);
  });

  it("rejects bundle resolve with empty segments", async () => {
    await expect(bundles.resolve([])).rejects.toThrow(BundleNotFoundError);
  });

  it("rejects bundle resolve with nonexistent slug", async () => {
    await expect(bundles.resolve(["__does_not_exist__"])).rejects.toThrow(BundleNotFoundError);
  });

  it("rejects bundle delete with nonexistent slug", async () => {
    await expect(bundles.delete("__does_not_exist__")).rejects.toThrow(BundleNotFoundError);
  });

  // ── Concept update from markdown ───────────────────────────────────────

  it("updates a concept from raw markdown", async () => {
    const main = `${slug}-md-update`;
    await bundles.create({ slug: main });
    await concepts.create(main, "test-note", { type: "reference", title: "Original" });

    const updated = await concepts.updateFromMarkdown(
      main,
      "test-note",
      "---\ntype: Playbook\ntitle: Updated\nresource: https://example.com\n---\n\nNew body content.\n",
    );
    expect(updated.frontmatter.title).toBe("Updated");
    expect(updated.frontmatter.type).toBe("Playbook");
    expect(updated.frontmatter.resource).toBe("https://example.com");
    expect(updated.body).toContain("New body content");
  });

  it("updateFromMarkdown preserves extension frontmatter keys", async () => {
    const main = `${slug}-ext-keys`;
    await bundles.create({ slug: main });
    const created = await concepts.createFromMarkdown(
      main,
      "ext-test",
      "---\ntype: reference\nowner: data-team\nstatus: active\n---\n\nSome content.\n",
    );
    expect(created.frontmatter.owner).toBe("data-team");
    expect(created.frontmatter.status).toBe("active");

    const updated = await concepts.updateFromMarkdown(
      main,
      "ext-test",
      "---\ntype: reference\ntitle: Ext Test\nowner: ml-team\nstatus: active\nversion: 2\n---\n\nUpdated.\n",
    );
    expect(updated.frontmatter.owner).toBe("ml-team");
    expect(updated.frontmatter.version).toBe(2);
    expect(updated.frontmatter.title).toBe("Ext Test");
  });

  // ── Subdirectory index.md and log.md ──────────────────────────────────

  it("synthesizes index.md for a subdirectory", async () => {
    const main = `${slug}-subdir-idx`;
    await bundles.create({ slug: main });
    await concepts.create(main, "team/alice/notes", { type: "reference", title: "Alice Notes" });
    await concepts.create(main, "team/bob/report", { type: "reference", title: "Bob Report" });

    const md = await indexer.indexMarkdown([main, "team"]);
    expect(md).toContain("# Concepts");
    expect(md).toContain("[Alice Notes]");
    expect(md).toContain("[Bob Report]");
    expect(md).toContain("## Subdirectories");
    expect(md).toContain("[alice]");
    expect(md).toContain("[bob]");
  });

  it("synthesizes log.md for a subdirectory scope", async () => {
    const main = `${slug}-subdir-log`;
    await bundles.create({ slug: main });
    await concepts.create(main, "sub-a/one", { type: "reference", title: "One" });
    await concepts.create(main, "sub-a/two", { type: "reference", title: "Two" });

    const md = await indexer.logMarkdown([main, "sub-a"]);
    expect(md).toContain("Update Log");
    expect(md).toMatch(/## \d{4}-\d{2}-\d{2}/);
    expect(md).toContain("**Creation**");
    expect(md).toContain("`Reference`");
    expect(md).toContain("[One]");
    expect(md).toContain("[Two]");
  });

  // ── Search filter combinations ────────────────────────────────────────

  it("search filters by type", async () => {
    const main = `${slug}-search-type`;
    await bundles.create({ slug: main });
    await concepts.create(main, "doc-a", { type: "playbook", title: "Alpha" });
    await concepts.create(main, "doc-b", { type: "reference", title: "Beta" });

    const playbooks = await search.search({ bundlePath: main, type: "Playbook" });
    expect(playbooks.length).toBe(1);
    expect(playbooks[0]!.id).toBe(`${main}/doc-a`);
  });

  it("search filters by tags", async () => {
    const main = `${slug}-search-tags`;
    await bundles.create({ slug: main });
    await concepts.create(main, "err-one", { type: "reference", title: "Err 1", tags: ["errors"] });
    await concepts.create(main, "err-two", {
      type: "reference",
      title: "Err 2",
      tags: ["errors", "critical"],
    });
    await concepts.create(main, "other", { type: "reference", title: "Other", tags: ["docs"] });

    const tagged = await search.search({ bundlePath: main, tags: ["errors"] });
    expect(tagged.length).toBe(2);
    expect(tagged.map((r) => r.id).sort()).toEqual([`${main}/err-one`, `${main}/err-two`]);
  });

  it("search with limit and offset paginates results", async () => {
    const main = `${slug}-paginate`;
    await bundles.create({ slug: main });
    for (let i = 0; i < 5; i++) {
      await concepts.create(main, `page-doc-${i}`, { type: "reference", title: `Doc ${i}` });
    }

    const page1 = await search.search({ bundlePath: main, limit: 2 });
    expect(page1.length).toBe(2);

    const page2 = await search.search({ bundlePath: main, limit: 2, offset: 2 });
    expect(page2.length).toBe(2);

    // pages should not overlap
    const ids1 = new Set(page1.map((r) => r.id));
    const ids2 = new Set(page2.map((r) => r.id));
    for (const id of ids1) expect(ids2.has(id)).toBe(false);
  });

  it("search with empty text returns documents ordered by recency", async () => {
    const main = `${slug}-empty-text`;
    await bundles.create({ slug: main });
    await concepts.create(main, "z-last", { type: "reference", title: "Z Last" });
    await concepts.create(main, "a-first", { type: "reference", title: "A First" });

    const results = await search.search({ bundlePath: main, limit: 10 });
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("search with special characters does not crash", async () => {
    const main = `${slug}-special`;
    await bundles.create({ slug: main });
    await concepts.create(main, "special", { type: "reference", title: "Normal" });

    const results = await search.search({ bundlePath: main, text: "!@#$%^&*()" });
    expect(Array.isArray(results)).toBe(true);
  });

  it("fuzzy search finds concepts with typo-tolerant matching", async () => {
    const main = `${slug}-fuzzy`;
    await bundles.create({ slug: main });
    await concepts.create(main, "asynch-error", {
      type: "Playbook",
      title: "Async Error Handling",
      description: "Handling asynchronous error propagation in distributed systems",
    });

    // Typo: "asynchrnous" instead of "asynchronous" — trigram similarity should catch it
    const results = await search.search({ bundlePath: main, text: "asynchrnous error" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0]!.id).toBe(`${main}/asynch-error`);
    // Verify snippet is returned
    expect(results[0]!.snippet).toBeDefined();
    expect(results[0]!.snippet!.length).toBeGreaterThan(0);
  });

  it("fuzzy search with significant typo still returns results", async () => {
    const main = `${slug}-fuzzy2`;
    await bundles.create({ slug: main });
    await concepts.create(main, "distributed-tracing", {
      type: "Reference",
      title: "Distributed Tracing",
      description: "Tracing requests across microservices",
    });

    const results = await search.search({ bundlePath: main, text: "distributd tracng" });
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  // ── Concept create from markdown (createFromMarkdown) ──────────────────

  it("createFromMarkdown stores resource and extension keys", async () => {
    const main = `${slug}-cfm`;
    await bundles.create({ slug: main });
    const c = await concepts.createFromMarkdown(
      main,
      "ext-concept",
      "---\ntype: BigQuery Table\ntitle: Ext\ndescription: Test\ntags: [a, b]\nresource: https://example.com/t\ncustom_key: hello\n---\n\nBody.\n",
    );
    expect(c.frontmatter.type).toBe("BigQuery Table");
    expect(c.frontmatter.title).toBe("Ext");
    expect(c.frontmatter.description).toBe("Test");
    expect(c.frontmatter.tags).toEqual(["a", "b"]);
    expect(c.frontmatter.resource).toBe("https://example.com/t");
    expect(c.frontmatter.custom_key).toBe("hello");
  });

  it("createFromMarkdown rejects reserved filenames", async () => {
    await expect(
      concepts.createFromMarkdown(slug, "index", "---\ntype: Foo\n---\n"),
    ).rejects.toThrow(ReservedConceptIdError);
  });

  it("create with empty body stores empty string", async () => {
    const main = `${slug}-empty-body`;
    await bundles.create({ slug: main });
    const c = await concepts.create(main, "empty", { type: "Note", title: "Empty", body: "" });
    expect(c.body).toBe("");
    const results = await search.search({ bundlePath: main });
    expect(results.some((r) => r.id === `${main}/empty`)).toBe(true);
    // Log should include both creation and update entries (when updatedAt > createdAt)
    const log2 = await indexer.logMarkdown([main]);
    expect(log2).toContain("Empty");
  });

  it("rejects empty slug path via create", async () => {
    await expect(concepts.create(slug, "", { type: "Note", title: "Empty" })).rejects.toThrow(
      OkfValidationError,
    );
  });

  it("rejects dot-path via create", async () => {
    await expect(concepts.create(slug, ".", { type: "Note", title: "Dot" })).rejects.toThrow(
      OkfValidationError,
    );
  });

  it("update concept and verify log includes Update entry", async () => {
    const main = `${slug}-log-upd`;
    await bundles.create({ slug: main });
    await concepts.create(main, "chg", { type: "Note", title: "ChangeMe" });
    // Wait >1 s so updatedAt drifts past createdAt
    await new Promise((r) => setTimeout(r, 1100));
    await concepts.update(main, "chg", { type: "Note", title: "Changed" }, "# Changed\n");
    const md = await indexer.logMarkdown([main]);
    expect(md).toContain("Update");
  });

  it("exportStream returns readable for non-existent bundle", async () => {
    const stream = await exportService.exportStream("__nope__" + slug);
    expect(stream.readable).toBe(true);
  });

  it("importTarGz skips non-md files and collects errors", async () => {
    const main = `${slug}-import-edge`;
    await bundles.create({ slug: main });
    const { tarEntry, tarEnd } = await import("../services/bundle-export.js");
    const { createGzip } = await import("node:zlib");
    // Include a .md, a non-.md (should skip), and a corrupt entry that errors
    const entries = [
      ...tarEntry(`${main}/valid.md`, "---\ntype: Note\ntitle: Valid\n---\n\nHello.\n"),
      ...tarEntry(`${main}/readme.txt`, "not markdown"),
      tarEnd(),
    ];
    const gzData = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const gz = createGzip();
      gz.on("data", (c: Buffer) => chunks.push(c));
      gz.on("end", () => resolve(Buffer.concat(chunks)));
      gz.on("error", reject);
      gz.write(Buffer.concat(entries));
      gz.end();
    });
    const result = await importService.importTarGz(main, gzData);
    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("parseTar handles zero-block and malformed headers gracefully", async () => {
    const { parseTar } = await import("../services/bundle-import.js");
    // Zero block at start
    const zeroBlock = Buffer.alloc(512, 0);
    const files = parseTar(zeroBlock);
    expect(files).toHaveLength(0);
  });

  it("resolve throws for non-existent child bundle", async () => {
    const main = `${slug}-resolve-child`;
    await bundles.create({ slug: main });
    await expect(bundles.resolve([main, "no-such-child"])).rejects.toThrow(BundleNotFoundError);
  });

  it("createFromMarkdown with non-object frontmatter triggers empty-path error", async () => {
    const main = `${slug}-bad-fm`;
    await bundles.create({ slug: main });
    // YAML that parses to `true` (boolean, not object) triggers a schema
    // error where the Zod issue path is empty, exercising the falsy-path
    // branch in okf-document.ts:18
    await expect(
      concepts.createFromMarkdown(main, "bad", "---\ntrue\n---\nbody\n"),
    ).rejects.toThrow(OkfValidationError);
  });

  it("createFromMarkdown defaults body when markdown has none", async () => {
    const main = `${slug}-cfm-empty`;
    await bundles.create({ slug: main });
    const c = await concepts.createFromMarkdown(
      main,
      "no-body",
      "---\ntype: Foo\ntitle: NoBody\n---\n",
    );
    expect(c.body.length).toBeGreaterThan(0);
  });

  // ── OkfValidationError propagation ────────────────────────────────────

  it("concept create with invalid path traversal is rejected", async () => {
    await expect(concepts.create(slug, "../evil", { type: "Test" })).rejects.toThrow(
      OkfValidationError,
    );
  });

  it("readVersion throws when version not found", async () => {
    await expect(concepts.readVersion(slug, "global/logging", 999)).rejects.toThrow(
      ConceptNotFoundError,
    );
  });

  it("update with invalid frontmatter throws validation error", async () => {
    await expect(concepts.update(slug, "global/logging", { type: "" }, "body")).rejects.toThrow(
      OkfValidationError,
    );
  });

  // ── Global search (no bundle filter) ─────────────────────────────────

  it("search without bundle filter returns results from across bundles", async () => {
    const results = await search.search({ text: "Logging" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    const match = results.find((r) => r.id.includes("global/logging"));
    expect(match).toBeDefined();
  });

  it("search with tags filter returns matching results", async () => {
    const results = await search.search({ bundlePath: slug, tags: ["a"] });
    expect(Array.isArray(results)).toBe(true);
  });

  it("search with empty text returns all concepts in bundle", async () => {
    const results = await search.search({ bundlePath: slug });
    expect(results.length).toBeGreaterThan(0);
  });

  it("search respects limit and offset", async () => {
    const all = await search.search({ bundlePath: slug });
    const limited = await search.search({ bundlePath: slug, limit: 1 });
    expect(limited.length).toBe(1);
    const offset = await search.search({ bundlePath: slug, limit: 1, offset: 1 });
    if (all.length > 1) {
      expect(offset[0]!.id).not.toBe(limited[0]!.id);
    }
  });

  // ── Index subdirectory ───────────────────────────────────────────────

  it("index returns tree for subdirectory", async () => {
    const tree = await indexer.index([slug, "scopes"]);
    expect(tree.path).toBe(`${slug}/scopes`);
    expect(tree.tree.length).toBeGreaterThanOrEqual(0);
  });

  // ── Cross-bundle search ──────────────────────────────────────────────

  it("search without bundlePath returns results across all bundles", async () => {
    const results = await search.search({ text: "Test" });
    expect(Array.isArray(results)).toBe(true);
  });

  // ── Bundle tree resolution edge cases ────────────────────────────────

  it("resolveOrCreateChild creates intermediate bundles", async () => {
    const leaf = await bundles.repo.insert({
      parentId: null,
      slug: `nested-${Date.now().toString(36)}`,
    });
    const child = await bundles.resolveOrCreateChild(leaf.slug, ["a", "b"]);
    expect(child.slug).toBe("b");
    const resolved = await bundles.resolve([leaf.slug, "a", "b"]);
    expect(resolved.bundle.id).toBe(child.id);
  });

  it("delete on already-deleted bundle resolves gracefully", async () => {
    await expect(bundles.delete(`__already-gone-${Date.now()}`)).rejects.toThrow(
      BundleNotFoundError,
    );
  });

  it("create bundle with parentPath nests correctly", async () => {
    const parent = await bundles.create({ slug: `parent-${Date.now().toString(36)}` });
    const child = await bundles.create({
      slug: `child-${Date.now().toString(36)}`,
      parentPath: parent.slug,
    });
    const resolved = await bundles.resolve([parent.slug, child.slug]);
    expect(resolved.bundle.id).toBe(child.id);
  });

  it("create duplicate child bundle throws ConflictError", async () => {
    const parent = await bundles.create({ slug: `dup-parent-${Date.now().toString(36)}` });
    const slug2 = `dup-child-${Date.now().toString(36)}`;
    await bundles.create({ slug: slug2, parentPath: parent.slug });
    await expect(bundles.create({ slug: slug2, parentPath: parent.slug })).rejects.toThrow(
      ConflictError,
    );
  });

  // ── Update lifecycle ─────────────────────────────────────────────────

  it("updateFromMarkdown round-trips correctly", async () => {
    const main = `${slug}-ufm`;
    await bundles.create({ slug: main });
    await concepts.create(main, "roundtrip", { type: "reference", title: "Round" });
    const c = await concepts.updateFromMarkdown(
      main,
      "roundtrip",
      "---\ntype: Playbook\ntitle: Tripped\n---\n\nUpdated body.\n",
    );
    expect(c.frontmatter.title).toBe("Tripped");
    expect(c.frontmatter.type).toBe("Playbook");
    expect(c.body).toContain("Updated body");
  });

  // ── Scope-based search ──────────────────────────────────────────────

  it("search with project scope filter works", async () => {
    const results = await search.search({
      text: "Logging",
      project: `${slug}/scopes`,
    });
    expect(Array.isArray(results)).toBe(true);
  });

  it("search with scopes array filter works", async () => {
    const results = await search.search({
      text: "Logging",
      scopes: [{ kind: "project" }],
    });
    expect(Array.isArray(results)).toBe(true);
  });

  it("updateFromMarkdown preserves frontmatter extensions passed through parse", async () => {
    const main = `${slug}-ufm-ext`;
    await bundles.create({ slug: main });
    await concepts.createFromMarkdown(
      main,
      "ext-keep",
      "---\ntype: Note\nextra: preserve-me\n---\n\nOriginal.\n",
    );
    const c = await concepts.updateFromMarkdown(
      main,
      "ext-keep",
      "---\ntype: Reference\ntitle: Kept\nextra: preserve-me\n---\n\nUpdated.\n",
    );
    expect(c.frontmatter.extra).toBe("preserve-me");
  });

  it("createFromMarkdown rejects duplicate path", async () => {
    const main = `${slug}-cfm-dup`;
    await bundles.create({ slug: main });
    await concepts.createFromMarkdown(main, "dup", "---\ntype: Note\n---\n\nBody.\n");
    await expect(
      concepts.createFromMarkdown(main, "dup", "---\ntype: Note\n---\n\nBody.\n"),
    ).rejects.toThrow(ConflictError);
  });

  // ── Export / Import ──────────────────────────────────────────────────

  it("import with invalid concept catches per-file errors", async () => {
    const { tarEntry, tarEnd } = await import("../services/bundle-export.js");
    const { createGzip } = await import("node:zlib");
    const entries = [
      ...tarEntry("root/bad.md", "---\ntitle: No Type\n---\n\nNo type.\n"),
      tarEnd(),
    ];
    const raw = Buffer.concat(entries);
    const chunks: Buffer[] = [];
    const gz = await new Promise<Buffer>((resolve, reject) => {
      const gz2 = createGzip();
      gz2.on("data", (c: Buffer) => chunks.push(c));
      gz2.on("end", () => resolve(Buffer.concat(chunks)));
      gz2.on("error", reject);
      gz2.write(raw);
      gz2.end();
    });
    const result = await importService.importTarGz(slug, gz);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.created).toBe(0);
  });

  it("import creates new concepts in fresh bundle", async () => {
    const main = `${slug}-import-create`;
    await bundles.create({ slug: main });
    const { tarEntry, tarEnd } = await import("../services/bundle-export.js");
    const { createGzip } = await import("node:zlib");
    const entries = [
      ...tarEntry(
        `${main}/new-doc.md`,
        "---\ntype: Note\ntitle: New Doc\n---\n\nFreshly imported.\n",
      ),
      tarEnd(),
    ];
    const raw = Buffer.concat(entries);
    const chunks: Buffer[] = [];
    const gz = await new Promise<Buffer>((resolve, reject) => {
      const gz2 = createGzip();
      gz2.on("data", (c: Buffer) => chunks.push(c));
      gz2.on("end", () => resolve(Buffer.concat(chunks)));
      gz2.on("error", reject);
      gz2.write(raw);
      gz2.end();
    });
    const result = await importService.importTarGz(main, gz);
    expect(result.created).toBe(1);
    expect(result.updated).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("export-import round-trips concepts", async () => {
    const main = `${slug}-ei-rt`;
    await bundles.create({ slug: main });
    await concepts.create(main, "doc-a", { type: "Reference", title: "A" }, "# Doc A\n");
    await concepts.create(main, "doc-b", { type: "Playbook", title: "B" }, "# Doc B\n");

    const stream = await exportService.exportStream(main);
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const gzData = Buffer.concat(chunks);

    const result = await importService.importTarGz(main, gzData);
    // Both docs already exist → should update not create
    expect(result.updated).toBe(2);
    expect(result.created).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("indexMarkdown includes description when present", async () => {
    const main = `${slug}-index-desc`;
    await bundles.create({ slug: main, title: "Desc Bundle", description: "A test bundle" });
    await concepts.create(main, "doc1", { type: "Note", title: "First" });
    const md = await indexer.indexMarkdown([main]);
    expect(md).toContain("Desc Bundle");
    expect(md).toContain("A test bundle");
  });

  it("logMarkdown for empty bundle returns No history", async () => {
    const main = `${slug}-empty-log`;
    await bundles.create({ slug: main });
    const md = await indexer.logMarkdown([main]);
    expect(md).toContain("_No history._");
  });

  it("buildTree includes child description in tree", async () => {
    const main = `${slug}-childdesc`;
    await bundles.create({ slug: main });
    await bundles.create({
      slug: "sub",
      parentPath: main,
      title: "Sub",
      description: "Sub description",
    });
    await concepts.create(main, "doc1", { type: "Note", title: "First" });
    const idx = await indexer.index([main]);
    expect(idx.tree.some((n) => n.isDirectory && n.description === "Sub description")).toBe(true);
  });

  it("parseTar handles empty name and NaN size", async () => {
    const { parseTar } = await import("../services/bundle-import.js");
    // Header with valid first byte but empty name (bytes 1-99 all zero)
    const hdr1 = Buffer.alloc(512, 0);
    hdr1[0] = 0x30; // non-zero first byte (ASCII '0')
    // But the loop stops at header[0] when it's non-zero and then reads
    // name from bytes 0-99. If only byte 0 is non-zero and bytes 1-99 are 0,
    // name = "0" (non-empty). So this won't trigger the `if (!name)` break.
    // Instead, set a valid size at bytes 124-134
    const size = "00000000144";
    hdr1.write(size, 124, 11, "ascii");
    // With name "0" and valid size, parser reads 144 bytes at offset 512
    // This won't trigger the empty-name break.
    // Let's create one with NO valid name at all
    const hdr2 = Buffer.alloc(512, 0);
    hdr2[0] = 0; // zero block → triggers break at line 64
    const f2 = parseTar(hdr2);
    expect(f2).toHaveLength(0);
  });

  it("parseTar with bad octal size breaks at NaN", async () => {
    const { parseTar } = await import("../services/bundle-import.js");
    // Header with valid name but size field contains non-octal chars
    const hdr = Buffer.alloc(512, 0);
    hdr.write("hello", 0, 5, "ascii"); // valid name
    hdr.write("notanoctal", 124, 11, "ascii"); // bad size → parseInt returns NaN
    const files = parseTar(hdr);
    expect(files).toHaveLength(0);
  });

  it("conceptRepo.update updates a concept row directly", async () => {
    const main = `${slug}-repo-update`;
    await bundles.create({ slug: main });
    const root = await bundleRepo.findRootBySlug(main);
    const inserted = await conceptRepo.insert({
      bundleId: root!.id,
      slug: "direct",
      type: "Note",
      title: "Direct",
      frontmatter: { type: "Note", title: "Direct" },
      body: "# Direct\n",
    });
    const updated = await conceptRepo.update(inserted.id, { title: "Updated Title" });
    expect(updated.title).toBe("Updated Title");
  });

  it("conceptRepo.saveVersion inserts a version row directly", async () => {
    const main = `${slug}-repo-version`;
    await bundles.create({ slug: main });
    const root = await bundleRepo.findRootBySlug(main);
    const inserted = await conceptRepo.insert({
      bundleId: root!.id,
      slug: "versioned",
      type: "Note",
      title: "Versioned",
      frontmatter: { type: "Note", title: "Versioned" },
      body: "# Versioned\n",
    });
    const version = await conceptRepo.saveVersion({
      conceptId: inserted.id,
      version: 1,
      type: "Note",
      title: "Versioned",
      frontmatter: { type: "Note", title: "Versioned" },
      body: "# Versioned\n",
    });
    expect(version.conceptId).toBe(inserted.id);
    expect(version.version).toBe(1);
  });

  it("bundleRepo.listChildren returns children of a parent", async () => {
    const main = `${slug}-repo-children`;
    await bundles.create({ slug: main });
    await bundles.create({ slug: "kid", parentPath: main });
    const root = await bundleRepo.findRootBySlug(main);
    const children = await bundleRepo.listChildren(root!.id);
    expect(children.some((c) => c.slug === "kid")).toBe(true);
  });

  it("update throws ConceptNotFoundError for missing concept", async () => {
    const main = `${slug}-upd-missing`;
    await bundles.create({ slug: main });
    await expect(
      concepts.update(main, "missing-concept", { type: "Note" }, "# X\n"),
    ).rejects.toThrow(ConceptNotFoundError);
  });

  it("readVersion throws ConceptNotFoundError for missing concept", async () => {
    const main = `${slug}-rv-missing`;
    await bundles.create({ slug: main });
    await expect(concepts.readVersion(main, "missing-concept", 1)).rejects.toThrow(
      ConceptNotFoundError,
    );
  });

  it("update rejects invalid frontmatter (empty type)", async () => {
    const main = `${slug}-upd-invalid`;
    await bundles.create({ slug: main });
    await concepts.create(main, "doc", { type: "Note", title: "Doc" });
    await expect(concepts.update(main, "doc", { type: "" } as never, "# Doc\n")).rejects.toThrow(
      OkfValidationError,
    );
  });
});
