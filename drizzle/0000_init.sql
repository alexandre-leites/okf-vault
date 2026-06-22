CREATE TABLE "bundles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"parent_id" uuid,
	"slug" text NOT NULL,
	"title" text,
	"description" text,
	"okf_version" text DEFAULT '0.1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "concepts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bundle_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"type" text NOT NULL,
	"title" text,
	"description" text,
	"resource" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"scope_kind" text DEFAULT 'global' NOT NULL,
	"scope_key" text,
	"frontmatter" jsonb NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"read_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "bundles" ADD CONSTRAINT "bundles_parent_id_bundles_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."bundles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "concepts" ADD CONSTRAINT "concepts_bundle_id_bundles_id_fk" FOREIGN KEY ("bundle_id") REFERENCES "public"."bundles"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "bundles_root_slug_active_uq" ON "bundles" USING btree ("slug") WHERE "bundles"."parent_id" IS NULL AND "bundles"."deleted_at" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "bundles_child_slug_active_uq" ON "bundles" USING btree ("parent_id","slug") WHERE "bundles"."parent_id" IS NOT NULL AND "bundles"."deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "bundles_parent_idx" ON "bundles" USING btree ("parent_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "concepts_bundle_slug_active_uq" ON "concepts" USING btree ("bundle_id","slug") WHERE "concepts"."deleted_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "concepts_bundle_idx" ON "concepts" USING btree ("bundle_id");
--> statement-breakpoint
CREATE INDEX "concepts_type_idx" ON "concepts" USING btree ("type");
--> statement-breakpoint
CREATE INDEX "concepts_scope_idx" ON "concepts" USING btree ("scope_kind","scope_key");
--> statement-breakpoint
CREATE INDEX "concepts_tags_idx" ON "concepts" USING gin ("tags");
--> statement-breakpoint
CREATE INDEX "concepts_search_idx" ON "concepts" USING gin (to_tsvector('english', coalesce("title", '') || ' ' || coalesce("description", '') || ' ' || "body"));
