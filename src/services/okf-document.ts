import matter from "gray-matter";
import { FrontmatterSchema, type Concept, type Frontmatter } from "../domain/okf.js";
import { OkfValidationError } from "../domain/errors.js";
import { scopeFromId } from "../domain/scope-resolver.js";

/**
 * Parses raw markdown into an OKF concept, validating frontmatter against the
 * spec. Unknown frontmatter keys are preserved (§4.1 Extensions).
 * The concept's `scope` is derived from its directory path (Option B).
 */
export function parseConcept(id: string, raw: string): Concept {
  const { data, content } = matter(raw);
  const result = FrontmatterSchema.safeParse(data);

  if (!result.success) {
    const first = result.error.issues[0];
    const path = first?.path.join(".");
    const issue = first ? `${path ? `${path}: ` : ""}${first.message}` : "invalid frontmatter";
    throw new OkfValidationError(issue, id);
  }

  return {
    id,
    scope: scopeFromId(id),
    frontmatter: result.data,
    body: content.trimStart(),
  };
}

/**
 * Serializes an OKF concept back to a markdown string with YAML frontmatter.
 */
export function serializeConcept(frontmatter: Frontmatter, body: string): string {
  const validated = FrontmatterSchema.parse(frontmatter);
  return matter.stringify(`\n${body.trimStart()}`, validated);
}
