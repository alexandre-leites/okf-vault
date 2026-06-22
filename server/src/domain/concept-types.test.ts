import { describe, it, expect } from "vitest";
import { normalizeConceptType, conceptTypeEquals } from "./concept-types.js";

describe("normalizeConceptType", () => {
  it("normalizes known types to canonical form", () => {
    expect(normalizeConceptType("preference")).toBe("Preference");
    expect(normalizeConceptType("PREFERENCE")).toBe("Preference");
    expect(normalizeConceptType("architecture")).toBe("Architecture");
    expect(normalizeConceptType("environment")).toBe("Environment");
    expect(normalizeConceptType("programming standards")).toBe("Programming Standards");
    expect(normalizeConceptType("workflow procedure")).toBe("Workflow Procedure");
    expect(normalizeConceptType("interaction history")).toBe("Interaction History");
    expect(normalizeConceptType("glossary definition")).toBe("Glossary Definition");
    expect(normalizeConceptType("reference")).toBe("Reference");
    expect(normalizeConceptType("transient state")).toBe("Transient State");
  });

  it("passes through unknown types unchanged", () => {
    expect(normalizeConceptType("CustomType")).toBe("CustomType");
    expect(normalizeConceptType("decision")).toBe("decision");
  });

  it("trims whitespace", () => {
    expect(normalizeConceptType("  preference  ")).toBe("Preference");
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
