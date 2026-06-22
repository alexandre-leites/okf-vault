import yaml from "js-yaml";
import { FrontmatterSchema, type Concept, type Frontmatter } from "../domain/okf.js";
import { OkfValidationError } from "../domain/errors.js";
import { scopeFromId } from "../domain/scope-resolver.js";

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * Parses raw markdown into an OKF concept, validating frontmatter against the
 * spec. Unknown frontmatter keys are preserved (§4.1 Extensions).
 * The concept's `scope` is derived from its directory path (Option B).
 */
export function parseConcept(id: string, raw: string): Concept {
  const { data, content } = parseFrontmatter(raw);
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
  return `---\n${yaml.dump(validated).trimEnd()}\n---\n${body.trimStart()}`;
}

function parseFrontmatter(raw: string): { data: Record<string, unknown>; content: string } {
  const match = FM_RE.exec(raw);
  if (!match) {
    return { data: {}, content: raw };
  }
  const yamlStr = match[1]?.trim() ?? "";
  const data = yamlStr
    ? (yaml.load(yamlStr, { schema: yaml.CORE_SCHEMA }) as Record<string, unknown>)
    : {};
  const content = raw.slice(match[0].length);
  return { data, content };
}
