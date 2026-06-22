import { ConceptRepository } from "../repository/concept-repository.js";
import { BundleRepository } from "../repository/bundle-repository.js";
import { BundleService, GLOBAL_BUNDLE_SLUG, isGlobalBundleSlug } from "./bundle-service.js";
import type { BundleRow } from "../db/schema.js";
import { scopeFromId } from "../domain/scope-resolver.js";
import type { Scope } from "../domain/okf.js";
import { buildTsQuery } from "./search-query.js";

export interface SearchQuery {
  /** Restrict to a bundle subtree, addressed by slash-separated slugs. */
  readonly bundlePath?: string | undefined;
  /** Free-text query (legacy/direct). Ignored when structured arrays are set. */
  readonly text?: string | undefined;
  /** Structured AND keywords (all must match). */
  readonly must_include?: string[] | undefined;
  /** Structured OR keywords (broaden recall). */
  readonly should_include?: string[] | undefined;
  readonly type?: string | undefined;
  readonly tags?: string[] | undefined;
  readonly scopes?: string[] | undefined;
  readonly project?: string | undefined;
  readonly limit?: number | undefined;
  readonly offset?: number | undefined;
  /**
   * When a specific `bundlePath` is set, also include matches from the reserved
   * `global` bundle. Defaults to true. Ignored when no `bundlePath` is given
   * (an unscoped search already spans everything) or when the target IS global.
   * Bundle-local matches are ranked ahead of global matches.
   */
  readonly includeGlobal?: boolean | undefined;
}

const SNIPPET_LENGTH = 200;

export interface SearchResult {
  readonly bundle: string;
  readonly id: string;
  /** Stable `okf://` URI to pass to okf_concept_get for full hydration. */
  readonly link: string;
  readonly type: string;
  readonly scope: Scope;
  readonly title?: string;
  readonly description?: string;
  readonly tags?: string[];
  /** Capped (~200 char) preview only. The full body is NEVER returned here. */
  readonly snippet?: string;
}

/** Clamps a snippet to the preview length on a word boundary where possible. */
function clampSnippet(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= SNIPPET_LENGTH) return collapsed;
  const slice = collapsed.slice(0, SNIPPET_LENGTH);
  const lastSpace = slice.lastIndexOf(" ");
  return `${(lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trimEnd()}\u2026`;
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
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(query.offset ?? 0, 0);

    // Unscoped search already spans every bundle (including global) in one pass.
    if (query.bundlePath === undefined) {
      return this.searchScope(query, undefined, limit, offset);
    }

    const segments = query.bundlePath.split("/").filter(Boolean);
    const primary = await this.searchScope(query, segments, limit, offset);

    // Decide whether to fold in the reserved global bundle. Default: yes.
    const includeGlobal = query.includeGlobal ?? true;
    const targetIsGlobal = isGlobalBundleSlug(segments[0] ?? "");
    if (!includeGlobal || targetIsGlobal) return primary;

    const globalResults = await this.searchScope(query, [GLOBAL_BUNDLE_SLUG], limit, offset);

    // Bundle-local matches rank ahead of global; de-dupe by concept id and cap.
    const seen = new Set(primary.map((r) => r.id));
    const merged = [...primary];
    for (const r of globalResults) {
      if (!seen.has(r.id)) {
        seen.add(r.id);
        merged.push(r);
      }
    }
    return merged.slice(0, limit);
  }

  /**
   * Runs a single ranked search, optionally scoped to the subtree addressed by
   * `segments` (the first is a root bundle). Maps rows to lightweight results.
   */
  private async searchScope(
    query: SearchQuery,
    segments: string[] | undefined,
    limit: number,
    offset: number,
  ): Promise<SearchResult[]> {
    let subtree: BundleRow[] | undefined;
    let rootSlug = "";
    let rootPath = "";
    if (segments !== undefined) {
      const { bundle, path } = await this.bundleService.resolve(segments);
      subtree = await this.bundles.listSubtree(bundle.id);
      rootPath = path;
      rootSlug = path.split("/")[0]!;
    }

    const scope =
      (query.scopes && query.scopes.length > 0) || query.project !== undefined
        ? {
            ...(query.scopes !== undefined ? { scopes: query.scopes } : {}),
            ...(query.project !== undefined ? { project: query.project } : {}),
          }
        : undefined;

    const tsText = buildTsQuery({
      ...(query.must_include !== undefined ? { must_include: query.must_include } : {}),
      ...(query.should_include !== undefined ? { should_include: query.should_include } : {}),
      ...(query.text !== undefined ? { text: query.text } : {}),
    });

    const rows = await this.concepts.search({
      ...(subtree !== undefined ? { bundleIds: subtree.map((b) => b.id) } : {}),
      ...(tsText !== undefined ? { text: tsText } : {}),
      ...(query.type !== undefined ? { type: query.type } : {}),
      ...(query.tags !== undefined ? { tags: query.tags } : {}),
      ...(scope !== undefined ? { scope } : {}),
      limit,
      offset,
    });

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
      const rawSnippet = headline ? headline : row.body.length > 0 ? row.body : undefined;
      const snippet = rawSnippet !== undefined ? clampSnippet(rawSnippet) : undefined;
      results.push({
        bundle: chain[0]!,
        id,
        link: `okf://${id}`,
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
