import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env["DATABASE_URL"] ?? "postgres://okfvault:okfvault@192.168.31.111:5432/okf_vault",
  },
  strict: true,
  verbose: true,
});
