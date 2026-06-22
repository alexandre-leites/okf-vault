import { describe, it, expect } from "vitest";
import {
  scopeColumns,
  scopeFromColumns,
  conceptToColumns,
  rowFrontmatter,
} from "./concept-mapper.js";
import type { ConceptRow } from "../db/schema.js";

describe("scope columns", () => {
  it("maps global scope to null key", () => {
    expect(scopeColumns({ kind: "global" })).toEqual({ scopeKind: "global", scopeKey: null });
  });
  it("maps named/project scope to their key", () => {
    expect(scopeColumns({ kind: "named", key: "tech/typescript" })).toEqual({
      scopeKind: "named",
      scopeKey: "tech/typescript",
    });
    expect(scopeColumns({ kind: "project", key: "okf-vault" })).toEqual({
      scopeKind: "project",
      scopeKey: "okf-vault",
    });
  });
  it("round-trips through scopeFromColumns", () => {
    expect(scopeFromColumns("named", "network")).toEqual({ kind: "named", key: "network" });
    expect(scopeFromColumns("project", "p")).toEqual({ kind: "project", key: "p" });
    expect(scopeFromColumns("global", null)).toEqual({ kind: "global" });
    expect(scopeFromColumns("named", null)).toEqual({ kind: "global" });
  });
});

describe("conceptToColumns", () => {
  it("derives scope from the concept path and extracts structured fields", () => {
    const cols = conceptToColumns(
      "bundle-1",
      "async",
      "scopes/tech/typescript/async",
      { type: "Playbook", title: "Async", description: "d", tags: ["errors"] },
      "# Async\n",
    );
    expect(cols.scopeKind).toBe("named");
    expect(cols.scopeKey).toBe("tech/typescript");
    expect(cols.type).toBe("Playbook");
    expect(cols.title).toBe("Async");
    expect(cols.tags).toEqual(["errors"]);
    expect(cols.body).toBe("# Async\n");
  });

  it("defaults tags to an empty array and missing fields to null", () => {
    const cols = conceptToColumns("b", "x", "global/x", { type: "Reference" }, "body");
    expect(cols.tags).toEqual([]);
    expect(cols.title).toBeNull();
    expect(cols.description).toBeNull();
    expect(cols.resource).toBeNull();
    expect(cols.scopeKind).toBe("global");
    expect(cols.scopeKey).toBeNull();
  });
});

describe("rowFrontmatter", () => {
  it("merges structured columns over the JSONB extension bag", () => {
    const row: ConceptRow = {
      id: "id",
      bundleId: "b",
      slug: "orders",
      type: "BigQuery Table",
      title: "Orders",
      description: null,
      resource: "bq://x",
      tags: ["sales"],
      scopeKind: "global",
      scopeKey: null,
      frontmatter: { type: "BigQuery Table", owner: "data-team" },
      body: "# Schema\n",
      version: 1,
      readCount: 3,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-02-02T00:00:00Z"),
      deletedAt: null,
    };
    const fm = rowFrontmatter(row);
    expect(fm.type).toBe("BigQuery Table");
    expect(fm.title).toBe("Orders");
    expect(fm.resource).toBe("bq://x");
    expect(fm.tags).toEqual(["sales"]);
    expect(fm.read_count).toBe(3);
    expect(fm.timestamp).toBe("2026-02-02T00:00:00.000Z");
    expect(fm["owner"]).toBe("data-team");
    expect(fm.description).toBeUndefined();
  });
});

describe("rowToConcept", () => {
  it("builds concept domain model from a row", async () => {
    const { rowToConcept } = await import("./concept-mapper.js");
    const row: ConceptRow = {
      id: "id",
      bundleId: "b",
      slug: "orders",
      type: "BigQuery Table",
      title: "Orders",
      description: null,
      resource: "bq://x",
      tags: ["sales"],
      scopeKind: "global",
      scopeKey: null,
      frontmatter: { type: "BigQuery Table", owner: "data-team" },
      body: "# Schema\n",
      version: 3,
      readCount: 5,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-02-02T00:00:00Z"),
      deletedAt: null,
    };
    const concept = rowToConcept(row, "orders");
    expect(concept.id).toBe("orders");
    expect(concept.frontmatter.type).toBe("BigQuery Table");
    expect(concept.frontmatter.read_count).toBe(5);
    expect(concept.body).toBe("# Schema\n");
  });
});

describe("rowToMarkdown", () => {
  it("serializes a row to OKF markdown", async () => {
    const { rowToMarkdown } = await import("./concept-mapper.js");
    const row: ConceptRow = {
      id: "id",
      bundleId: "b",
      slug: "test",
      type: "Note",
      title: "Test",
      description: "desc",
      resource: null,
      tags: [],
      scopeKind: "global",
      scopeKey: null,
      frontmatter: { type: "Note", title: "Test", description: "desc" },
      body: "# Test\nBody\n",
      version: 1,
      readCount: 0,
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-02-02T00:00:00Z"),
      deletedAt: null,
    };
    const md = rowToMarkdown(row);
    expect(md).toContain("type: Note");
    expect(md).toContain("title: Test");
    expect(md).toContain("# Test\nBody");
  });
});
