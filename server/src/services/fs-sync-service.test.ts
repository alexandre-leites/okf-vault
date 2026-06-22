import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FsSyncService } from "./fs-sync-service.js";
import type { BundleRow, ConceptRow } from "../db/schema.js";
import type { BundleRepository } from "../repository/bundle-repository.js";
import type { ConceptRepository } from "../repository/concept-repository.js";
import type { IndexService } from "./index-service.js";

function tmpDir(): string {
  return mkdtempSync(join(tmpdir(), "okf-sync-test-"));
}

function mockBundle(overrides: Partial<BundleRow> & { id: string; slug: string }): BundleRow {
  return {
    parentId: null,
    title: null,
    description: null,
    okfVersion: "0.1",
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  } as BundleRow;
}

function mockConcept(
  overrides: Partial<ConceptRow> & { bundleId: string; slug: string },
): ConceptRow {
  return {
    id: "c-" + overrides.slug,
    type: "Reference",
    title: null,
    description: null,
    resource: null,
    tags: [],
    scopeKind: "global",
    scopeKey: null,
    frontmatter: {} as never,
    body: "# " + overrides.slug + "\n",
    version: 1,
    readCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
    ...overrides,
  } as ConceptRow;
}

describe("FsSyncService", () => {
  it("writes concept files and index.md / log.md for each bundle", async () => {
    const dir = tmpDir();
    try {
      const root = mockBundle({ id: "r1", slug: "test-bundle" });
      const child = mockBundle({
        id: "c1",
        slug: "sub",
        parentId: "r1",
      });
      const concept = mockConcept({ bundleId: "c1", slug: "hello", title: "Hello" });

      const bundles = {
        listRoots: vi.fn().mockResolvedValue([root]),
        findRootBySlug: vi.fn().mockResolvedValue(root),
        listSubtree: vi.fn().mockResolvedValue([root, child]),
      } as unknown as BundleRepository;

      const conceptsRepo = {
        listByBundles: vi.fn().mockResolvedValue([concept]),
      } as unknown as ConceptRepository;

      const indexPath = "test-bundle";
      const childPath = "test-bundle/sub";

      const indexer = {
        indexMarkdown: vi
          .fn()
          .mockResolvedValue("# Test Bundle\n\n## Concepts\n\n_No concepts._\n"),
        logMarkdown: vi.fn().mockResolvedValue("# Update Log\n\n_No history._\n"),
      } as unknown as IndexService;

      const svc = new FsSyncService(dir, bundles, conceptsRepo, indexer);
      await svc.syncAll();

      // Root index.md
      const rootIndex = join(dir, indexPath, "index.md");
      expect(existsSync(rootIndex)).toBe(true);
      expect(readFileSync(rootIndex, "utf8")).toContain("# Test Bundle");

      // Root log.md
      const rootLog = join(dir, indexPath, "log.md");
      expect(existsSync(rootLog)).toBe(true);
      expect(readFileSync(rootLog, "utf8")).toContain("# Update Log");

      // Child index.md
      const childIndex = join(dir, childPath, "index.md");
      expect(existsSync(childIndex)).toBe(true);

      // Concept file
      const conceptFile = join(dir, childPath, "hello.md");
      expect(existsSync(conceptFile)).toBe(true);
      const content = readFileSync(conceptFile, "utf8");
      expect(content).toContain("---");
      expect(content).toContain("type: Reference");

      // indexer was called with correct segments
      expect(indexer.indexMarkdown).toHaveBeenCalledWith(["test-bundle"]);
      expect(indexer.indexMarkdown).toHaveBeenCalledWith(["test-bundle", "sub"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("removes stale concept files that no longer exist in DB", async () => {
    const dir = tmpDir();
    try {
      const root = mockBundle({ id: "r1", slug: "stale-test" });
      const rootPath = join(dir, "stale-test");

      // Pre-create a stale file on disk
      const { mkdirSync, writeFileSync } = await import("node:fs");
      mkdirSync(rootPath, { recursive: true });
      writeFileSync(join(rootPath, "old-concept.md"), "# Stale\n");
      writeFileSync(join(rootPath, "index.md"), "# Old Index\n");

      const bundles = {
        listRoots: vi.fn().mockResolvedValue([root]),
        findRootBySlug: vi.fn().mockResolvedValue(root),
        listSubtree: vi.fn().mockResolvedValue([root]),
      } as unknown as BundleRepository;

      const conceptsRepo = {
        listByBundles: vi.fn().mockResolvedValue([]),
      } as unknown as ConceptRepository;

      const indexer = {
        indexMarkdown: vi.fn().mockResolvedValue("# Stale Test\n\n## Concepts\n\n_No concepts._\n"),
        logMarkdown: vi.fn().mockResolvedValue("# Update Log\n\n_No history._\n"),
      } as unknown as IndexService;

      const svc = new FsSyncService(dir, bundles, conceptsRepo, indexer);
      await svc.syncAll();

      // Stale concept removed
      expect(existsSync(join(rootPath, "old-concept.md"))).toBe(false);
      // index.md regenerated (not removed)
      const idx = readFileSync(join(rootPath, "index.md"), "utf8");
      expect(idx).toContain("Stale Test");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("syncs a single bundle by root slug", async () => {
    const dir = tmpDir();
    try {
      const root = mockBundle({ id: "r1", slug: "single-bundle" });
      const concept = mockConcept({ bundleId: "r1", slug: "doc1", title: "Doc 1" });

      const bundles = {
        findRootBySlug: vi.fn().mockResolvedValue(root),
        listSubtree: vi.fn().mockResolvedValue([root]),
      } as unknown as BundleRepository;

      const conceptsRepo = {
        listByBundles: vi.fn().mockResolvedValue([concept]),
      } as unknown as ConceptRepository;

      const indexer = {
        indexMarkdown: vi.fn().mockResolvedValue("# Single\n\n## Concepts\n\n_No concepts._\n"),
        logMarkdown: vi.fn().mockResolvedValue("# Update Log\n\n_No history._\n"),
      } as unknown as IndexService;

      const svc = new FsSyncService(dir, bundles, conceptsRepo, indexer);
      await svc.syncBundle("single-bundle");

      expect(existsSync(join(dir, "single-bundle", "doc1.md"))).toBe(true);
      expect(existsSync(join(dir, "single-bundle", "index.md"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("handles non-existent root slug gracefully", async () => {
    const dir = tmpDir();
    try {
      const bundles = {
        findRootBySlug: vi.fn().mockResolvedValue(undefined),
      } as unknown as BundleRepository;

      const svc = new FsSyncService(
        dir,
        bundles,
        {} as unknown as ConceptRepository,
        {} as unknown as IndexService,
      );
      await expect(svc.syncBundle("nonexistent")).resolves.toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes concept markdown with proper OKF frontmatter", async () => {
    const dir = tmpDir();
    try {
      const root = mockBundle({ id: "r1", slug: "fm-test" });
      const concept = mockConcept({
        bundleId: "r1",
        slug: "data-orders",
        type: "Metric",
        title: "Orders Count",
        description: "Total number of orders placed",
        tags: ["ecommerce", "sales"],
        body: "# Orders Count\n\nMonthly total orders.\n",
      });

      const bundles = {
        listRoots: vi.fn().mockResolvedValue([root]),
        findRootBySlug: vi.fn().mockResolvedValue(root),
        listSubtree: vi.fn().mockResolvedValue([root]),
      } as unknown as BundleRepository;

      const conceptsRepo = {
        listByBundles: vi.fn().mockResolvedValue([concept]),
      } as unknown as ConceptRepository;

      const indexer = {
        indexMarkdown: vi.fn().mockResolvedValue("# FM Test\n\n## Concepts\n\n_No concepts._\n"),
        logMarkdown: vi.fn().mockResolvedValue("# Update Log\n\n_No history._\n"),
      } as unknown as IndexService;

      const svc = new FsSyncService(dir, bundles, conceptsRepo, indexer);
      await svc.syncAll();

      const content = readFileSync(join(dir, "fm-test", "data-orders.md"), "utf8");
      expect(content).toMatch(/^---\n/m);
      expect(content).toContain("type: Metric");
      expect(content).toContain("title: Orders Count");
      expect(content).toContain("description: Total number of orders placed");
      expect(content).toContain("# Orders Count");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
