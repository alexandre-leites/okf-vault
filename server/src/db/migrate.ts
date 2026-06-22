import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type { Logger } from "../logger.js";

/**
 * Resolves the `drizzle/` migrations folder. It sits at the package root in
 * both source (src/db -> ../../drizzle) and build (dist -> ../drizzle) layouts.
 */
function migrationsFolder(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return here.endsWith(`db`) ? resolve(here, "../../drizzle") : resolve(here, "../drizzle");
}

/**
 * Applies all pending SQL migrations from the drizzle folder. Uses a dedicated
 * single-connection client so it can run safely before the app pool opens.
 */
export async function runMigrations(databaseUrl: string, log?: Logger): Promise<void> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  try {
    const db = drizzle(sql);
    log?.info({ folder: migrationsFolder() }, "Applying database migrations");
    await migrate(db, { migrationsFolder: migrationsFolder() });
    log?.info("Database migrations applied");
  } finally {
    await sql.end({ timeout: 5 });
  }
}
