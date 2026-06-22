import { describe, it, expect } from "vitest";
import { normalizeConceptPath, splitConceptPath } from "./concept-service.js";
import { OkfValidationError } from "../domain/errors.js";

describe("normalizeConceptPath", () => {
  it("strips .md suffix and leading slashes", () => {
    expect(normalizeConceptPath("tables/orders.md")).toBe("tables/orders");
    expect(normalizeConceptPath("/tables/orders.md")).toBe("tables/orders");
    expect(normalizeConceptPath("tables/orders")).toBe("tables/orders");
  });

  it("handles bundle-root concepts", () => {
    expect(normalizeConceptPath("logging.md")).toBe("logging");
  });

  it("rejects traversal and empty paths", () => {
    expect(() => normalizeConceptPath("../escape.md")).toThrow(OkfValidationError);
    expect(() => normalizeConceptPath("a/../../escape")).toThrow(OkfValidationError);
    expect(() => normalizeConceptPath(".md")).toThrow(OkfValidationError);
  });
});

describe("splitConceptPath", () => {
  it("splits a simple path into dirs and slug", () => {
    const s = splitConceptPath("tables/orders.md");
    expect(s.dirs).toEqual(["tables"]);
    expect(s.slug).toBe("orders");
    expect(s.full).toBe("tables/orders");
  });

  it("splits a deep path", () => {
    const s = splitConceptPath("a/b/c/concept.md");
    expect(s.dirs).toEqual(["a", "b", "c"]);
    expect(s.slug).toBe("concept");
    expect(s.full).toBe("a/b/c/concept");
  });

  it("handles bundle-root concept (no dirs)", () => {
    const s = splitConceptPath("logging.md");
    expect(s.dirs).toEqual([]);
    expect(s.slug).toBe("logging");
    expect(s.full).toBe("logging");
  });

  it("rejects empty path after normalization", () => {
    expect(() => splitConceptPath("")).toThrow(OkfValidationError);
  });
});
