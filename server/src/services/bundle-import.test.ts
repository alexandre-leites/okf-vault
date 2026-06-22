import { describe, it, expect } from "vitest";
import { tarEntry, tarEnd } from "./bundle-export.js";
import { parseTar } from "./bundle-import.js";

function buildTar(files: { name: string; content: string }[]): Buffer {
  const chunks: Buffer[] = [];
  for (const f of files) {
    chunks.push(...tarEntry(f.name, f.content));
  }
  chunks.push(tarEnd());
  return Buffer.concat(chunks);
}

describe("parseTar", () => {
  it("reads a single file from a tar archive", () => {
    const tar = buildTar([{ name: "test.md", content: "hello world" }]);
    const files = parseTar(tar);
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe("test.md");
    expect(files[0]!.content.toString()).toBe("hello world");
  });

  it("reads multiple files from a tar archive", () => {
    const tar = buildTar([
      { name: "a.md", content: "aaa" },
      { name: "b.md", content: "bbb" },
    ]);
    const files = parseTar(tar);
    expect(files).toHaveLength(2);
    expect(files[0]!.name).toBe("a.md");
    expect(files[0]!.content.toString()).toBe("aaa");
    expect(files[1]!.name).toBe("b.md");
    expect(files[1]!.content.toString()).toBe("bbb");
  });

  it("returns empty for a zero-block archive (no entries)", () => {
    const tar = tarEnd();
    const files = parseTar(tar);
    expect(files).toHaveLength(0);
  });

  it("handles empty file content", () => {
    const tar = buildTar([{ name: "empty.md", content: "" }]);
    const files = parseTar(tar);
    expect(files).toHaveLength(1);
    expect(files[0]!.content.toString()).toBe("");
  });

  it("parses large file content spanning multiple 512-byte blocks", () => {
    const content = "x".repeat(1024);
    const tar = buildTar([{ name: "large.md", content }]);
    const files = parseTar(tar);
    expect(files).toHaveLength(1);
    expect(files[0]!.content.length).toBe(1024);
  });
});

describe("BundleImportService", () => {
  it("exposes conceptService getter", async () => {
    const svc = {
      create: () => Promise.resolve({} as never),
      read: () => Promise.resolve({} as never),
      createFromMarkdown: () => Promise.resolve({} as never),
      updateFromMarkdown: () => Promise.resolve({} as never),
    };
    const { BundleImportService } = await import("./bundle-import.js");
    const imp = new BundleImportService(svc as never);
    expect(imp.conceptService).toBe(svc);
  });
});

describe("concept path extraction from tar file names", () => {
  it("strips the first directory segment and .md suffix", () => {
    const name = "root/sub/file.md";
    const path = name.replace(/\.md$/, "").replace(/^[^/]+\//, "");
    expect(path).toBe("sub/file");
  });

  it("handles root-level files", () => {
    const name = "root/file.md";
    const path = name.replace(/\.md$/, "").replace(/^[^/]+\//, "");
    expect(path).toBe("file");
  });
});
