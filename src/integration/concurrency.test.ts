import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createDb, type DbHandle } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { createServices, type Services } from "../services/factory.js";
import { ConceptNotFoundError } from "../domain/errors.js";

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

suite("Concurrency", () => {
  let handle: DbHandle;
  let bundles: Services["bundleService"];
  let concepts: Services["conceptService"];
  const slug = `concur-${Date.now().toString(36)}`;

  beforeAll(async () => {
    await runMigrations(url!);
    handle = createDb(url!);
    const svc = createServices(handle.db);
    bundles = svc.bundleService;
    concepts = svc.conceptService;
    await bundles.create({ slug });
  });

  afterAll(async () => {
    if (handle) await handle.close();
  });

  it("parallel creation of same concept slug — exactly one succeeds", async () => {
    const N = 5;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        concepts.create(slug, "concurrent-dupe", {
          type: "reference",
          title: `Race ${i}`,
        }),
      ),
    );

    const succeeded = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(succeeded.length).toBe(1);
    expect(failed.length).toBe(N - 1);
  });

  it("parallel creation of different slugs — all succeed", async () => {
    const N = 10;
    const results = await Promise.allSettled(
      Array.from({ length: N }, (_, i) =>
        concepts.create(slug, `parallel-${i}`, {
          type: "reference",
          title: `Parallel ${i}`,
        }),
      ),
    );
    const succeeded = results.filter((r) => r.status === "fulfilled");
    expect(succeeded.length).toBe(N);
  });

  it("concurrent read and delete — read either succeeds or gets ConceptNotFoundError", async () => {
    const target = "race-read-delete";
    await concepts.create(slug, target, { type: "reference", title: "Race Target" });

    const ops = Array.from({ length: 20 }, (_, i) =>
      i < 10 ? concepts.read(slug, target) : concepts.delete(slug, target),
    );

    const results = await Promise.allSettled(ops);
    const reads = results.slice(0, 10);
    const readsOk = reads.filter((r) => r.status === "fulfilled");
    const readsGone = reads.filter(
      (r) => r.status === "rejected" && r.reason instanceof ConceptNotFoundError,
    );
    const readsOther = reads.filter(
      (r) => r.status === "rejected" && !(r.reason instanceof ConceptNotFoundError),
    );
    expect(readsOther.length).toBe(0);
    expect(readsOk.length + readsGone.length).toBe(10);
  });

  it("concurrent reads increment read_count atomically", async () => {
    const target = "concurrent-read-count";
    await concepts.create(slug, target, { type: "reference", title: "Count Test" });

    const N = 20;
    await Promise.all(
      Array.from({ length: N }, () => concepts.read(slug, target, { trackRead: true })),
    );

    const final = await concepts.read(slug, target);
    expect(final.frontmatter.read_count).toBe(N);
  });

  it("concurrent bundle creation with same slug — only one succeeds (DB unique constraint)", async () => {
    const N = 5;
    const dupeSlug = `${slug}-dupe-bundle`;
    const results = await Promise.allSettled(
      Array.from({ length: N }, () => bundles.create({ slug: dupeSlug })),
    );
    const succeeded = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(succeeded.length).toBe(1);
    expect(rejected.length).toBe(N - 1);
  });

  it("read + update race — final state is consistent", async () => {
    const target = "race-read-update";
    await concepts.create(slug, target, { type: "reference", title: "Initial" });

    const UPDATES = 5;
    await Promise.all(
      Array.from({ length: UPDATES }, (_, i) =>
        concepts
          .read(slug, target)
          .then((c) =>
            concepts.update(slug, target, { ...c.frontmatter, title: `Update ${i}` }, c.body),
          ),
      ),
    );

    const final = await concepts.read(slug, target);
    // At least one update was applied
    expect(final.frontmatter.title).toMatch(/^Update \d+$/);
  });
});
