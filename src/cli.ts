#!/usr/bin/env node
import { Command, InvalidArgumentError } from "commander";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { createServices, type Services } from "./services/factory.js";
import { serve } from "./mcp/server.js";

function parsePort(value: string): number {
  const n = parseInt(value, 10);
  if (isNaN(n) || n < 1 || n > 65535) {
    throw new InvalidArgumentError("Port must be an integer between 1 and 65535.");
  }
  return n;
}

const config = loadConfig();
const log = createLogger(config);

const program = new Command();
program
  .name("okfvault")
  .description(
    "A headless CLI and MCP server for the Open Knowledge Format (OKF), backed by Postgres.",
  )
  .version("0.2.0")
  .option("--database-url <url>", "Postgres connection string", config.DATABASE_URL);

function databaseUrl(): string {
  return program.opts<{ databaseUrl: string }>().databaseUrl;
}

/** Runs a command with fully wired services. */
async function withServices<T>(fn: (svc: Services) => Promise<T>): Promise<T> {
  const handle = createDb(databaseUrl());
  try {
    return await fn(createServices(handle.db));
  } finally {
    await handle.close();
  }
}

program
  .command("migrate")
  .description("Apply pending database migrations.")
  .action(async () => {
    await runMigrations(databaseUrl(), log);
    console.log("Migrations applied.");
  });

const bundle = program.command("bundle").description("Manage knowledge bundles.");

bundle
  .command("create <slug>")
  .description("Create a bundle.")
  .option("--title <title>", "Display title.")
  .option("--description <description>", "One-line summary.")
  .action(async (slug: string, opts: { title?: string; description?: string }) => {
    const created = await withServices((svc) =>
      svc.bundleService.create({
        slug,
        ...(opts.title !== undefined ? { title: opts.title } : {}),
        ...(opts.description !== undefined ? { description: opts.description } : {}),
      }),
    );
    console.log(`Created bundle ${created.slug}`);
  });

bundle
  .command("list")
  .description("List bundles.")
  .action(async () => {
    const rows = await withServices((svc) => svc.bundleService.list());
    console.log(
      JSON.stringify(
        rows.map((b) => ({ slug: b.slug, title: b.title })),
        null,
        2,
      ),
    );
  });

bundle
  .command("delete <slug>")
  .description("Soft-delete a bundle and its concepts.")
  .action(async (slug: string) => {
    await withServices((svc) => svc.bundleService.delete(slug));
    console.log(`Deleted bundle ${slug}`);
  });

bundle
  .command("index <path>")
  .description(
    "Print a bundle's directory listing (progressive disclosure). PATH is slug or slug/sub/dir.",
  )
  .option("--json", "Render the structured tree as JSON instead of OKF markdown.")
  .action(async (path: string, opts: { json?: boolean }) => {
    const segments = path.split("/").filter(Boolean);
    await withServices(async (svc) => {
      if (opts.json === true)
        console.log(JSON.stringify(await svc.indexService.index(segments), null, 2));
      else console.log(await svc.indexService.indexMarkdown(segments));
    });
  });

bundle
  .command("export <slug>")
  .description("Export bundle as tar.gz to stdout.")
  .action(async (slug: string) => {
    const handle = createDb(databaseUrl());
    try {
      const svc = createServices(handle.db);
      const stream = await svc.exportService.exportStream(slug);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
      for await (const chunk of stream) process.stdout.write(chunk);
    } finally {
      await handle.close();
    }
  });

bundle
  .command("import <slug> <file>")
  .description("Import a tar.gz file into a bundle.")
  .action(async (slug: string, file: string) => {
    const { readFile } = await import("node:fs/promises");
    const buffer = await readFile(file);
    const result = await withServices((svc) => svc.importService.importTarGz(slug, buffer));
    console.log(JSON.stringify(result, null, 2));
  });

const concept = program.command("concept").description("Manage OKF concepts.");

concept
  .command("create <bundle> <path>")
  .description("Create a concept with valid OKF frontmatter.")
  .requiredOption("--type <type>", "Concept type (required by OKF).")
  .option("--title <title>", "Display title.")
  .option("--description <description>", "One-line summary.")
  .option("--tags <tags>", "Comma-separated tags.")
  .action(
    async (
      bundleSlug: string,
      path: string,
      opts: { type: string; title?: string; description?: string; tags?: string },
    ) => {
      const created = await withServices((svc) =>
        svc.conceptService.create(bundleSlug, path, {
          type: opts.type,
          ...(opts.title !== undefined ? { title: opts.title } : {}),
          ...(opts.description !== undefined ? { description: opts.description } : {}),
          ...(opts.tags !== undefined ? { tags: opts.tags.split(",").map((t) => t.trim()) } : {}),
        }),
      );
      console.log(
        `Created concept ${bundleSlug}/${created.id} (scope: ${JSON.stringify(created.scope)})`,
      );
    },
  );

concept
  .command("read <bundle> <path>")
  .description("Read a concept and print it as JSON.")
  .action(async (bundleSlug: string, path: string) => {
    const concept = await withServices((svc) =>
      svc.conceptService.read(bundleSlug, path, { trackRead: true }),
    );
    console.log(JSON.stringify(concept, null, 2));
  });

concept
  .command("delete <bundle> <path>")
  .description("Soft-delete a concept.")
  .action(async (bundleSlug: string, path: string) => {
    await withServices((svc) => svc.conceptService.delete(bundleSlug, path));
    console.log(`Deleted concept ${bundleSlug}/${path}`);
  });

program
  .command("search [text]")
  .description("Search concepts by text, type, tags, scope, and project.")
  .option("--bundle <slug>", "Restrict to one bundle.")
  .option("--type <type>", "Filter by concept type.")
  .option("--tags <tags>", "Comma-separated tags to require.")
  .option("--scopes <scopes>", "Comma-separated named scope keys.")
  .option("--project <proj>", "Include concepts relevant to this project.")
  .option("--limit <n>", "Max results.", (v) => parseInt(v, 10))
  .action(
    async (
      text: string | undefined,
      opts: {
        bundle?: string;
        type?: string;
        tags?: string;
        scopes?: string;
        project?: string;
        limit?: number;
      },
    ) => {
      const results = await withServices((svc) =>
        svc.searchService.search({
          ...(text !== undefined ? { text } : {}),
          ...(opts.bundle !== undefined ? { bundlePath: opts.bundle } : {}),
          ...(opts.type !== undefined ? { type: opts.type } : {}),
          ...(opts.tags !== undefined ? { tags: opts.tags.split(",").map((t) => t.trim()) } : {}),
          ...(opts.scopes !== undefined
            ? { scopes: opts.scopes.split(",").map((s) => s.trim()) }
            : {}),
          ...(opts.project !== undefined ? { project: opts.project } : {}),
          ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
        }),
      );
      console.log(JSON.stringify(results, null, 2));
    },
  );

program
  .command("serve")
  .description("Expose the vault over MCP (stdio) and a REST API.")
  .option("--host <host>", "REST API bind host", config.HOST)
  .option("--port <port>", "REST API port", String(config.PORT))
  .option("--migrate", "Apply pending migrations before serving.")
  .action(async (opts: { host: string; port: string; migrate?: boolean }) => {
    const port = parsePort(opts.port);
    if (opts.migrate === true) await runMigrations(databaseUrl(), log);
    const handle = createDb(databaseUrl());
    await serve({
      config: { ...config, HOST: opts.host, PORT: port, DATABASE_URL: databaseUrl() },
      log,
      db: handle.db,
      onShutdown: () => handle.close(),
    });
  });

program.parseAsync().catch((error: unknown) => {
  log.error({ err: error }, "Fatal error");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
