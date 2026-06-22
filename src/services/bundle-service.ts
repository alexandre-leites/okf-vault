import { BundleRepository } from "../repository/bundle-repository.js";
import { ConceptRepository } from "../repository/concept-repository.js";
import type { BundleRow } from "../db/schema.js";
import { BundleNotFoundError, ConflictError, OkfValidationError } from "../domain/errors.js";

const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

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
    return this.bundles.listRoots();
  }

  /**
   * Resolves a slash-separated path of slugs to a bundle, walking the tree from
   * a root. `segments` must be non-empty; the first is a root bundle, the rest
   * are nested child bundles. Throws `BundleNotFoundError` if any segment is
   * missing.
   */
  async resolve(segments: readonly string[]): Promise<ResolvedBundle> {
    if (segments.length === 0) throw new BundleNotFoundError("(empty path)");
    const root = await this.bundles.findRootBySlug(segments[0]!);
    if (!root) throw new BundleNotFoundError(segments[0]!);
    let current = root;
    for (let i = 1; i < segments.length; i++) {
      const child = await this.bundles.findChildBySlug(current.id, segments[i]!);
      if (!child) throw new BundleNotFoundError(segments.slice(0, i + 1).join("/"));
      current = child;
    }
    return { bundle: current, path: segments.join("/") };
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
    const root = await this.bundles.findRootBySlug(rootSlug);
    if (!root) throw new BundleNotFoundError(rootSlug);
    let current = root;
    for (const slug of childSegments) {
      this.assertSlug(slug);
      const existing = await this.bundles.findChildBySlug(current.id, slug);
      current = existing ?? (await this.bundles.insert({ parentId: current.id, slug }));
    }
    return current;
  }

  private assertSlug(slug: string): void {
    if (!SLUG_RE.test(slug)) {
      throw new OkfValidationError(
        `Slug must be lowercase alphanumeric with hyphens (got '${slug}').`,
      );
    }
  }

  /** Creates a root bundle, or a child bundle when `parentPath` is given. */
  async create(input: CreateBundleInput): Promise<BundleRow> {
    this.assertSlug(input.slug);

    let parentId: string | null = null;
    if (input.parentPath !== undefined && input.parentPath.trim() !== "") {
      const parent = await this.resolve(input.parentPath.split("/").filter(Boolean));
      parentId = parent.bundle.id;
    }

    const existing =
      parentId === null
        ? await this.bundles.findRootBySlug(input.slug)
        : await this.bundles.findChildBySlug(parentId, input.slug);
    if (existing) {
      throw new ConflictError(
        `Bundle already exists: ${input.parentPath ? `${input.parentPath}/` : ""}${input.slug}`,
      );
    }

    return this.bundles.insert({
      parentId,
      slug: input.slug,
      title: input.title ?? null,
      description: input.description ?? null,
    });
  }

  /** Soft-deletes a bundle subtree (by path) and all concepts within it. */
  async delete(path: string): Promise<void> {
    const { bundle } = await this.resolve(path.split("/").filter(Boolean));
    const deletedBundleIds = await this.bundles.softDeleteSubtree(bundle.id);
    await this.concepts.softDeleteByBundles(deletedBundleIds);
  }
}
