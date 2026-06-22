import { z } from "zod";

/**
 * The three memory scope kinds. Directory layout is the primary signal;
 * frontmatter `scope` can narrow within a scope (but never broaden it).
 *
 * - global  → vault root, relevant to every agent/project
 * - named   → a named, cross-cutting scope stored under scopes/<key>/
 *             (e.g. scopes/tech/typescript, scopes/network, scopes/linux)
 * - project → tied to one project, stored under projects/<key>/
 */
export const ScopeKindSchema = z.enum(["global", "named", "project"]);
export type ScopeKind = z.infer<typeof ScopeKindSchema>;

/**
 * A concrete scope value. For `global`, `key` is not required.
 * For `named` and `project`, `key` is the sub-path after the prefix
 * (e.g. "tech/typescript", "network", "okf-vault").
 */
export const ScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({ kind: z.literal("named"), key: z.string().min(1) }),
  z.object({ kind: z.literal("project"), key: z.string().min(1) }),
]);
export type Scope = z.infer<typeof ScopeSchema>;

/**
 * The active context an agent brings when querying. The resolver admits
 * any concept whose directory scope is included here.
 *
 * `scopes` is a set of named-scope keys the agent considers active
 * (e.g. ["tech/typescript", "network"]).
 */
export interface ScopeContext {
  readonly global: true;
  readonly scopes?: readonly string[];
  readonly project?: string;
}

/**
 * OKF frontmatter schema (see OKF-FORMAT-SPEC §4.1).
 *
 * `type` is the only required field. Producers may include arbitrary
 * additional keys; consumers MUST preserve them when round-tripping, so the
 * schema is permissive via `.passthrough()`.
 *
 * `scope` is an OKF Vault extension: it narrows relevance within a directory
 * scope. It never overrides the directory — it only restricts further.
 */
export const FrontmatterSchema = z
  .object({
    type: z.string().min(1, "OKF frontmatter requires a non-empty `type` field."),
    title: z.string().optional(),
    description: z.string().optional(),
    resource: z.string().optional(),
    tags: z.array(z.string()).optional(),
    timestamp: z.string().optional(),
    read_count: z.number().int().nonnegative().optional(),
    scope: ScopeSchema.optional(),
  })
  .passthrough();

export type Frontmatter = z.infer<typeof FrontmatterSchema>;

/**
 * A parsed OKF concept document: its bundle-relative ID, resolved scope,
 * frontmatter, and body.
 */
export interface Concept {
  /** Concept ID — file path within the bundle without the `.md` suffix. */
  readonly id: string;
  /** Scope resolved from the concept's directory path. */
  readonly scope: Scope;
  readonly frontmatter: Frontmatter;
  readonly body: string;
}

/** Reserved filenames that must not be used for concept documents (§3.1). */
export const RESERVED_FILENAMES = ["index.md", "log.md"] as const;
export type ReservedFilename = (typeof RESERVED_FILENAMES)[number];

export function isReservedFilename(filename: string): filename is ReservedFilename {
  return (RESERVED_FILENAMES as readonly string[]).includes(filename);
}
