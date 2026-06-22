import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type { Frontmatter } from "../domain/okf.js";

/**
 * A Knowledge Bundle node in a tree (OKF-FORMAT-SPEC §2/§3). A root bundle has
 * `parentId = NULL`; every subdirectory is itself a bundle whose `parentId`
 * points at its parent. Addressed in URLs by walking `slug` segments from a
 * root. Soft-deleted via `deletedAt` (cascades to descendants + concepts at the
 * service layer); all reads filter `deletedAt IS NULL`.
 *
 * Active-row uniqueness is enforced by partial unique indexes scoped to
 * `deletedAt IS NULL`, so a slug can be reused after delete. Root bundles
 * (NULL parent) and child bundles use separate indexes because NULL never
 * equals NULL under a composite UNIQUE.
 */
export const bundles = pgTable(
  "bundles",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    parentId: uuid("parent_id").references((): AnyPgColumn => bundles.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    title: text("title"),
    description: text("description"),
    okfVersion: text("okf_version").notNull().default("0.1"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("bundles_root_slug_active_uq")
      .on(t.slug)
      .where(sql`${t.parentId} IS NULL AND ${t.deletedAt} IS NULL`),
    uniqueIndex("bundles_child_slug_active_uq")
      .on(t.parentId, t.slug)
      .where(sql`${t.parentId} IS NOT NULL AND ${t.deletedAt} IS NULL`),
    index("bundles_parent_idx").on(t.parentId),
  ],
);

/**
 * A Concept — one OKF markdown document attached directly to the bundle that
 * represents its directory (§4). Identified within that bundle by `slug` (the
 * filename without `.md`, e.g. `orders`). Structured columns power filters and
 * FTS; arbitrary producer-defined frontmatter keys live in `frontmatter`.
 *
 * A generated `tsvector` over title/description/body drives ranked full-text
 * search via the GIN index.
 */
export const concepts = pgTable(
  "concepts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    bundleId: uuid("bundle_id")
      .notNull()
      .references(() => bundles.id, { onDelete: "cascade" }),
    slug: text("slug").notNull(),
    type: text("type").notNull(),
    title: text("title"),
    description: text("description"),
    resource: text("resource"),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    scopeKind: text("scope_kind").notNull().default("global"),
    scopeKey: text("scope_key"),
    frontmatter: jsonb("frontmatter").$type<Frontmatter>().notNull(),
    body: text("body").notNull().default(""),
    version: integer("version").notNull().default(1),
    readCount: integer("read_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("concepts_bundle_slug_active_uq")
      .on(t.bundleId, t.slug)
      .where(sql`${t.deletedAt} IS NULL`),
    index("concepts_bundle_idx").on(t.bundleId),
    index("concepts_type_idx").on(t.type),
    index("concepts_scope_idx").on(t.scopeKind, t.scopeKey),
    index("concepts_tags_idx").using("gin", t.tags),
    index("concepts_search_idx").using(
      "gin",
      sql`to_tsvector('english', coalesce(${t.title}, '') || ' ' || coalesce(${t.description}, '') || ' ' || ${t.body})`,
    ),
  ],
);

export const conceptVersions = pgTable(
  "concept_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conceptId: uuid("concept_id")
      .notNull()
      .references(() => concepts.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    type: text("type").notNull(),
    title: text("title"),
    description: text("description"),
    tags: text("tags")
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    resource: text("resource"),
    frontmatter: jsonb("frontmatter").$type<Frontmatter>().notNull(),
    body: text("body").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("concept_versions_concept_idx").on(t.conceptId, t.version)],
);

export type BundleRow = typeof bundles.$inferSelect;
export type NewBundleRow = typeof bundles.$inferInsert;
export type ConceptRow = typeof concepts.$inferSelect;
export type NewConceptRow = typeof concepts.$inferInsert;
export type ConceptVersionRow = typeof conceptVersions.$inferSelect;
export type NewConceptVersionRow = typeof conceptVersions.$inferInsert;
