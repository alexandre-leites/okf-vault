import { describe, it, expect } from "vitest";
import { normalizeConceptType, conceptTypeEquals } from "./concept-types.js";

describe("normalizeConceptType", () => {
  it("normalizes known types to canonical form", () => {
    expect(normalizeConceptType("playbook")).toBe("Playbook");
    expect(normalizeConceptType("PLAYBOOK")).toBe("Playbook");
    expect(normalizeConceptType("reference")).toBe("Reference");
    expect(normalizeConceptType("metric")).toBe("Metric");
    expect(normalizeConceptType("api endpoint")).toBe("API Endpoint");
    expect(normalizeConceptType("bigquery table")).toBe("BigQuery Table");
    expect(normalizeConceptType("bigquery dataset")).toBe("BigQuery Dataset");
  });

  it("passes through unknown types unchanged", () => {
    expect(normalizeConceptType("CustomType")).toBe("CustomType");
    expect(normalizeConceptType("decision")).toBe("decision");
  });

  it("trims whitespace", () => {
    expect(normalizeConceptType("  playbook  ")).toBe("Playbook");
  });
});

describe("conceptTypeEquals", () => {
  it("compares types case-insensitively after normalization", () => {
    expect(conceptTypeEquals("playbook", "Playbook")).toBe(true);
    expect(conceptTypeEquals("PLAYBOOK", "playbook")).toBe(true);
    expect(conceptTypeEquals("reference", "Playbook")).toBe(false);
    expect(conceptTypeEquals("Custom", "custom")).toBe(true);
  });
});
