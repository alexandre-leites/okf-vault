import { describe, it, expect } from "vitest";
import {
  OkfVaultError,
  ConceptNotFoundError,
  BundleNotFoundError,
  ConflictError,
  OkfValidationError,
  BundlePathError,
  ReservedConceptIdError,
} from "./errors.js";

describe("OkfVaultError", () => {
  it("is the base error class and sets name correctly", () => {
    const err = new OkfVaultError("base");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("OkfVaultError");
    expect(err.message).toBe("base");
  });
});

describe("ConceptNotFoundError", () => {
  it("formats message with concept id", () => {
    const err = new ConceptNotFoundError("tables/orders");
    expect(err.message).toBe("Concept not found: tables/orders");
    expect(err.conceptId).toBe("tables/orders");
    expect(err.name).toBe("ConceptNotFoundError");
  });
});

describe("BundleNotFoundError", () => {
  it("formats message with bundle slug", () => {
    const err = new BundleNotFoundError("acme-sales");
    expect(err.message).toBe("Bundle not found: acme-sales");
    expect(err.bundleSlug).toBe("acme-sales");
    expect(err.name).toBe("BundleNotFoundError");
  });
});

describe("ConflictError", () => {
  it("passes message through", () => {
    const err = new ConflictError("already exists");
    expect(err.message).toBe("already exists");
    expect(err.name).toBe("ConflictError");
  });

  it("works without message", () => {
    const err = new ConflictError();
    expect(err.message).toBe("");
  });
});

describe("OkfValidationError", () => {
  it("stores optional concept id", () => {
    const err = new OkfValidationError("invalid type", "doc/path");
    expect(err.message).toBe("invalid type");
    expect(err.conceptId).toBe("doc/path");
    expect(err.name).toBe("OkfValidationError");
  });

  it("works without concept id", () => {
    const err = new OkfValidationError("bad value");
    expect(err.conceptId).toBeUndefined();
  });
});

describe("BundlePathError", () => {
  it("is an OkfVaultError", () => {
    const err = new BundlePathError("path outside bundle");
    expect(err).toBeInstanceOf(OkfVaultError);
    expect(err.message).toBe("path outside bundle");
  });
});

describe("ReservedConceptIdError", () => {
  it("formats message with concept id", () => {
    const err = new ReservedConceptIdError("index.md");
    expect(err.message).toBe("Reserved filename cannot be used as a concept: index.md");
    expect(err.conceptId).toBe("index.md");
    expect(err.name).toBe("ReservedConceptIdError");
  });
});
