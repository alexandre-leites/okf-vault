/**
 * Translates an agent's structured search intent — `must_include` (AND) and
 * `should_include` (OR) keyword arrays — into a single `websearch_to_tsquery`
 * compatible string. This keeps the agent away from raw boolean operator
 * syntax (a common source of parse errors) and lets the backend own the AND/OR
 * logic.
 *
 * websearch_to_tsquery semantics used here:
 *   - space-separated terms  → AND
 *   - the literal token `OR`  → OR
 *   - double quotes          → phrase
 *
 * Because websearch_to_tsquery has no grouping parentheses, we model the query
 * as: every `must_include` term ANDed together, with `should_include` terms
 * appended as an OR-chain to broaden recall without dropping the required
 * terms.
 */

export interface StructuredSearchInput {
  readonly must_include?: readonly string[] | undefined;
  readonly should_include?: readonly string[] | undefined;
  /** Free-text fallback (legacy / direct callers). Used when arrays are absent. */
  readonly text?: string | undefined;
}

export class SearchQuerySyntaxError extends Error {
  constructor(message = "Unable to parse search query") {
    super(message);
    this.name = "SearchQuerySyntaxError";
  }
}

/** Strips characters that would break `websearch_to_tsquery` quoting. */
function sanitizeTerm(raw: string): string {
  return raw.replace(/["()]/g, " ").replace(/\s+/g, " ").trim();
}

/** Wraps a multi-word term in quotes so it is matched as a phrase. */
function asTsTerm(term: string): string {
  return term.includes(" ") ? `"${term}"` : term;
}

/**
 * Builds a `websearch_to_tsquery` string from structured arrays or free text.
 * Returns `undefined` when there is nothing to search on (caller treats this as
 * an unfiltered listing). Throws {@link SearchQuerySyntaxError} when input is
 * present but yields no usable terms (e.g. only punctuation).
 */
export function buildTsQuery(input: StructuredSearchInput): string | undefined {
  const must = (input.must_include ?? []).map(sanitizeTerm).filter(Boolean);
  const should = (input.should_include ?? []).map(sanitizeTerm).filter(Boolean);
  const hasStructured =
    (input.must_include?.length ?? 0) > 0 || (input.should_include?.length ?? 0) > 0;

  if (hasStructured) {
    const parts: string[] = [];
    if (must.length > 0) parts.push(must.map(asTsTerm).join(" "));
    if (should.length > 0) parts.push(should.map(asTsTerm).join(" OR "));
    const query = parts.join(" OR ").trim();
    if (query === "") {
      throw new SearchQuerySyntaxError(
        "Search terms reduced to nothing after sanitization. Simplify your search terms and try again.",
      );
    }
    return query;
  }

  const text = input.text?.trim();
  return text ? text : undefined;
}
