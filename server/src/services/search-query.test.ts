import { describe, it, expect } from "vitest";
import { buildTsQuery, SearchQuerySyntaxError } from "./search-query.js";

describe("buildTsQuery", () => {
  it("returns undefined when no input is provided", () => {
    expect(buildTsQuery({})).toBeUndefined();
    expect(buildTsQuery({ text: "   " })).toBeUndefined();
  });

  it("passes through free text when arrays are absent", () => {
    expect(buildTsQuery({ text: "deploy guide" })).toBe("deploy guide");
  });

  it("ANDs must_include terms", () => {
    expect(buildTsQuery({ must_include: ["postgres", "backup"] })).toBe("postgres backup");
  });

  it("ORs should_include terms", () => {
    expect(buildTsQuery({ should_include: ["redis", "cache"] })).toBe("redis OR cache");
  });

  it("combines must (AND) and should (OR)", () => {
    expect(
      buildTsQuery({ must_include: ["postgres"], should_include: ["backup", "restore"] }),
    ).toBe("postgres OR backup OR restore");
  });

  it("quotes multi-word terms as phrases", () => {
    expect(buildTsQuery({ must_include: ["release process"] })).toBe('"release process"');
  });

  it("prefers structured arrays over free text", () => {
    expect(buildTsQuery({ must_include: ["a"], text: "ignored" })).toBe("a");
  });

  it("throws SearchQuerySyntaxError when terms sanitize to nothing", () => {
    expect(() => buildTsQuery({ must_include: ["()", '"'] })).toThrow(SearchQuerySyntaxError);
  });
});
