import { createGunzip } from "node:zlib";
import { ConceptService } from "./concept-service.js";

export interface ImportResult {
  created: number;
  updated: number;
  errors: { path: string; error: string }[];
}

export class BundleImportService {
  constructor(private readonly concepts: ConceptService) {}

  /** @internal exposed for testing */
  get conceptService(): ConceptService {
    return this.concepts;
  }

  async importTarGz(rootSlug: string, buffer: Buffer): Promise<ImportResult> {
    const result: ImportResult = { created: 0, updated: 0, errors: [] };
    const decompressed = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const gunzip = createGunzip();
      gunzip.on("data", (chunk: Buffer) => chunks.push(chunk));
      gunzip.on("end", () => resolve(Buffer.concat(chunks)));
      gunzip.on("error", reject);
      gunzip.write(buffer);
      gunzip.end();
    });
    const files = parseTar(decompressed);
    for (const file of files) {
      if (!file.name.endsWith(".md")) continue;
      try {
        const path = file.name.replace(/\.md$/, "").replace(/^[^/]+\//, "");
        const markdown = file.content.toString("utf-8");
        const existing = await this.concepts.read(rootSlug, path).catch(() => null);
        if (existing) {
          await this.concepts.updateFromMarkdown(rootSlug, path, markdown);
          result.updated++;
        } else {
          await this.concepts.createFromMarkdown(rootSlug, path, markdown);
          result.created++;
        }
      } catch (err) {
        result.errors.push({
          path: file.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return result;
  }
}

export interface TarFile {
  name: string;
  content: Buffer;
}

export function parseTar(data: Buffer): TarFile[] {
  const files: TarFile[] = [];
  let offset = 0;
  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header[0] === 0) break; // zero block = end
    let name = "";
    for (let i = 0; i < 100 && header[i] !== 0; i++) name += String.fromCharCode(header[i]!);
    if (!name) break;
    const sizeStr = header.toString("ascii", 124, 135).trim();
    const size = parseInt(sizeStr, 8);
    if (isNaN(size)) break;
    offset += 512;
    const content = data.subarray(offset, offset + size);
    files.push({ name, content: Buffer.from(content) });
    offset += Math.ceil(size / 512) * 512;
  }
  return files;
}
