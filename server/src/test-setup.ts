import { runMigrations } from "./db/migrate.js";

const url = process.env["DATABASE_TEST_URL"];

export async function setup() {
  if (url) {
    await runMigrations(url);
  }
}
