import { and, eq, isNull, desc, sql } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { bundles, type BundleRow, type NewBundleRow } from "../db/schema.js";

/**
 * Data access for the Knowledge Bundle tree. Bundles form a hierarchy via
 * `parentId` (NULL = root). All reads exclude soft-deleted rows; soft-delete
 * cascades to every descendant bundle via a recursive CTE.
 */
export class BundleRepository {
  constructor(private readonly db: Database) {}

  /** Lists root bundles (parentId IS NULL), newest first. */
  async listRoots(): Promise<BundleRow[]> {
    return this.db
      .select()
      .from(bundles)
      .where(and(isNull(bundles.parentId), isNull(bundles.deletedAt)))
      .orderBy(desc(bundles.createdAt));
  }

  async findRootBySlug(slug: string): Promise<BundleRow | undefined> {
    const rows = await this.db
      .select()
      .from(bundles)
      .where(and(isNull(bundles.parentId), eq(bundles.slug, slug), isNull(bundles.deletedAt)))
      .limit(1);
    return rows[0];
  }

  async findChildBySlug(parentId: string, slug: string): Promise<BundleRow | undefined> {
    const rows = await this.db
      .select()
      .from(bundles)
      .where(and(eq(bundles.parentId, parentId), eq(bundles.slug, slug), isNull(bundles.deletedAt)))
      .limit(1);
    return rows[0];
  }

  async findById(id: string): Promise<BundleRow | undefined> {
    const rows = await this.db
      .select()
      .from(bundles)
      .where(and(eq(bundles.id, id), isNull(bundles.deletedAt)))
      .limit(1);
    return rows[0];
  }

  async listChildren(parentId: string): Promise<BundleRow[]> {
    return this.db
      .select()
      .from(bundles)
      .where(and(eq(bundles.parentId, parentId), isNull(bundles.deletedAt)))
      .orderBy(bundles.slug);
  }

  /**
   * Returns the subtree rooted at `rootId` (inclusive), excluding soft-deleted
   * rows, via a recursive CTE. Returns snake-cased DB rows mapped to the
   * camelCase `BundleRow` shape.
   */
  async listSubtree(rootId: string): Promise<BundleRow[]> {
    const rows = await this.db.execute(sql`
      WITH RECURSIVE subtree AS (
        SELECT * FROM ${bundles} WHERE id = ${rootId} AND deleted_at IS NULL
        UNION ALL
        SELECT b.* FROM ${bundles} b
        JOIN subtree s ON b.parent_id = s.id
        WHERE b.deleted_at IS NULL
      )
      SELECT * FROM subtree
    `);
    return (rows as unknown as Record<string, unknown>[]).map(mapBundleRow);
  }

  async insert(values: NewBundleRow): Promise<BundleRow> {
    const rows = await this.db.insert(bundles).values(values).returning();
    return rows[0]!;
  }

  async updateMetadata(
    id: string,
    title: string,
    description: string,
  ): Promise<BundleRow | undefined> {
    const rows = await this.db
      .update(bundles)
      .set({ title, description, updatedAt: new Date() })
      .where(and(eq(bundles.id, id), isNull(bundles.deletedAt)))
      .returning();
    return rows[0];
  }

  /**
   * Soft-deletes a bundle and its entire descendant subtree (bundles only).
   * Concept cascade is handled by the service against the returned ids.
   */
  async softDeleteSubtree(rootId: string): Promise<string[]> {
    const rows = await this.db.execute<{ id: string }>(sql`
      WITH RECURSIVE subtree AS (
        SELECT id FROM ${bundles} WHERE id = ${rootId} AND deleted_at IS NULL
        UNION ALL
        SELECT b.id FROM ${bundles} b
        JOIN subtree s ON b.parent_id = s.id
        WHERE b.deleted_at IS NULL
      )
      UPDATE ${bundles} SET deleted_at = now(), updated_at = now()
      WHERE id IN (SELECT id FROM subtree) AND deleted_at IS NULL
      RETURNING id
    `);
    return (rows as unknown as { id: string }[]).map((r) => r.id);
  }
}

/** Maps a snake-cased raw DB row from a CTE to the camelCase BundleRow shape. */
function mapBundleRow(r: Record<string, unknown>): BundleRow {
  return {
    id: r["id"] as string,
    parentId: (r["parent_id"] as string | null) ?? null,
    slug: r["slug"] as string,
    title: (r["title"] as string | null) ?? null,
    description: (r["description"] as string | null) ?? null,
    okfVersion: r["okf_version"] as string,
    createdAt: new Date(r["created_at"] as string),
    updatedAt: new Date(r["updated_at"] as string),
    deletedAt: r["deleted_at"] ? new Date(r["deleted_at"] as string) : null,
  };
}
