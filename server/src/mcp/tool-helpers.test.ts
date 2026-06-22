import { describe, it, expect } from "vitest";
import { json, resolveConceptAddress, toToolError, runTool } from "./tool-helpers.js";
import {
  BundleNotFoundError,
  ConceptNotFoundError,
  ConflictError,
  OkfValidationError,
  ReservedConceptIdError,
} from "../domain/errors.js";
import { SearchQuerySyntaxError } from "../services/search-query.js";

function parse(result: { content: { type: "text"; text: string }[] }): unknown {
  return JSON.parse(result.content[0]!.text);
}

describe("json", () => {
  it("wraps a value as MCP text content", () => {
    const result = json({ a: 1 });
    expect(result.content[0]!.type).toBe("text");
    expect(parse(result)).toEqual({ a: 1 });
  });
});

describe("resolveConceptAddress", () => {
  it("parses an okf:// link into bundle + path", () => {
    expect(resolveConceptAddress({ link: "okf://memory/preferences/tone" })).toEqual({
      bundle: "memory",
      path: "preferences/tone",
    });
  });

  it("lowercases links (case-insensitive URIs)", () => {
    expect(resolveConceptAddress({ link: "okf://Memory/Guides/Deploy" })).toEqual({
      bundle: "memory",
      path: "guides/deploy",
    });
  });

  it("strips the okf:// scheme case-insensitively", () => {
    expect(resolveConceptAddress({ link: "OKF://a/b" })).toEqual({ bundle: "a", path: "b" });
  });

  it("throws on a link with too few segments", () => {
    expect(() => resolveConceptAddress({ link: "okf://only-bundle" })).toThrow(OkfValidationError);
  });

  it("falls back to explicit bundle + path", () => {
    expect(resolveConceptAddress({ bundle: "b", path: "p" })).toEqual({ bundle: "b", path: "p" });
  });

  it("prefers a non-empty link over bundle/path", () => {
    expect(resolveConceptAddress({ link: "okf://x/y", bundle: "b", path: "p" })).toEqual({
      bundle: "x",
      path: "y",
    });
  });

  it("throws when neither link nor bundle+path provided", () => {
    expect(() => resolveConceptAddress({})).toThrow(OkfValidationError);
    expect(() => resolveConceptAddress({ bundle: "b" })).toThrow(OkfValidationError);
    expect(() => resolveConceptAddress({ link: "   " })).toThrow(OkfValidationError);
  });
});

describe("toToolError", () => {
  it("maps SearchQuerySyntaxError", () => {
    expect(toToolError(new SearchQuerySyntaxError("bad")).error_code).toBe("SEARCH_SYNTAX");
  });

  it("maps ConceptNotFoundError and BundleNotFoundError to NOT_FOUND", () => {
    expect(toToolError(new ConceptNotFoundError("a/b")).error_code).toBe("NOT_FOUND");
    expect(toToolError(new BundleNotFoundError("a")).error_code).toBe("NOT_FOUND");
  });

  it("maps ConflictError", () => {
    expect(toToolError(new ConflictError("dupe")).error_code).toBe("CONFLICT");
  });

  it("maps ReservedConceptIdError", () => {
    expect(toToolError(new ReservedConceptIdError("index")).error_code).toBe("RESERVED_NAME");
  });

  it("maps OkfValidationError", () => {
    expect(toToolError(new OkfValidationError("bad fm")).error_code).toBe("VALIDATION");
  });

  it("maps unknown Error to INTERNAL", () => {
    const env = toToolError(new Error("boom"));
    expect(env.error_code).toBe("INTERNAL");
    expect(env.message).toBe("boom");
  });

  it("maps non-Error throwables to INTERNAL", () => {
    expect(toToolError("oops").message).toBe("oops");
  });

  it("always includes a system_directive", () => {
    expect(toToolError(new ConflictError("x")).system_directive).toBeTruthy();
  });
});

describe("runTool", () => {
  it("returns the handler result on success", async () => {
    const result = await runTool(async () => json({ ok: true }));
    expect(parse(result)).toEqual({ ok: true });
  });

  it("converts a thrown domain error into the uniform envelope", async () => {
    const result = await runTool(async () => {
      throw new ConceptNotFoundError("a/b");
    });
    const data = parse(result) as { status: string; error_code: string };
    expect(data.status).toBe("error");
    expect(data.error_code).toBe("NOT_FOUND");
  });
});
