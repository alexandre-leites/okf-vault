import { and, eq, isNull, sql, inArray, desc, type SQL } from "drizzle-orm";
import type { Database } from "../db/client.js";
import {
  concepts,
  conceptVersions,
  type ConceptRow,
  type NewConceptRow,
  type ConceptVersionRow,
  type NewConceptVersionRow,
} from "../db/schema.js";

export interface ConceptSearchFilter {
  /** Restrict to concepts whose bundle is in this set (a resolved subtree). */
  readonly bundleIds?: readonly string[];
  readonly text?: string;
  readonly type?: string;
  readonly tags?: readonly string[];
  readonly scope?: {
    readonly scopes?: readonly string[];
    readonly project?: string;
  };
  readonly limit: number;
  readonly offset: number;
}

/**
 * Data access for Concepts. A concept is addressed by `bundleId` + `slug`. All
 * reads exclude soft-deleted rows. Full-text search uses a Postgres `tsvector`
 * (matching the GIN index) ranked by `ts_rank`; structured filters narrow by
 * type/tags/scope and an optional bundle-id set (a resolved subtree).
 */
export class ConceptRepository {
  constructor(private readonly db: Database) {}

  async findBySlug(bundleId: string, slug: string): Promise<ConceptRow | undefined> {
    const rows = await this.db
      .select()
      .from(concepts)
      .where(
        and(eq(concepts.bundleId, bundleId), eq(concepts.slug, slug), isNull(concepts.deletedAt)),
      )
      .limit(1);
    return rows[0];
  }

  async listByBundle(bundleId: string): Promise<ConceptRow[]> {
    return this.db
      .select()
      .from(concepts)
      .where(and(eq(concepts.bundleId, bundleId), isNull(concepts.deletedAt)))
      .orderBy(concepts.slug);
  }

  async listByBundles(bundleIds: readonly string[]): Promise<ConceptRow[]> {
    if (bundleIds.length === 0) return [];
    return this.db
      .select()
      .from(concepts)
      .where(and(inArray(concepts.bundleId, bundleIds as string[]), isNull(concepts.deletedAt)))
      .orderBy(concepts.slug);
  }

  async insert(values: NewConceptRow): Promise<ConceptRow> {
    const rows = await this.db.insert(concepts).values(values).returning();
    return rows[0]!;
  }

  async update(id: string, values: Partial<NewConceptRow>): Promise<ConceptRow> {
    const rows = await this.db
      .update(concepts)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(concepts.id, id), isNull(concepts.deletedAt)))
      .returning();
    return rows[0]!;
  }

  async saveVersionAndUpdate(
    id: string,
    versionValues: NewConceptVersionRow,
    updateValues: Partial<NewConceptRow>,
  ): Promise<ConceptRow> {
    const rows = await this.db.transaction(async (tx) => {
      await tx.insert(conceptVersions).values(versionValues);
      return tx
        .update(concepts)
        .set({ ...updateValues, updatedAt: new Date() })
        .where(and(eq(concepts.id, id), isNull(concepts.deletedAt)))
        .returning();
    });
    return rows[0]!;
  }

  async incrementReadCount(id: string): Promise<ConceptRow | undefined> {
    const rows = await this.db
      .update(concepts)
      .set({ readCount: sql`${concepts.readCount} + 1` })
      .where(and(eq(concepts.id, id), isNull(concepts.deletedAt)))
      .returning();
    return rows[0];
  }

  async softDelete(id: string): Promise<void> {
    await this.db
      .update(concepts)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(concepts.id, id), isNull(concepts.deletedAt)));
  }

  async softDeleteByBundles(bundleIds: readonly string[]): Promise<void> {
    if (bundleIds.length === 0) return;
    await this.db
      .update(concepts)
      .set({ deletedAt: new Date(), updatedAt: new Date() })
      .where(and(inArray(concepts.bundleId, bundleIds as string[]), isNull(concepts.deletedAt)));
  }

  async search(filter: ConceptSearchFilter): Promise<(ConceptRow & { headline?: string })[]> {
    const conditions: SQL[] = [isNull(concepts.deletedAt)];

    if (filter.bundleIds !== undefined) {
      if (filter.bundleIds.length === 0) return [];
      conditions.push(inArray(concepts.bundleId, filter.bundleIds as string[]));
    }
    if (filter.type !== undefined) {
      conditions.push(sql`lower(${concepts.type}) = lower(${filter.type})`);
    }
    if (filter.tags && filter.tags.length > 0) {
      conditions.push(sql`${concepts.tags} @> ${sql.param(filter.tags as string[])}::text[]`);
    }
    if (filter.scope !== undefined) {
      conditions.push(this.scopeCondition(filter.scope));
    }

    const text = filter.text?.trim();
    const tsQuery = text ? sql`websearch_to_tsquery('english', ${text})` : undefined;

    // Unweighted tsvector for GIN-indexed @@ matching
    const tsVector = sql`to_tsvector('english', coalesce(${concepts.title}, '') || ' ' || coalesce(${concepts.description}, '') || ' ' || ${concepts.body})`;

    // Weighted tsvector for ts_rank: title=A (0.1), description=B (0.2), body=C (0.9)
    const wtsvector = sql`setweight(to_tsvector('english', coalesce(${concepts.title}, '')), 'A') || setweight(to_tsvector('english', coalesce(${concepts.description}, '')), 'B') || setweight(to_tsvector('english', ${concepts.body}), 'C')`;

    if (tsQuery !== undefined) {
      conditions.push(
        sql`(${tsVector} @@ ${tsQuery} OR similarity(coalesce(${concepts.title}, '') || ' ' || coalesce(${concepts.description}, '') || ' ' || ${concepts.body}, ${text}) > 0.15)`,
      );
    }

    const rank =
      tsQuery !== undefined
        ? sql<number>`GREATEST(ts_rank(${wtsvector}, ${tsQuery}), similarity(coalesce(${concepts.title}, '') || ' ' || coalesce(${concepts.description}, '') || ' ' || ${concepts.body}, ${text}))`
        : sql<number>`0`;

    // StartSel/StopSel must be non-empty for ts_headline; use sentinels that the
    // service layer strips, so highlight markers never leak into the snippet.
    const headline =
      tsQuery !== undefined
        ? sql<string>`coalesce(ts_headline('english', ${concepts.body}, ${tsQuery}, 'MaxWords=40,MinWords=15,StartSel=«,StopSel=»'), '')`
        : sql<string>`''`;

    const rows = await this.db
      .select({ concept: concepts, rank, headline })
      .from(concepts)
      .where(and(...conditions))
      .orderBy(tsQuery !== undefined ? sql`${rank} DESC` : concepts.updatedAt, concepts.slug)
      .limit(filter.limit)
      .offset(filter.offset);

    return rows.map((r) => ({ ...r.concept, headline: r.headline ?? undefined }));
  }

  async saveVersion(values: NewConceptVersionRow): Promise<ConceptVersionRow> {
    const rows = await this.db.insert(conceptVersions).values(values).returning();
    return rows[0]!;
  }

  async listVersions(conceptId: string): Promise<ConceptVersionRow[]> {
    return this.db
      .select()
      .from(conceptVersions)
      .where(eq(conceptVersions.conceptId, conceptId))
      .orderBy(desc(conceptVersions.version));
  }

  async findVersion(conceptId: string, version: number): Promise<ConceptVersionRow | undefined> {
    const rows = await this.db
      .select()
      .from(conceptVersions)
      .where(and(eq(conceptVersions.conceptId, conceptId), eq(conceptVersions.version, version)))
      .limit(1);
    return rows[0];
  }

  private scopeCondition(scope: { scopes?: readonly string[]; project?: string }): SQL {
    const clauses: SQL[] = [eq(concepts.scopeKind, "global")];
    if (scope.scopes && scope.scopes.length > 0) {
      clauses.push(
        and(
          eq(concepts.scopeKind, "named"),
          sql`${concepts.scopeKey} = ANY(${sql.param(scope.scopes as string[])}::text[])`,
        )!,
      );
    }
    if (scope.project !== undefined) {
      clauses.push(and(eq(concepts.scopeKind, "project"), eq(concepts.scopeKey, scope.project))!);
    }
    return sql`(${sql.join(clauses, sql` OR `)})`;
  }
}
