import { describe, it, expect } from "vitest";
import { FrontmatterSchema, isReservedFilename, RESERVED_FILENAMES } from "./okf.js";

describe("FrontmatterSchema", () => {
  it("accepts minimal valid frontmatter (type only)", () => {
    const result = FrontmatterSchema.safeParse({ type: "Note" });
    expect(result.success).toBe(true);
  });

  it("rejects missing type", () => {
    const result = FrontmatterSchema.safeParse({ title: "No Type" });
    expect(result.success).toBe(false);
  });

  it("rejects empty type string", () => {
    const result = FrontmatterSchema.safeParse({ type: "" });
    expect(result.success).toBe(false);
  });

  it("preserves unknown keys (passthrough)", () => {
    const result = FrontmatterSchema.safeParse({
      type: "Metric",
      owner: "data-team",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data["owner"]).toBe("data-team");
    }
  });

  it("accepts all optional fields", () => {
    const result = FrontmatterSchema.safeParse({
      type: "Playbook",
      title: "Deploy",
      description: "How to deploy",
      resource: "https://example.com",
      tags: ["devops"],
      timestamp: "2026-01-01T00:00:00Z",
      read_count: 5,
      scope: { kind: "global" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid scope kind", () => {
    const result = FrontmatterSchema.safeParse({
      type: "Note",
      scope: { kind: "invalid" },
    });
    expect(result.success).toBe(false);
  });
});

describe("isReservedFilename", () => {
  it("returns true for index.md", () => {
    expect(isReservedFilename("index.md")).toBe(true);
  });

  it("returns true for log.md", () => {
    expect(isReservedFilename("log.md")).toBe(true);
  });

  it("returns false for other filenames", () => {
    expect(isReservedFilename("orders.md")).toBe(false);
    expect(isReservedFilename("readme.md")).toBe(false);
    expect(isReservedFilename("index")).toBe(false);
  });

  it("lists reserved filenames", () => {
    expect(RESERVED_FILENAMES).toEqual(["index.md", "log.md"]);
  });
});
