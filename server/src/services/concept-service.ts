import { posix } from "node:path";
import { ConceptRepository } from "../repository/concept-repository.js";
import { BundleService } from "./bundle-service.js";
import type { ConceptRow, ConceptVersionRow } from "../db/schema.js";
import {
  ConceptNotFoundError,
  ConflictError,
  OkfValidationError,
  ReservedConceptIdError,
} from "../domain/errors.js";
import {
  FrontmatterSchema,
  isReservedFilename,
  type Concept,
  type Frontmatter,
} from "../domain/okf.js";
import { normalizeConceptType } from "../domain/concept-types.js";
import { parseConcept } from "./okf-document.js";
import { conceptToColumns, rowToConcept } from "./concept-mapper.js";
import type { FsSyncService } from "./fs-sync-service.js";

export interface CreateConceptInput {
  readonly type: string;
  readonly title: string;
  readonly description: string;
  readonly resource?: string | undefined;
  readonly tags?: string[] | undefined;
  readonly body?: string | undefined;
}

export interface ReadConceptOptions {
  readonly trackRead?: boolean;
}

/** A concept path split into directory segments + the concept's own slug. */
export interface SplitPath {
  readonly dirs: string[];
  readonly slug: string;
  readonly full: string;
}

/**
 * Strips a trailing `.md`, leading slashes, normalizes, and lowercases a
 * concept path. Lowercasing makes every path segment (sub-directories and the
 * leaf slug) case-insensitive for lookups and case-normalized on write, so
 * `Guides/Deploy` and `guides/deploy` address the same concept.
 */
export function normalizeConceptPath(raw: string): string {
  const trimmed = raw.replace(/\.md$/i, "").replace(/^\/+/, "").trim();
  const normalized = posix.normalize(trimmed).toLowerCase();
  if (normalized.startsWith("..") || normalized.startsWith("/") || normalized === ".") {
    throw new OkfValidationError(`Invalid concept path: ${raw}`);
  }
  return normalized;
}

/** Splits a normalized concept path into directory segments and a leaf slug. */
export function splitConceptPath(raw: string): SplitPath {
  const full = normalizeConceptPath(raw);
  const segments = full.split("/").filter(Boolean);
  const slug = segments.pop();
  if (slug === undefined || slug === "")
    throw new OkfValidationError(`Invalid concept path: ${raw}`);
  return { dirs: segments, slug, full };
}

export class ConceptService {
  constructor(
    private readonly concepts: ConceptRepository,
    private readonly bundleService: BundleService,
    private readonly fsSync?: FsSyncService,
  ) {}

  private assertNotReserved(slug: string): void {
    if (isReservedFilename(`${slug}.md`)) throw new ReservedConceptIdError(slug);
  }

  /** Resolves the directory bundle that holds the concept at `path`. */
  private async resolveDir(rootSlug: string, dirs: string[]): Promise<string> {
    const { bundle } = await this.bundleService.resolve([rootSlug, ...dirs]);
    return bundle.id;
  }

  async read(
    rootSlug: string,
    rawPath: string,
    options: ReadConceptOptions = {},
  ): Promise<Concept> {
    const { dirs, slug, full } = splitConceptPath(rawPath);
    this.assertNotReserved(slug);
    const bundleId = await this.resolveDir(rootSlug, dirs);
    const row = await this.concepts.findBySlug(bundleId, slug);
    if (!row) throw new ConceptNotFoundError(`${rootSlug}/${full}`);
    if (options.trackRead === true) {
      const updated = await this.concepts.incrementReadCount(row.id);
      return rowToConcept(updated ?? row, full);
    }
    return rowToConcept(row, full);
  }

  async create(rootSlug: string, rawPath: string, input: CreateConceptInput): Promise<Concept> {
    const { dirs, slug, full } = splitConceptPath(rawPath);
    this.assertNotReserved(slug);
    // Auto-create intermediate directory bundles as needed.
    const bundleId = (await this.bundleService.resolveOrCreateChild(rootSlug, dirs)).id;
    if (await this.concepts.findBySlug(bundleId, slug)) {
      throw new ConflictError(`Concept already exists: ${rootSlug}/${full}`);
    }
    const frontmatter: Frontmatter = {
      type: normalizeConceptType(input.type),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.resource !== undefined ? { resource: input.resource } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
    };
    const body = input.body ?? `# ${input.title ?? slug}\n`;
    const row = await this.concepts.insert(
      conceptToColumns(bundleId, slug, full, frontmatter, body),
    );
    await this.fsSync?.syncBundle(rootSlug);
    return rowToConcept(row, full);
  }

  /**
   * Create-or-update a concept in a single call. When the concept does not yet
   * exist it is created; when it does, the existing frontmatter/body are merged
   * with the provided fields and a version snapshot is saved before writing
   * (same history semantics as {@link update}). This is the agent-facing
   * append/update memory primitive.
   */
  async upsert(rootSlug: string, rawPath: string, input: CreateConceptInput): Promise<Concept> {
    const { dirs, slug, full } = splitConceptPath(rawPath);
    this.assertNotReserved(slug);
    const bundleId = (await this.bundleService.resolveOrCreateChild(rootSlug, dirs)).id;
    const existing = await this.concepts.findBySlug(bundleId, slug);

    if (!existing) {
      return this.create(rootSlug, full, input);
    }

    const current = rowToConcept(existing, full);
    const nextFrontmatter: Frontmatter = {
      ...current.frontmatter,
      ...(input.type !== undefined ? { type: input.type } : {}),
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.resource !== undefined ? { resource: input.resource } : {}),
      ...(input.tags !== undefined ? { tags: input.tags } : {}),
    };
    const nextBody = input.body ?? current.body;
    return this.update(rootSlug, full, nextFrontmatter, nextBody);
  }

  async listVersions(rootSlug: string, rawPath: string): Promise<ConceptVersionRow[]> {
    const { dirs, slug, full } = splitConceptPath(rawPath);
    this.assertNotReserved(slug);
    const bundleId = await this.resolveDir(rootSlug, dirs);
    const existing = await this.concepts.findBySlug(bundleId, slug);
    if (!existing) throw new ConceptNotFoundError(`${rootSlug}/${full}`);
    return this.concepts.listVersions(existing.id);
  }

  async readVersion(rootSlug: string, rawPath: string, version: number): Promise<Concept> {
    const { dirs, slug, full } = splitConceptPath(rawPath);
    this.assertNotReserved(slug);
    const bundleId = await this.resolveDir(rootSlug, dirs);
    const existing = await this.concepts.findBySlug(bundleId, slug);
    if (!existing) throw new ConceptNotFoundError(`${rootSlug}/${full}`);
    const v = await this.concepts.findVersion(existing.id, version);
    if (!v) throw new ConceptNotFoundError(`${rootSlug}/${full} version ${version}`);
    const versionRow: ConceptRow = {
      ...existing,
      title: v.title ?? existing.title,
      description: v.description ?? existing.description,
      type: v.type,
      tags: v.tags,
      resource: v.resource ?? existing.resource,
      frontmatter: v.frontmatter,
      body: v.body,
      version: v.version,
    };
    return rowToConcept(versionRow, full);
  }

  async createFromMarkdown(rootSlug: string, rawPath: string, markdown: string): Promise<Concept> {
    const { dirs, slug, full } = splitConceptPath(rawPath);
    this.assertNotReserved(slug);
    const bundleId = (await this.bundleService.resolveOrCreateChild(rootSlug, dirs)).id;
    if (await this.concepts.findBySlug(bundleId, slug)) {
      throw new ConflictError(`Concept already exists: ${rootSlug}/${full}`);
    }
    const parsed = parseConcept(full, markdown);
    const frontmatter: Frontmatter = {
      ...parsed.frontmatter,
      type: normalizeConceptType(parsed.frontmatter.type),
    };
    const body = parsed.body || `# ${parsed.frontmatter.title ?? slug}\n`;
    const row = await this.concepts.insert(
      conceptToColumns(bundleId, slug, full, frontmatter, body),
    );
    return rowToConcept(row, full);
  }

  async update(
    rootSlug: string,
    rawPath: string,
    frontmatter: Frontmatter,
    body: string,
  ): Promise<Concept> {
    const { dirs, slug, full } = splitConceptPath(rawPath);
    this.assertNotReserved(slug);
    const bundleId = await this.resolveDir(rootSlug, dirs);
    const existing = await this.concepts.findBySlug(bundleId, slug);
    if (!existing) throw new ConceptNotFoundError(`${rootSlug}/${full}`);

    const validation = FrontmatterSchema.safeParse(frontmatter);
    if (!validation.success) {
      const first = validation.error.issues[0];
      const prefix = first?.path.join(".");
      const issue = first
        ? `${prefix ? `${prefix}: ` : ""}${first.message}`
        : "invalid frontmatter";
      throw new OkfValidationError(issue, full);
    }
    const next: Frontmatter = {
      ...validation.data,
      type: normalizeConceptType(validation.data.type),
    };

    // Save previous version before updating (atomic)
    const currentVersion = existing.version ?? 1;
    const row = await this.concepts.saveVersionAndUpdate(
      existing.id,
      {
        conceptId: existing.id,
        version: currentVersion,
        type: existing.type,
        title: existing.title,
        description: existing.description,
        tags: existing.tags,
        resource: existing.resource,
        frontmatter: existing.frontmatter,
        body: existing.body,
      },
      {
        ...conceptToColumns(bundleId, slug, full, next, body),
        version: currentVersion + 1,
      },
    );
    await this.fsSync?.syncBundle(rootSlug);
    return rowToConcept(row, full);
  }

  async updateFromMarkdown(rootSlug: string, rawPath: string, markdown: string): Promise<Concept> {
    const { full } = splitConceptPath(rawPath);
    const parsed = parseConcept(full, markdown);
    return this.update(rootSlug, full, parsed.frontmatter, parsed.body);
  }

  async delete(rootSlug: string, rawPath: string): Promise<void> {
    const { dirs, slug, full } = splitConceptPath(rawPath);
    this.assertNotReserved(slug);
    const bundleId = await this.resolveDir(rootSlug, dirs);
    const existing = await this.concepts.findBySlug(bundleId, slug);
    if (!existing) throw new ConceptNotFoundError(`${rootSlug}/${full}`);
    await this.concepts.softDelete(existing.id);
    await this.fsSync?.syncBundle(rootSlug);
  }
}
