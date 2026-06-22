import { ConceptRepository } from "../repository/concept-repository.js";
import { BundleRepository } from "../repository/bundle-repository.js";
import { BundleService } from "./bundle-service.js";
import type { BundleRow } from "../db/schema.js";
import { scopeFromId } from "../domain/scope-resolver.js";
import type { Scope } from "../domain/okf.js";

export interface SearchQuery {
  /** Restrict to a bundle subtree, addressed by slash-separated slugs. */
  readonly bundlePath?: string | undefined;
  readonly text?: string | undefined;
  readonly type?: string | undefined;
  readonly tags?: string[] | undefined;
  readonly scopes?: string[] | undefined;
  readonly project?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
}

const SNIPPET_LENGTH = 200;

export interface SearchResult {
  readonly bundle: string;
  readonly id: string;
  readonly type: string;
  readonly scope: Scope;
  readonly title?: string;
  readonly description?: string;
  readonly tags?: string[];
  readonly snippet?: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export class SearchService {
  constructor(
    private readonly concepts: ConceptRepository,
    private readonly bundles: BundleRepository,
    private readonly bundleService: BundleService,
  ) {}

  async search(query: SearchQuery): Promise<SearchResult[]> {
    let subtree: BundleRow[] | undefined;
    let rootSlug = "";
    let rootPath = "";
    if (query.bundlePath !== undefined) {
      const segments = query.bundlePath.split("/").filter(Boolean);
      const { bundle } = await this.bundleService.resolve(segments);
      subtree = await this.bundles.listSubtree(bundle.id);
      rootSlug = segments[0]!;
      rootPath = segments.join("/");
    }

    const scope =
      (query.scopes && query.scopes.length > 0) || query.project !== undefined
        ? {
            ...(query.scopes !== undefined ? { scopes: query.scopes } : {}),
            ...(query.project !== undefined ? { project: query.project } : {}),
          }
        : undefined;

    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(query.offset ?? 0, 0);

    const rows = await this.concepts.search({
      ...(subtree !== undefined ? { bundleIds: subtree.map((b) => b.id) } : {}),
      ...(query.text !== undefined ? { text: query.text } : {}),
      ...(query.type !== undefined ? { type: query.type } : {}),
      ...(query.tags !== undefined ? { tags: query.tags } : {}),
      ...(scope !== undefined ? { scope } : {}),
      limit,
      offset,
    });

    // Reconstruct each concept's path. With a bundle filter we know the subtree
    // and build absolute paths; scope is derived relative to the root bundle.
    // Without a filter we resolve each concept's bundle chain on demand.
    const pathById =
      subtree !== undefined ? this.pathsBySubtree(subtree, rootSlug, rootPath) : undefined;

    const results: SearchResult[] = [];
    for (const row of rows) {
      let chain: string[];
      if (pathById) {
        chain = (pathById.get(row.bundleId) ?? rootPath).split("/");
      } else {
        chain = await this.bundlePath(row.bundleId);
      }
      const id = [...chain, row.slug].join("/");
      const scopeRel = [...chain.slice(1), row.slug].join("/");
      const headline = row.headline;
      const snippet = headline
        ? headline.replace(/\s+/g, " ").trim()
        : row.body.length > 0
          ? row.body.slice(0, SNIPPET_LENGTH).replace(/\s+/g, " ").trim()
          : undefined;
      results.push({
        bundle: chain[0]!,
        id,
        type: row.type,
        scope: scopeFromId(scopeRel),
        ...(row.title !== null ? { title: row.title } : {}),
        ...(row.description !== null ? { description: row.description } : {}),
        ...(row.tags.length > 0 ? { tags: row.tags } : {}),
        ...(snippet !== undefined ? { snippet } : {}),
      });
    }
    return results;
  }

  /** Resolves a bundle's full slug chain from itself up to its root. */
  private async bundlePath(bundleId: string): Promise<string[]> {
    const chain: string[] = [];
    let current = await this.bundles.findById(bundleId);
    while (current) {
      chain.unshift(current.slug);
      current = current.parentId ? await this.bundles.findById(current.parentId) : undefined;
    }
    return chain;
  }

  pathsBySubtree(subtree: BundleRow[], rootSlug: string, rootPath: string): Map<string, string> {
    return searchPathsBySubtree(subtree, rootSlug, rootPath);
  }
}

/**
 * Builds a map from bundle ID to its full slug path from a root bundle.
 * The root is identified by matching `rootSlug` and having no parent in the
 * subtree (i.e. this is the top-most visible node).
 */
export function searchPathsBySubtree(
  subtree: BundleRow[],
  rootSlug: string,
  rootPath: string,
): Map<string, string> {
  const root = subtree.find(
    (b) => b.slug === rootSlug && !subtree.some((p) => p.id === b.parentId),
  );
  const paths = new Map<string, string>();
  if (!root) return paths;
  paths.set(root.id, rootPath);
  const walk = (id: string, path: string) => {
    for (const child of subtree.filter((b) => b.parentId === id)) {
      const childPath = `${path}/${child.slug}`;
      paths.set(child.id, childPath);
      walk(child.id, childPath);
    }
  };
  walk(root.id, rootPath);
  return paths;
}
