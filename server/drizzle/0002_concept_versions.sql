--> statement-breakpoint
CREATE TABLE "concept_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"concept_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"type" text NOT NULL,
	"title" text,
	"description" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"resource" text,
	"frontmatter" jsonb NOT NULL,
	"body" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "concept_versions" ADD CONSTRAINT "concept_versions_concept_id_concepts_id_fk" FOREIGN KEY ("concept_id") REFERENCES "public"."concepts"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "concept_versions_concept_idx" ON "concept_versions" USING btree ("concept_id","version" DESC);
--> statement-breakpoint
ALTER TABLE "concepts" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;
