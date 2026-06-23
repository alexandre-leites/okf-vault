import {
  BundleNotFoundError,
  ConceptNotFoundError,
  ConflictError,
  OkfValidationError,
  ReservedConceptIdError,
} from "../domain/errors.js";
import { SearchQuerySyntaxError } from "../services/search-query.js";

/** Wraps a value as an MCP text-content tool result (pretty JSON). */
export function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/**
 * System directive appended to the end of every Read-tool payload (search,
 * get, index, history, links, backlinks). Nudges the agent to persist any
 * newly-established decisions/preferences before ending its response.
 */
export const READ_SYSTEM_DIRECTIVE =
  "\n\n### IMPORTANT SYSTEM DIRECTIVE ###\n" +
  "If the current task is now complete, or if new architectural decisions/preferences were " +
  "established during this query, execute 'okf_concept_upsert' to save them to long-term memory " +
  "before ending your response.";

/**
 * Wraps a Read-tool result as MCP text content and appends the system directive
 * block to the end of the serialized payload (JSON or Markdown).
 */
export function jsonWithDirective(value: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2) + READ_SYSTEM_DIRECTIVE,
      },
    ],
  };
}

/** A concept address: the root bundle slug + the concept path within it. */
export interface ConceptAddress {
  readonly bundle: string;
  readonly path: string;
}

/**
 * Resolves a concept address from either an `okf://` link (as returned by
 * okf_concept_search in the `link` field) or an explicit bundle + path pair.
 * This closes the search→get loop: an agent can pass the search result's
 * `link` straight back into okf_concept_get without re-deriving bundle/path.
 *
 * Accepted forms:
 *   - link: "okf://my-bundle/sub/dir/concept"
 *   - bundle: "my-bundle", path: "sub/dir/concept"
 *   - bundle: "my-bundle/sub/dir", path: "concept"  (both still work downstream)
 */
export function resolveConceptAddress(input: {
  link?: string | undefined;
  bundle?: string | undefined;
  path?: string | undefined;
}): ConceptAddress {
  if (input.link !== undefined && input.link.trim() !== "") {
    // okf:// URIs are case-insensitive; normalize to lowercase so the address
    // matches the lowercase-normalized bundle slugs and concept paths in storage.
    const stripped = input.link
      .trim()
      .toLowerCase()
      .replace(/^okf:\/\//, "");
    const segments = stripped.split("/").filter(Boolean);
    if (segments.length < 2) {
      throw new OkfValidationError(
        `Invalid okf:// link: "${input.link}". Expected "okf://{bundle}/{path}".`,
      );
    }
    const [bundle, ...rest] = segments;
    return { bundle: bundle!, path: rest.join("/") };
  }
  if (
    input.bundle !== undefined &&
    input.bundle.trim() !== "" &&
    input.path !== undefined &&
    input.path.trim() !== ""
  ) {
    return { bundle: input.bundle, path: input.path };
  }
  throw new OkfValidationError(
    "Provide either 'link' (an okf:// URI) or both 'bundle' and 'path'.",
  );
}

/** Stable machine-readable error codes for the uniform tool envelope. */
export type ToolErrorCode =
  | "NOT_FOUND"
  | "CONFLICT"
  | "VALIDATION"
  | "RESERVED_NAME"
  | "SEARCH_SYNTAX"
  | "INTERNAL";

interface ToolErrorEnvelope {
  readonly status: "error";
  readonly error_code: ToolErrorCode;
  readonly message: string;
  readonly system_directive: string;
}

/**
 * Maps a thrown domain error to a uniform, agent-actionable error envelope so
 * every tool fails the same shape: `{status, error_code, message,
 * system_directive}`. The directive tells the agent what to do next instead of
 * leaving it to interpret a raw exception string.
 */
export function toToolError(err: unknown): ToolErrorEnvelope {
  if (err instanceof SearchQuerySyntaxError) {
    return {
      status: "error",
      error_code: "SEARCH_SYNTAX",
      message: err.message,
      system_directive: "Simplify your search terms and try again.",
    };
  }
  if (err instanceof ConceptNotFoundError || err instanceof BundleNotFoundError) {
    return {
      status: "error",
      error_code: "NOT_FOUND",
      message: err.message,
      system_directive:
        "The target does not exist. Call 'okf_concept_search' or 'okf_bundle_index' to find the correct path, or 'okf_concept_upsert' to create it.",
    };
  }
  if (err instanceof ConflictError) {
    return {
      status: "error",
      error_code: "CONFLICT",
      message: err.message,
      system_directive:
        "A concept already exists at this path. Use 'okf_concept_upsert' to update it instead of creating a duplicate.",
    };
  }
  if (err instanceof ReservedConceptIdError) {
    return {
      status: "error",
      error_code: "RESERVED_NAME",
      message: err.message,
      system_directive:
        "This filename is reserved (e.g. index/log). Choose a different concept path.",
    };
  }
  if (err instanceof OkfValidationError) {
    return {
      status: "error",
      error_code: "VALIDATION",
      message: err.message,
      system_directive:
        "The input violates the OKF schema. Fix the reported field and retry. For 'type', pick a value from the documented catalog.",
    };
  }
  return {
    status: "error",
    error_code: "INTERNAL",
    message: err instanceof Error ? err.message : String(err),
    system_directive: "An unexpected error occurred. Verify your arguments and retry.",
  };
}

/**
 * Runs a tool body and converts any thrown domain error into the uniform error
 * envelope (returned as a normal tool result, not an MCP protocol error). This
 * gives agents a consistent, parseable contract across all tools.
 */
export async function runTool(
  fn: () => Promise<{ content: { type: "text"; text: string }[] }>,
): Promise<{ content: { type: "text"; text: string }[] }> {
  try {
    return await fn();
  } catch (err) {
    return json(toToolError(err));
  }
}
