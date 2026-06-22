import pino from "pino";
import type { Config } from "./config.js";

export type Logger = pino.Logger;

/**
 * Creates the application logger. Logs are written to stderr so command stdout
 * stays reserved for machine-readable command output (JSON, systemd units, etc.).
 */
export function createLogger(config: Pick<Config, "LOG_LEVEL" | "LOG_PRETTY">): Logger {
  return pino({ level: config.LOG_LEVEL }, pino.destination(2));
}
