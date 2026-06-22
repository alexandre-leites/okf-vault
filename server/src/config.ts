import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { config as dotenv } from "dotenv";
import yaml from "js-yaml";
import { z } from "zod";

// Load .env files from cwd and server/ (monorepo support). Non-existent files
// are silently ignored. Env vars set before this call (e.g. from Docker or a
// process manager) are never overwritten — dotenv does not override by default.
dotenv({ path: resolve(process.cwd(), ".env") });
dotenv({ path: resolve(process.cwd(), "server", ".env") });

const PREFIX = "OKFVAULT_";
const LogLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

const EnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required (postgres connection string).")
    .default("postgres://okfvault:okfvault@localhost:5432/okf_vault"),
  DATABASE_TEST_URL: z.string().default(""),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: LogLevelSchema.default("info"),
  LOG_PRETTY: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1")
    .default(false),
  CORS_ORIGINS: z.string().default(""),
  API_KEY: z.string().default(""),
  MAX_BODY_SIZE: z.coerce.number().int().positive().default(1_048_576),
  RATE_LIMIT_RPS: z.coerce.number().int().positive().default(100),
  // Selects which MCP transports to expose. The Streamable HTTP endpoint at
  // `/mcp` is ALWAYS mounted (so the server is URL-reachable).
  // - `both` (default): connect stdio AND mount HTTP `/mcp`.
  // - `stdio`: connect stdio AND mount HTTP `/mcp` (same as `both`).
  // - `http`: mount HTTP `/mcp` only (no stdio).
  // - `sse`:  legacy alias; behaves like `http` (HTTP `/mcp`), no stdio.
  MCP_TRANSPORT: z.enum(["stdio", "http", "sse", "both"]).default("both"),
  BUNDLE_STORAGE_ENABLED: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1")
    .default(false),
  BUNDLE_STORAGE_PATH: z.string().default(""),
});

export type Config = z.infer<typeof EnvSchema>;

const CONFIG_KEYS = [
  "DATABASE_URL",
  "DATABASE_TEST_URL",
  "HOST",
  "PORT",
  "LOG_LEVEL",
  "LOG_PRETTY",
  "CORS_ORIGINS",
  "API_KEY",
  "MAX_BODY_SIZE",
  "RATE_LIMIT_RPS",
  "MCP_TRANSPORT",
  "BUNDLE_STORAGE_ENABLED",
  "BUNDLE_STORAGE_PATH",
] as const;

/**
 * Resolves the config file search paths. `OKFVAULT_CONFIG` env var wins if set;
 * otherwise tries `./okfvault.yaml` then `~/.config/okfvault/config.yaml`.
 */
function configFilePaths(): string[] {
  const explicit = process.env["OKFVAULT_CONFIG"];
  if (explicit) return [resolve(explicit)];
  return [
    resolve(process.cwd(), "okfvault.yaml"),
    resolve(homedir(), ".config", "okfvault", "config.yaml"),
  ];
}

/** Reads the first existing config file. Returns {} when no file is found. */
function loadConfigFile(): Record<string, unknown> {
  for (const path of configFilePaths()) {
    try {
      const parsed = yaml.load(readFileSync(path, "utf8"));
      if (parsed !== null && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw new Error(`Failed to read config file ${path}: ${(err as Error).message}`, {
        cause: err,
      });
    }
  }
  return {};
}

/**
 * Loads configuration with precedence:
 * `rawOverrides` (e.g. CLI flags, validated by the schema) > `OKFVAULT_*`
 * environment variables > config file (`okfvault.yaml` /
 * `~/.config/okfvault/config.yaml` / `$OKFVAULT_CONFIG`) >
 * built-in defaults, with `overrides` applied last as already-typed values that
 * bypass validation. Fails fast with a clear message if any resolved value is
 * invalid.
 *
 * All keys require the `OKFVAULT_*` prefix to avoid collisions with
 * CI/Docker/orchestrator environment variables.
 *
 * @param overrides    already-typed config values applied with top precedence
 *                     (bypass schema validation).
 * @param rawOverrides string-valued overrides (CLI flags) merged into the
 *                     pre-validation map so they are coerced/validated like env.
 */
export function loadConfig(
  overrides: Partial<Config> = {},
  rawOverrides: Record<string, string> = {},
): Config {
  const file = loadConfigFile();

  const merged: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) {
    const fromEnv = process.env[`${PREFIX}${key}`];
    const fromFile = file[key];
    if (fromEnv !== undefined) merged[key] = fromEnv;
    else if (typeof fromFile === "string") merged[key] = fromFile;
    else if (typeof fromFile === "number" || typeof fromFile === "boolean") {
      merged[key] = String(fromFile);
    }
  }

  // CLI flags win over env/file but still pass through schema coercion.
  for (const [key, value] of Object.entries(rawOverrides)) {
    if (value !== undefined) merged[key] = value;
  }

  const result = EnvSchema.safeParse(merged);
  if (!result.success) {
    const messages = result.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid configuration:\n${messages}`);
  }

  return { ...result.data, ...overrides };
}

/**
 * Parses the CORS_ORIGINS value into an array of allowed origins.
 * An empty string means CORS is disabled (no header sent).
 * The special value "*" allows all origins.
 */
export function parseCorsOrigins(raw: string): string[] {
  if (!raw.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}
