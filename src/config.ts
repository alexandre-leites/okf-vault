import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { z } from "zod";

const LogLevelSchema = z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]);

const EnvSchema = z.object({
  DATABASE_URL: z
    .string()
    .min(1, "DATABASE_URL is required (postgres connection string).")
    .default("postgres://okfvault:okfvault@192.168.31.111:5432/okf_vault"),
  HOST: z.string().default("127.0.0.1"),
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
  MCP_TRANSPORT: z.enum(["stdio", "sse"]).default("stdio"),
});

export type Config = z.infer<typeof EnvSchema>;

const CONFIG_KEYS = [
  "DATABASE_URL",
  "HOST",
  "PORT",
  "LOG_LEVEL",
  "LOG_PRETTY",
  "CORS_ORIGINS",
  "API_KEY",
  "MAX_BODY_SIZE",
  "RATE_LIMIT_RPS",
  "MCP_TRANSPORT",
] as const;

/**
 * Resolves the config file search path. `OKFVAULT_CONFIG` wins if set; otherwise
 * `./okfvault.json` then `~/.config/okfvault/config.json` are tried in order.
 */
function configFilePaths(): string[] {
  const explicit = process.env["OKFVAULT_CONFIG"];
  if (explicit) return [resolve(explicit)];
  return [
    resolve(process.cwd(), "okfvault.json"),
    resolve(homedir(), ".config", "okfvault", "config.json"),
  ];
}

/** Reads the first existing config file as a flat string-keyed record. */
function loadConfigFile(): Record<string, unknown> {
  for (const path of configFilePaths()) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
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
 * Loads configuration with precedence: explicit `overrides` > environment
 * variables > config file (`okfvault.json` / `~/.config/okfvault/config.json`
 * / `$OKFVAULT_CONFIG`) > built-in defaults. Fails fast with a clear message
 * if any resolved value is invalid.
 */
export function loadConfig(overrides: Partial<Config> = {}): Config {
  const file = loadConfigFile();

  const merged: Record<string, unknown> = {};
  for (const key of CONFIG_KEYS) {
    const fromEnv = process.env[key];
    const fromFile = file[key];
    if (fromEnv !== undefined) merged[key] = fromEnv;
    else if (typeof fromFile === "string") merged[key] = fromFile;
    else if (typeof fromFile === "number" || typeof fromFile === "boolean") {
      merged[key] = String(fromFile);
    }
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
