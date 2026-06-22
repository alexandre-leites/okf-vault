import { describe, it, expect } from "vitest";
import { scopeFromId, isRelevant, buildScopeContext } from "./scope-resolver.js";

describe("scopeFromId", () => {
  it("returns global for bundle-root concepts", () => {
    expect(scopeFromId("some-concept")).toEqual({ kind: "global" });
    expect(scopeFromId("global/logging")).toEqual({ kind: "global" });
  });

  it("returns named scope with single-segment key", () => {
    expect(scopeFromId("scopes/network/dns-basics")).toEqual({ kind: "named", key: "network" });
    expect(scopeFromId("scopes/linux/kernel-tuning")).toEqual({ kind: "named", key: "linux" });
  });

  it("returns named scope with multi-segment key (deep hierarchy)", () => {
    expect(scopeFromId("scopes/tech/typescript/async-errors")).toEqual({
      kind: "named",
      key: "tech/typescript",
    });
    expect(scopeFromId("scopes/tech/java/checked-exceptions")).toEqual({
      kind: "named",
      key: "tech/java",
    });
  });

  it("returns project scope with correct key", () => {
    expect(scopeFromId("projects/okf-vault/setup")).toEqual({ kind: "project", key: "okf-vault" });
  });

  it("falls back to global when scopes/ has no concept segment", () => {
    expect(scopeFromId("scopes/")).toEqual({ kind: "global" });
    expect(scopeFromId("scopes/network")).toEqual({ kind: "global" });
  });

  it("falls back to global when double-slash produces empty key", () => {
    expect(scopeFromId("scopes//name")).toEqual({ kind: "global" });
  });

  it("falls back to global when projects/ has no key segment", () => {
    expect(scopeFromId("projects/")).toEqual({ kind: "global" });
  });
});

describe("isRelevant", () => {
  const tsContext = buildScopeContext({
    scopes: ["tech/typescript", "network"],
    project: "my-proj",
  });

  it("global scope is always relevant", () => {
    expect(isRelevant({ kind: "global" }, undefined, tsContext)).toBe(true);
  });

  it("matching named scope is relevant", () => {
    expect(isRelevant({ kind: "named", key: "tech/typescript" }, undefined, tsContext)).toBe(true);
    expect(isRelevant({ kind: "named", key: "network" }, undefined, tsContext)).toBe(true);
  });

  it("non-matching named scope is not relevant", () => {
    expect(isRelevant({ kind: "named", key: "tech/java" }, undefined, tsContext)).toBe(false);
    expect(isRelevant({ kind: "named", key: "linux" }, undefined, tsContext)).toBe(false);
  });

  it("matching project scope is relevant", () => {
    expect(isRelevant({ kind: "project", key: "my-proj" }, undefined, tsContext)).toBe(true);
  });

  it("non-matching project scope is not relevant", () => {
    expect(isRelevant({ kind: "project", key: "other-proj" }, undefined, tsContext)).toBe(false);
  });

  it("frontmatter scope narrows further (matching)", () => {
    expect(
      isRelevant(
        { kind: "named", key: "tech/typescript" },
        { kind: "named", key: "tech/typescript" },
        tsContext,
      ),
    ).toBe(true);
  });

  it("frontmatter scope narrows further (non-matching blocks concept)", () => {
    expect(
      isRelevant(
        { kind: "named", key: "tech/typescript" },
        { kind: "named", key: "tech/java" },
        tsContext,
      ),
    ).toBe(false);
  });

  it("named scope not in context is irrelevant", () => {
    const globalOnly = buildScopeContext({});
    expect(isRelevant({ kind: "named", key: "tech/typescript" }, undefined, globalOnly)).toBe(
      false,
    );
  });

  it("unknown scope kind falls through to false", () => {
    expect(isRelevant({ kind: "global" }, undefined, buildScopeContext({}))).toBe(true);
    // An unrecognized kind hits the final `return false` in matchesContext
    expect(
      isRelevant(
        { kind: "unknown" as "global", key: "x" } as never,
        undefined,
        buildScopeContext({}),
      ),
    ).toBe(false);
  });
});
