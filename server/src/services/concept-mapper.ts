import type { Concept, Frontmatter, Scope } from "../domain/okf.js";
import type { ConceptRow, NewConceptRow } from "../db/schema.js";
import { scopeFromId } from "../domain/scope-resolver.js";
import { serializeConcept } from "./okf-document.js";

/** Resolves the structured scope columns from a Scope value. */
export function scopeColumns(scope: Scope): { scopeKind: string; scopeKey: string | null } {
  return scope.kind === "global"
    ? { scopeKind: "global", scopeKey: null }
    : { scopeKind: scope.kind, scopeKey: scope.key };
}

/** Reconstructs a Scope value from the structured columns. */
export function scopeFromColumns(scopeKind: string, scopeKey: string | null): Scope {
  if (scopeKind === "named" && scopeKey) return { kind: "named", key: scopeKey };
  if (scopeKind === "project" && scopeKey) return { kind: "project", key: scopeKey };
  return { kind: "global" };
}

/**
 * Projects the full frontmatter (structured columns merged with the JSONB
 * extension bag) for a concept row, keeping the DB the source of truth for the
 * structured fields while preserving producer-defined keys.
 */
export function rowFrontmatter(row: ConceptRow): Frontmatter {
  return {
    ...row.frontmatter,
    type: row.type,
    ...(row.title !== null ? { title: row.title } : {}),
    ...(row.description !== null ? { description: row.description } : {}),
    ...(row.resource !== null ? { resource: row.resource } : {}),
    ...(row.tags.length > 0 ? { tags: row.tags } : {}),
    read_count: row.readCount,
    ...(!("timestamp" in row.frontmatter) || row.frontmatter.timestamp === undefined
      ? { timestamp: row.updatedAt.toISOString() }
      : {}),
  };
}

/**
 * Maps a concept row to the in-memory OKF Concept model. `path` is the
 * concept's full bundle-relative path (e.g. `tables/orders`), resolved by the
 * service from the bundle tree, since the row itself stores only its `slug`.
 */
export function rowToConcept(row: ConceptRow, path: string): Concept {
  return {
    id: path,
    scope: scopeFromId(path),
    frontmatter: rowFrontmatter(row),
    body: row.body,
  };
}

/** Renders a concept row as an OKF markdown document (frontmatter + body). */
export function rowToMarkdown(row: ConceptRow): string {
  return serializeConcept(rowFrontmatter(row), row.body);
}

/**
 * Builds the structured insert/update columns for a concept attached to
 * `bundleId` with the given `slug`. Scope is derived from the concept's full
 * bundle-relative `path`. The full frontmatter is retained in the JSONB bag.
 */
export function conceptToColumns(
  bundleId: string,
  slug: string,
  path: string,
  frontmatter: Frontmatter,
  body: string,
): Omit<NewConceptRow, "id" | "createdAt" | "updatedAt" | "deletedAt" | "readCount"> {
  const scope = scopeFromId(path);
  const { scopeKind, scopeKey } = scopeColumns(scope);
  const tags = Array.isArray(frontmatter.tags) ? frontmatter.tags : [];
  return {
    bundleId,
    slug,
    type: frontmatter.type,
    title: frontmatter.title ?? null,
    description: frontmatter.description ?? null,
    resource: frontmatter.resource ?? null,
    tags,
    scopeKind,
    scopeKey,
    frontmatter,
    body,
  };
}
