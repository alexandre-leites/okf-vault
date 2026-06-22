/**
 * Canonical concept type catalog. Each entry pairs the display label with an
 * agent-facing description so the MCP layer can teach models exactly which type
 * to choose when storing a concept. Custom (non-listed) types are still
 * accepted by the backend — these are the recommended, normalized defaults.
 */
export interface ConceptTypeDef {
  readonly label: string;
  readonly description: string;
}

export const CONCEPT_TYPE_CATALOG: readonly ConceptTypeDef[] = [
  {
    label: "Preference",
    description:
      "Long-term behavioral and structural rules governing how the agent communicates, formats its output, and handles interactions.",
  },
  {
    label: "Architecture",
    description:
      "Core systemic rules, design patterns, framework choices, and structural constraints governing the active codebase or software system.",
  },
  {
    label: "Environment",
    description:
      "Factual documentation regarding the physical, virtual, or cloud infrastructure where systems are deployed and operated.",
  },
  {
    label: "Programming Standards",
    description:
      "Specific coding paradigms, style guidelines, compiler constraints, or syntax rules explicitly tied to a programming language or framework.",
  },
  {
    label: "Workflow Procedure",
    description:
      '"How-to" knowledge bases. Standard procedures, multi-step deployment execution paths, or routine maintenance sequences.',
  },
  {
    label: "Interaction History",
    description:
      "Time-bound logs or historical case summaries of past specific debugging sessions, errors encountered, and how they were resolved.",
  },
  {
    label: "Glossary Definition",
    description:
      "Ubiquitous language dictionary entries, terminology, acronyms, or custom project business logic labels specific to the local context.",
  },
  {
    label: "Reference",
    description:
      "Static, immutable pointer schemas, data allocation tables, network port mappings, or links to external authoritative documentation.",
  },
  {
    label: "Transient State",
    description:
      "Ephemeral, runtime-specific tracking data outlining the immediate progress of a task, an open loop, or a live debugging objective.",
  },
];

const CANONICAL_TYPES = new Map<string, string>(
  CONCEPT_TYPE_CATALOG.map((t) => [t.label.toLowerCase(), t.label]),
);

export function normalizeConceptType(type: string): string {
  const trimmed = type.trim();
  const canonical = CANONICAL_TYPES.get(trimmed.toLowerCase());
  return canonical ?? trimmed;
}

/** A compact, agent-readable bullet list of types + descriptions for schemas. */
export function conceptTypeGuide(): string {
  return CONCEPT_TYPE_CATALOG.map((t) => `- ${t.label}: ${t.description}`).join("\n");
}

export function conceptTypeEquals(left: string, right: string): boolean {
  return normalizeConceptType(left).toLowerCase() === normalizeConceptType(right).toLowerCase();
}
