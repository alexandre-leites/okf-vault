import { posix } from "node:path";
import { createGzip } from "node:zlib";
import { Readable } from "node:stream";
import { BundleRepository } from "../repository/bundle-repository.js";
import { ConceptRepository } from "../repository/concept-repository.js";
import { rowToMarkdown } from "./concept-mapper.js";
import { pathsBySubtree } from "./paths-by-subtree.js";

export function tarHeader(name: string, size: number): Buffer {
  const buf = Buffer.alloc(512, 0);
  const fileName = name.length > 100 ? `././@LongLink` : name;
  buf.write(fileName, 0, fileName.length, "ascii");
  buf.write("000644 ", 100, 7, "ascii");
  buf.write("0000000 ", 108, 8, "ascii");
  buf.write("0000000 ", 116, 8, "ascii");
  const sizeStr = size.toString(8).padStart(11, "0");
  buf.write(sizeStr, 124, 11, "ascii");
  const now = Math.floor(Date.now() / 1000);
  const mtime = now.toString(8).padStart(11, "0");
  buf.write(mtime, 136, 11, "ascii");
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += buf[i] ?? 0;
  const chk = checksum.toString(8).padStart(6, "0");
  buf.write(chk, 148, 6, "ascii");
  buf[154] = 0x20;
  buf[155] = 0x00;
  buf.write("ustar", 257, 5, "ascii");
  buf.write("00", 263, 2, "ascii");
  return buf;
}

export function tarEntry(name: string, content: string): Buffer[] {
  const data = Buffer.from(content, "utf-8");
  const header = tarHeader(name, data.length);
  const padded = Buffer.alloc(Math.ceil(data.length / 512) * 512, 0);
  data.copy(padded);
  return [header, padded];
}

export function tarEnd(): Buffer {
  return Buffer.alloc(1024, 0);
}

export function safeName(segments: string[]): string {
  return posix.join(...segments.map((s) => s.replace(/[^a-zA-Z0-9_\-.~/]/g, "_")));
}

export class BundleExportService {
  constructor(
    private readonly bundleRepo: BundleRepository,
    private readonly conceptRepo: ConceptRepository,
  ) {}

  async exportStream(rootSlug: string): Promise<Readable> {
    const root = await this.bundleRepo.findRootBySlug(rootSlug);
    if (!root) {
      const { PassThrough } = await import("node:stream");
      const pt = new PassThrough();
      pt.on("error", () => {}); // suppress
      pt.end(); // End immediately (no data)
      return pt;
    }
    const subtree = await this.bundleRepo.listSubtree(root.id);
    const pathMap = pathsBySubtree(root.slug, subtree);
    const conceptRepo = this.conceptRepo;
    async function* generate() {
      for (const bundle of subtree) {
        const dir = pathMap.get(bundle.id) ?? bundle.slug;
        const concepts = await conceptRepo.listByBundle(bundle.id);
        for (const row of concepts) {
          const markdown = rowToMarkdown(row);
          const [header, padded] = tarEntry(safeName([dir, `${row.slug}.md`]), markdown);
          yield header;
          yield padded;
        }
      }
      yield tarEnd();
    }
    return Readable.from(generate()).pipe(createGzip());
  }
}

export { pathsBySubtree as bundlePaths };
