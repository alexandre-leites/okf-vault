import { describe, it, expect } from "vitest";
import { searchPathsBySubtree } from "./search-service.js";

describe("searchPathsBySubtree", () => {
  const subtree = [
    {
      id: "r1",
      slug: "root",
      parentId: null,
      title: null,
      description: null,
      okfVersion: "0.1",
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    },
    {
      id: "c1",
      slug: "child1",
      parentId: "r1",
      title: null,
      description: null,
      okfVersion: "0.1",
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    },
    {
      id: "c2",
      slug: "child2",
      parentId: "r1",
      title: null,
      description: null,
      okfVersion: "0.1",
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    },
    {
      id: "gc1",
      slug: "grandchild",
      parentId: "c1",
      title: null,
      description: null,
      okfVersion: "0.1",
      createdAt: new Date(),
      updatedAt: new Date(),
      deletedAt: null,
    },
  ];

  it("maps each bundle id to its full slug path from root", () => {
    // @ts-expect-error - we only need id/slug/parentId for this function
    const paths = searchPathsBySubtree(subtree, "root", "root");
    expect(paths.get("r1")).toBe("root");
    expect(paths.get("c1")).toBe("root/child1");
    expect(paths.get("c2")).toBe("root/child2");
    expect(paths.get("gc1")).toBe("root/child1/grandchild");
  });

  it("uses rootPath as the path for the root node", () => {
    // @ts-expect-error - partial BundleRow
    const paths = searchPathsBySubtree(subtree, "root", "custom-root");
    expect(paths.get("r1")).toBe("custom-root");
    expect(paths.get("c1")).toBe("custom-root/child1");
  });

  it("returns empty map when root not found in subtree", () => {
    // @ts-expect-error - partial BundleRow
    const paths = searchPathsBySubtree(subtree, "nonexistent", "root");
    expect(paths.size).toBe(0);
  });
});
