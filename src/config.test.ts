import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, parseCorsOrigins } from "./config.js";

const DEFAULT_URL = "postgres://okfvault:okfvault@192.168.31.111:5432/okf_vault";

describe("loadConfig", () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
  });

  it("falls back to the built-in default database url", () => {
    delete process.env["DATABASE_URL"];
    process.env["OKFVAULT_CONFIG"] = "/nonexistent/okfvault.json";
    expect(loadConfig().DATABASE_URL).toBe(DEFAULT_URL);
  });

  it("reads values from a config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "okfcfg-"));
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ DATABASE_URL: "postgres://file/db", PORT: 4242 }));
    delete process.env["DATABASE_URL"];
    delete process.env["PORT"];
    process.env["OKFVAULT_CONFIG"] = path;
    try {
      const cfg = loadConfig();
      expect(cfg.DATABASE_URL).toBe("postgres://file/db");
      expect(cfg.PORT).toBe(4242);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("lets environment variables override the config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "okfcfg-"));
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ DATABASE_URL: "postgres://file/db" }));
    process.env["OKFVAULT_CONFIG"] = path;
    process.env["DATABASE_URL"] = "postgres://env/db";
    try {
      expect(loadConfig().DATABASE_URL).toBe("postgres://env/db");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("applies explicit overrides on top of everything", () => {
    process.env["OKFVAULT_CONFIG"] = "/nonexistent/okfvault.json";
    expect(loadConfig({ PORT: 9999 }).PORT).toBe(9999);
  });

  it("throws on invalid config values", () => {
    process.env["PORT"] = "not-a-number";
    process.env["OKFVAULT_CONFIG"] = "/nonexistent/okfvault.json";
    expect(() => loadConfig()).toThrow("Invalid configuration");
  });

  it("reads numeric config file values", async () => {
    const dir = await mkdtemp(join(tmpdir(), "okfcfg-"));
    const path = join(dir, "config.json");
    await writeFile(path, JSON.stringify({ PORT: 4242 }));
    delete process.env["PORT"];
    process.env["OKFVAULT_CONFIG"] = path;
    try {
      expect(loadConfig().PORT).toBe(4242);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("handles malformed config file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "okfcfg-"));
    const path = join(dir, "config.json");
    await writeFile(path, "not json");
    process.env["OKFVAULT_CONFIG"] = path;
    delete process.env["DATABASE_URL"];
    try {
      expect(() => loadConfig()).toThrow("Failed to read config file");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts LOG_PRETTY=1 as true", () => {
    process.env["LOG_PRETTY"] = "1";
    process.env["OKFVAULT_CONFIG"] = "/nonexistent/okfvault.json";
    expect(loadConfig().LOG_PRETTY).toBe(true);
  });

  it("reads config from default search path (okfvault.json in cwd)", async () => {
    // Test that a config file at CWD is picked up (no OKFVAULT_CONFIG set)
    const dir = await mkdtemp(join(tmpdir(), "okfcfg-"));
    const path = join(dir, "okfvault.json");
    await writeFile(path, JSON.stringify({ DATABASE_URL: "postgres://cwd/db" }));
    delete process.env["OKFVAULT_CONFIG"];
    delete process.env["DATABASE_URL"];
    const savedCwd = process.cwd();
    process.chdir(dir);
    try {
      expect(loadConfig().DATABASE_URL).toBe("postgres://cwd/db");
    } finally {
      process.chdir(savedCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("parseCorsOrigins", () => {
  it("returns an empty array for blank input", () => {
    expect(parseCorsOrigins("")).toEqual([]);
    expect(parseCorsOrigins("   ")).toEqual([]);
  });

  it("splits and trims comma-separated origins", () => {
    expect(parseCorsOrigins("http://a.com, http://b.com")).toEqual([
      "http://a.com",
      "http://b.com",
    ]);
  });

  it("filters empty entries", () => {
    expect(parseCorsOrigins("http://a.com,,http://b.com")).toEqual([
      "http://a.com",
      "http://b.com",
    ]);
  });

  it("handles single origin", () => {
    expect(parseCorsOrigins("http://localhost:3000")).toEqual(["http://localhost:3000"]);
  });
});
