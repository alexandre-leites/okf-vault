import type { Scope, ScopeContext } from "../domain/okf.js";

/**
 * Well-known directory prefixes that anchor each scope kind.
 *
 * Layout convention:
 *   global/                      → kind = "global"
 *   scopes/<key...>/             → kind = "named", key = full sub-path (e.g. "tech/typescript")
 *   projects/<key>/              → kind = "project", key = project slug
 *   anything else                → falls back to "global" (bundle-root concepts)
 */
const NAMED_PREFIX = "scopes/";
const PROJECT_PREFIX = "projects/";

/**
 * Derives the canonical `Scope` from a concept's bundle-relative ID (its path
 * without the `.md` suffix). Directory layout is authoritative; this function
 * never consults frontmatter.
 *
 * For named scopes, the key is the full sub-path after "scopes/" up to (but not
 * including) the concept's own filename segment. This lets the hierarchy be as
 * deep as needed: scopes/tech/typescript, scopes/network, scopes/linux/kernel.
 */
export function scopeFromId(id: string): Scope {
  if (id.startsWith(NAMED_PREFIX)) {
    const rest = id.slice(NAMED_PREFIX.length);
    const segments = rest.split("/");
    // At least one directory segment beyond the prefix required.
    if (segments.length >= 2) {
      const key = segments.slice(0, -1).join("/");
      if (key) return { kind: "named", key };
    }
  }

  if (id.startsWith(PROJECT_PREFIX)) {
    const rest = id.slice(PROJECT_PREFIX.length);
    const key = rest.split("/")[0];
    if (key) return { kind: "project", key };
  }

  return { kind: "global" };
}

/**
 * Returns true if a concept with the given directory scope (and optional
 * frontmatter scope constraint) should be loaded for the active context.
 *
 * Rules:
 * 1. The directory scope must match the active context (necessary condition).
 * 2. If the frontmatter declares a `scope`, it must also match (sufficient
 *    narrowing — it can only restrict, never broaden).
 */
export function isRelevant(
  directoryScope: Scope,
  frontmatterScope: Scope | undefined,
  context: ScopeContext,
): boolean {
  if (!matchesContext(directoryScope, context)) return false;
  if (frontmatterScope !== undefined) return matchesContext(frontmatterScope, context);
  return true;
}

function matchesContext(scope: Scope, context: ScopeContext): boolean {
  if (scope.kind === "global") return true;
  if (scope.kind === "named") return context.scopes?.includes(scope.key) ?? false;
  if (scope.kind === "project") return context.project === scope.key;
  return false;
}

/**
 * Builds a `ScopeContext` from explicit values. Global memory is always
 * included — every agent sees it regardless of other context fields.
 */
export function buildScopeContext(opts: { scopes?: string[]; project?: string }): ScopeContext {
  return {
    global: true,
    ...(opts.scopes !== undefined && opts.scopes.length > 0 ? { scopes: opts.scopes } : {}),
    ...(opts.project !== undefined ? { project: opts.project } : {}),
  };
}
