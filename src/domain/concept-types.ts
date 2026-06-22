const CANONICAL_TYPES = new Map<string, string>([
  ["api endpoint", "API Endpoint"],
  ["bigquery dataset", "BigQuery Dataset"],
  ["bigquery table", "BigQuery Table"],
  ["metric", "Metric"],
  ["playbook", "Playbook"],
  ["reference", "Reference"],
]);

export function normalizeConceptType(type: string): string {
  const trimmed = type.trim();
  const canonical = CANONICAL_TYPES.get(trimmed.toLowerCase());
  return canonical ?? trimmed;
}

export function conceptTypeEquals(left: string, right: string): boolean {
  return normalizeConceptType(left).toLowerCase() === normalizeConceptType(right).toLowerCase();
}
