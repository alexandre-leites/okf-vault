import { describe, it, expect } from "vitest";
import { createGunzip } from "node:zlib";
import { tarHeader, tarEntry, tarEnd, safeName, bundlePaths } from "./bundle-export.js";

describe("tarHeader", () => {
  it("produces a 512-byte buffer with correct fields", () => {
    const buf = tarHeader("hello.txt", 100);
    expect(buf.length).toBe(512);

    const name = buf.toString("ascii", 0, 100).replace(/\0.*$/, "");
    expect(name).toBe("hello.txt");

    const size = parseInt(buf.toString("ascii", 124, 135).trim(), 8);
    expect(size).toBe(100);

    const magic = buf.toString("ascii", 257, 262);
    expect(magic).toBe("ustar");
  });

  it("handles long names with @LongLink prefix", () => {
    const longName = "a".repeat(120);
    const buf = tarHeader(longName, 0);
    const name = buf.toString("ascii", 0, 100).replace(/\0.*$/, "");
    expect(name).toBe("././@LongLink");
  });
});

describe("tarEntry", () => {
  it("returns header + padded content (header[0]=512, content padded to 512 blocks)", () => {
    const [header, content] = tarEntry("test.txt", "hello world");
    expect(header.length).toBe(512);
    const storedSize = parseInt(header.toString("ascii", 124, 135).trim(), 8);
    expect(storedSize).toBe(11);
    expect(content.length).toBe(512);
    expect(content.subarray(0, 11).toString()).toBe("hello world");
  });

  it("pads empty content to 512 bytes", () => {
    const [, content] = tarEntry("empty.txt", "");
    expect(content.length).toBe(0);
  });
});

describe("tarEnd", () => {
  it("returns 1024 zero bytes (two end-of-archive blocks)", () => {
    const end = tarEnd();
    expect(end.length).toBe(1024);
    expect(end.every((b) => b === 0)).toBe(true);
  });
});

describe("safeName", () => {
  it("joins segments with posix separator, sanitizing special chars", () => {
    expect(safeName(["root", "sub", "file.md"])).toBe("root/sub/file.md");
  });

  it("replaces unsafe characters with underscores", () => {
    expect(safeName(["bad:name", "a b"])).toBe("bad_name/a_b");
  });
});

describe("bundlePaths", () => {
  const bundles = [
    { id: "r1", slug: "root", parentId: null },
    { id: "c1", slug: "child1", parentId: "r1" },
    { id: "c2", slug: "child2", parentId: "r1" },
    { id: "gc1", slug: "grandchild", parentId: "c1" },
  ];

  it("maps each bundle id to its full slug path from root", () => {
    const paths = bundlePaths("root", bundles);
    expect(paths.get("r1")).toBe("root");
    expect(paths.get("c1")).toBe("root/child1");
    expect(paths.get("c2")).toBe("root/child2");
    expect(paths.get("gc1")).toBe("root/child1/grandchild");
  });

  it("returns empty map when root not found in subtree", () => {
    const paths = bundlePaths("nonexistent", bundles);
    expect(paths.size).toBe(0);
  });
});

describe("tar gzip round-trip", () => {
  it("gzipped tar can be decompressed and parsed", async () => {
    const { createGzip } = await import("node:zlib");

    // Build a tar in memory
    const chunks: Buffer[] = [];
    chunks.push(...tarEntry("test.md", "# Hello\nbody\n"));
    chunks.push(tarEnd());
    const rawTar = Buffer.concat(chunks);

    // Gzip it
    const gz = await new Promise<Buffer>((resolve, reject) => {
      const gzipper = createGzip();
      const out: Buffer[] = [];
      gzipper.on("data", (c: Buffer) => out.push(c));
      gzipper.on("end", () => resolve(Buffer.concat(out)));
      gzipper.on("error", reject);
      gzipper.write(rawTar);
      gzipper.end();
    });

    // Decompress
    const decompressed = await new Promise<Buffer>((resolve, reject) => {
      const gunzip = createGunzip();
      const out: Buffer[] = [];
      gunzip.on("data", (c: Buffer) => out.push(c));
      gunzip.on("end", () => resolve(Buffer.concat(out)));
      gunzip.on("error", reject);
      gunzip.write(gz);
      gunzip.end();
    });

    // Parse the tar
    const { parseTar } = await import("./bundle-import.js");
    const files = parseTar(decompressed);
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe("test.md");
    expect(files[0]!.content.toString()).toBe("# Hello\nbody\n");
  });
});
