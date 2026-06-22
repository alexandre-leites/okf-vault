import { BundleRepository } from "../repository/bundle-repository.js";
import { ConceptRepository } from "../repository/concept-repository.js";
import type { BundleRow } from "../db/schema.js";
import { BundleNotFoundError, ConflictError, OkfValidationError } from "../domain/errors.js";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

/**
 * The reserved root bundle for knowledge that is not tied to any single
 * project (user preferences, cross-cutting standards, etc.). It is matched
 * case-insensitively and is guaranteed to exist (auto-created on demand).
 */
export const GLOBAL_BUNDLE_SLUG = "global";

/** True if `slug` names the reserved global bundle (case-insensitive). */
export function isGlobalBundleSlug(slug: string): boolean {
  return slug.trim().toLowerCase() === GLOBAL_BUNDLE_SLUG;
}

export interface CreateBundleInput {
  readonly slug: string;
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  /** Optional parent path (slash-separated slugs) to nest under. */
  readonly parentPath?: string | undefined;
}

/** A resolved bundle plus the absolute slug path from the root. */
export interface ResolvedBundle {
  readonly bundle: BundleRow;
  readonly path: string;
}

export class BundleService {
  constructor(
    private readonly bundles: BundleRepository,
    private readonly concepts: ConceptRepository,
  ) {}

  get repo(): BundleRepository {
    return this.bundles;
  }

  /** Lists root bundles. */
  async list(): Promise<BundleRow[]> {
    await this.ensureGlobal();
    return this.bundles.listRoots();
  }

  /**
   * Guarantees the reserved `global` root bundle exists, creating it if needed.
   * Idempotent and safe to call on any code path that may touch global.
   */
  async ensureGlobal(): Promise<BundleRow> {
    const existing = await this.bundles.findRootBySlug(GLOBAL_BUNDLE_SLUG);
    if (existing) return existing;
    return this.bundles.insert({
      parentId: null,
      slug: GLOBAL_BUNDLE_SLUG,
      title: "Global",
      description: "Cross-project knowledge: preferences, standards, and shared facts.",
    });
  }

  /**
   * Canonicalizes a slug: trims and lowercases it so bundle addresses are
   * case-insensitive for lookups and case-normalized on write. Any case variant
   * of the reserved global bundle thus collapses to `global` automatically.
   */
  private canonicalRoot(slug: string): string {
    return slug.trim().toLowerCase();
  }

  /**
   * Resolves a slash-separated path of slugs to a bundle, walking the tree from
   * a root. `segments` must be non-empty; the first is a root bundle, the rest
   * are nested child bundles. Throws `BundleNotFoundError` if any segment is
   * missing.
   */
  async resolve(segments: readonly string[]): Promise<ResolvedBundle> {
    if (segments.length === 0) throw new BundleNotFoundError("(empty path)");
    const rootSlug = this.canonicalRoot(segments[0]!);
    if (rootSlug === GLOBAL_BUNDLE_SLUG) await this.ensureGlobal();
    const root = await this.bundles.findRootBySlug(rootSlug);
    if (!root) throw new BundleNotFoundError(segments[0]!);
    let current = root;
    const childSlugs: string[] = [];
    for (let i = 1; i < segments.length; i++) {
      const childSlug = this.canonicalRoot(segments[i]!);
      const child = await this.bundles.findChildBySlug(current.id, childSlug);
      if (!child) throw new BundleNotFoundError(segments.slice(0, i + 1).join("/"));
      current = child;
      childSlugs.push(childSlug);
    }
    return { bundle: current, path: [rootSlug, ...childSlugs].join("/") };
  }

  /**
   * Resolves a path of slugs, creating any missing intermediate (and final)
   * bundles as directory nodes. Used when creating a concept in a directory
   * that does not yet exist. The first segment (root) must already exist.
   */
  async resolveOrCreateChild(
    rootSlug: string,
    childSegments: readonly string[],
  ): Promise<BundleRow> {
    const canonical = this.canonicalRoot(rootSlug);
    if (canonical === GLOBAL_BUNDLE_SLUG) await this.ensureGlobal();
    const root = await this.bundles.findRootBySlug(canonical);
    if (!root) throw new BundleNotFoundError(rootSlug);
    let current = root;
    for (const raw of childSegments) {
      const slug = this.canonicalRoot(raw);
      this.assertSlug(slug);
      const existing = await this.bundles.findChildBySlug(current.id, slug);
      current = existing ?? (await this.bundles.insert({ parentId: current.id, slug }));
    }
    return current;
  }

  private assertSlug(slug: string): void {
    if (!SLUG_RE.test(slug)) {
      throw new OkfValidationError(
        `Slug must be alphanumeric with hyphens, e.g. 'my-bundle' (got '${slug}'). ` +
          "Casing is normalized to lowercase automatically.",
      );
    }
  }

  /** Creates a root bundle, or a child bundle when `parentPath` is given. */
  async create(input: CreateBundleInput): Promise<BundleRow> {
    // The reserved global bundle is managed internally; creating any case
    // variant of it simply returns the canonical, auto-created bundle.
    if (
      isGlobalBundleSlug(input.slug) &&
      (input.parentPath === undefined || input.parentPath.trim() === "")
    ) {
      return this.ensureGlobal();
    }
    const slug = this.canonicalRoot(input.slug);
    this.assertSlug(slug);

    let parentId: string | null = null;
    if (input.parentPath !== undefined && input.parentPath.trim() !== "") {
      const parent = await this.resolve(input.parentPath.split("/").filter(Boolean));
      parentId = parent.bundle.id;
    }

    const existing =
      parentId === null
        ? await this.bundles.findRootBySlug(slug)
        : await this.bundles.findChildBySlug(parentId, slug);
    if (existing) {
      throw new ConflictError(
        `Bundle already exists: ${input.parentPath ? `${input.parentPath}/` : ""}${slug}`,
      );
    }

    return this.bundles.insert({
      parentId,
      slug,
      title: input.title ?? null,
      description: input.description ?? null,
    });
  }

  /** Soft-deletes a bundle subtree (by path) and all concepts within it. */
  async delete(path: string): Promise<void> {
    const segments = path.split("/").filter(Boolean);
    if (segments.length === 1 && isGlobalBundleSlug(segments[0]!)) {
      throw new OkfValidationError(
        "The reserved 'global' bundle cannot be deleted. Delete individual concepts instead.",
      );
    }
    const { bundle } = await this.resolve(segments);
    const deletedBundleIds = await this.bundles.softDeleteSubtree(bundle.id);
    await this.concepts.softDeleteByBundles(deletedBundleIds);
  }
}
