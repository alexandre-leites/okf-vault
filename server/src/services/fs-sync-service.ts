import { mkdir, writeFile, readdir, unlink } from "node:fs/promises";
import { join, posix } from "node:path";
import type { BundleRow } from "../db/schema.js";
import { rowToMarkdown } from "./concept-mapper.js";
import type { BundleRepository } from "../repository/bundle-repository.js";
import type { ConceptRepository } from "../repository/concept-repository.js";
import type { IndexService } from "./index-service.js";
import type { Logger } from "../logger.js";

/**
 * Mirrors the latest DB state to the filesystem as OKF markdown.
 * When enabled, every mutation triggers a sync so the filesystem tree is
 * always an up-to-date representation of the database contents.
 */
export class FsSyncService {
  constructor(
    private readonly storagePath: string,
    private readonly bundles: BundleRepository,
    private readonly concepts: ConceptRepository,
    private readonly indexer: IndexService,
    private readonly log?: Logger,
  ) {}

  /** Full sync: iterate every root bundle and sync its entire subtree. */
  async syncAll(): Promise<void> {
    const roots = await this.bundles.listRoots();
    for (const root of roots) {
      await this.syncRoot(root);
    }
  }

  /**
   * Sync the subtree rooted at the given root slug (e.g. "okf-vault").
   * Resolves the root bundle and syncs all descendants.
   */
  async syncBundle(rootSlug: string): Promise<void> {
    const root = await this.bundles.findRootBySlug(rootSlug);
    if (!root) return;
    await this.syncRoot(root);
  }

  private async syncRoot(root: BundleRow): Promise<void> {
    const subtree = await this.bundles.listSubtree(root.id);
    const allConcepts = await this.concepts.listByBundles(subtree.map((b) => b.id));

    const bundlePaths = buildBundlePaths(subtree);
    const expectedFiles = new Set<string>();

    for (const bundle of subtree) {
      const relPath = bundlePaths.get(bundle.id) ?? bundle.slug;
      const dirPath = join(this.storagePath, relPath);
      await mkdir(dirPath, { recursive: true });

      const bundleSegments = relPath.split("/");

      // Write index.md
      try {
        const indexMd = await this.indexer.indexMarkdown(bundleSegments);
        await writeFile(join(dirPath, "index.md"), indexMd, "utf8");
        expectedFiles.add(join(dirPath, "index.md"));
      } catch (err) {
        this.log?.error({ err, bundle: relPath }, "Failed to write index.md");
      }

      // Write log.md
      try {
        const logMd = await this.indexer.logMarkdown(bundleSegments);
        await writeFile(join(dirPath, "log.md"), logMd, "utf8");
        expectedFiles.add(join(dirPath, "log.md"));
      } catch (err) {
        this.log?.error({ err, bundle: relPath }, "Failed to write log.md");
      }
    }

    // Write concept markdown files
    for (const concept of allConcepts) {
      const bundleRel = bundlePaths.get(concept.bundleId);
      if (!bundleRel) continue;
      const filePath = join(this.storagePath, bundleRel, `${concept.slug}.md`);
      try {
        const md = rowToMarkdown(concept);
        await writeFile(filePath, md, "utf8");
        expectedFiles.add(filePath);
      } catch (err) {
        this.log?.error({ err, path: filePath }, "Failed to write concept");
      }
    }

    // Remove stale files (concepts that no longer exist in DB)
    for (const bundle of subtree) {
      const relPath = bundlePaths.get(bundle.id) ?? bundle.slug;
      const dirPath = join(this.storagePath, relPath);
      await this.removeStaleFiles(dirPath, expectedFiles);
    }
  }

  /**
   * Removes .md files in `dirPath` that are not in the expected set.
   * Also removes the directory itself when empty (after cleanup).
   */
  private async removeStaleFiles(dirPath: string, expected: Set<string>): Promise<void> {
    try {
      const entries = await readdir(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const fullPath = join(dirPath, entry.name);
        if (!expected.has(fullPath)) {
          await unlink(fullPath);
        }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw err;
    }
  }
}

/** Builds a map of bundleId → relative slug path from a subtree list. */
function buildBundlePaths(subtree: BundleRow[]): Map<string, string> {
  const byId = new Map<string, BundleRow>();
  for (const b of subtree) byId.set(b.id, b);

  const paths = new Map<string, string>();
  for (const b of subtree) {
    const segments: string[] = [b.slug];
    let current = b;
    while (current.parentId) {
      const parent = byId.get(current.parentId);
      if (!parent) break;
      segments.unshift(parent.slug);
      current = parent;
    }
    paths.set(b.id, posix.join(...segments));
  }
  return paths;
}
