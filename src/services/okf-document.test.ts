import { describe, it, expect } from "vitest";
import { parseConcept, serializeConcept } from "./okf-document.js";
import { OkfValidationError } from "../domain/errors.js";
import { FrontmatterSchema } from "../domain/okf.js";

describe("parseConcept", () => {
  it("parses frontmatter and body", () => {
    const raw = ["---", "type: Metric", "title: Revenue", "---", "", "# Revenue", ""].join("\n");
    const concept = parseConcept("metrics/revenue", raw);
    expect(concept.id).toBe("metrics/revenue");
    expect(concept.frontmatter.type).toBe("Metric");
    expect(concept.frontmatter.title).toBe("Revenue");
    expect(concept.body).toBe("# Revenue\n");
  });

  it("derives global scope for bundle-root concepts", () => {
    const raw = ["---", "type: Reference", "---", "body"].join("\n");
    expect(parseConcept("some-concept", raw).scope).toEqual({ kind: "global" });
  });

  it("derives named scope from scopes/ directory path", () => {
    const raw = ["---", "type: Reference", "---", "body"].join("\n");
    expect(parseConcept("scopes/tech/typescript/async", raw).scope).toEqual({
      kind: "named",
      key: "tech/typescript",
    });
  });

  it("derives project scope from directory path", () => {
    const raw = ["---", "type: Playbook", "---", "body"].join("\n");
    expect(parseConcept("projects/okf-vault/setup", raw).scope).toEqual({
      kind: "project",
      key: "okf-vault",
    });
  });

  it("preserves unknown frontmatter keys", () => {
    const raw = ["---", "type: Metric", "owner: data-team", "---", "body"].join("\n");
    const concept = parseConcept("x", raw);
    expect(concept.frontmatter["owner"]).toBe("data-team");
  });

  it("rejects documents without a type", () => {
    const raw = ["---", "title: No Type", "---", "body"].join("\n");
    expect(() => parseConcept("x", raw)).toThrow(OkfValidationError);
  });

  it("rejects documents with empty type", () => {
    const raw = ["---", "type:", "---", "body"].join("\n");
    expect(() => parseConcept("x", raw)).toThrow(OkfValidationError);
  });

  it("handles validation error with root-level issue path", () => {
    // When safeParse receives a non-object, the issue path is [] → "" → falsy
    const result = FrontmatterSchema.safeParse(42);
    expect(result.success).toBe(false);
    expect(result.error.issues[0]!.path).toEqual([]);
  });

  it("throws with a root-level (path-less) message when frontmatter is a scalar", () => {
    // A bare YAML scalar document → gray-matter yields a non-object `data`,
    // so the validation issue has an empty path → exercises the falsy branch.
    const raw = ["---", "42", "---", "body"].join("\n");
    expect(() => parseConcept("x", raw)).toThrow(OkfValidationError);
  });
});

describe("serializeConcept", () => {
  it("round-trips a concept", () => {
    const out = serializeConcept({ type: "Reference", title: "Doc" }, "# Doc\n");
    const concept = parseConcept("doc", out);
    expect(concept.frontmatter.type).toBe("Reference");
    expect(concept.frontmatter.title).toBe("Doc");
    expect(concept.body).toBe("# Doc\n");
  });
});
