--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
CREATE INDEX "concepts_trgm_idx" ON "concepts" USING gin ((coalesce("title", '') || ' ' || coalesce("description", '') || ' ' || "body") gin_trgm_ops);
