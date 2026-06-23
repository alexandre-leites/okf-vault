#!/usr/bin/env node
import { Command } from "commander";
import { loadConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { createDb } from "./db/client.js";
import { runMigrations } from "./db/migrate.js";
import { createServices, type Services } from "./services/factory.js";
import { serve } from "./mcp/server.js";
import { SearchQuerySyntaxError } from "./services/search-query.js";

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
  .command("upsert <bundle> <path>")
  .description(
    "Create a concept, or update it in place if it already exists (with version snapshot).",
  )
  .requiredOption("--type <type>", "Concept type (required by OKF).")
  .option("--title <title>", "Display title.")
  .option("--description <description>", "One-line summary.")
  .option("--resource <resource>", "Source resource URI.")
  .option("--tags <tags>", "Comma-separated tags.")
  .option("--body <body>", "Markdown body.")
  .action(
    async (
      bundleSlug: string,
      path: string,
      opts: {
        type: string;
        title?: string;
        description?: string;
        resource?: string;
        tags?: string;
        body?: string;
      },
    ) => {
      const result = await withServices((svc) =>
        svc.conceptService.upsert(bundleSlug, path, {
          type: opts.type,
          ...(opts.title !== undefined ? { title: opts.title } : {}),
          ...(opts.description !== undefined ? { description: opts.description } : {}),
          ...(opts.resource !== undefined ? { resource: opts.resource } : {}),
          ...(opts.tags !== undefined ? { tags: opts.tags.split(",").map((t) => t.trim()) } : {}),
          ...(opts.body !== undefined ? { body: opts.body } : {}),
        }),
      );
      console.log(JSON.stringify(result, null, 2));
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
  .description("Search concepts. Prefer --must/--should structured keywords over raw text.")
  .option("--must <keywords>", "Comma-separated keywords that MUST match (AND).")
  .option("--should <keywords>", "Comma-separated keywords that broaden recall (OR).")
  .option("--bundle <slug>", "Restrict to one bundle.")
  .option("--type <type>", "Filter by concept type.")
  .option("--tags <tags>", "Comma-separated tags to require.")
  .option("--scopes <scopes>", "Comma-separated named scope keys.")
  .option("--project <proj>", "Include concepts relevant to this project.")
  .option("--no-global", "With --bundle, do NOT fold in the reserved 'global' bundle.")
  .option("--limit <n>", "Max results.", (v) => parseInt(v, 10))
  .action(
    async (
      text: string | undefined,
      opts: {
        must?: string;
        should?: string;
        bundle?: string;
        type?: string;
        tags?: string;
        scopes?: string;
        project?: string;
        global?: boolean;
        limit?: number;
      },
    ) => {
      const splitList = (v: string) =>
        v
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      try {
        const results = await withServices((svc) =>
          svc.searchService.search({
            ...(text !== undefined ? { text } : {}),
            ...(opts.must !== undefined ? { must_include: splitList(opts.must) } : {}),
            ...(opts.should !== undefined ? { should_include: splitList(opts.should) } : {}),
            ...(opts.bundle !== undefined ? { bundlePath: opts.bundle } : {}),
            ...(opts.type !== undefined ? { type: opts.type } : {}),
            ...(opts.tags !== undefined ? { tags: splitList(opts.tags) } : {}),
            ...(opts.scopes !== undefined ? { scopes: splitList(opts.scopes) } : {}),
            ...(opts.project !== undefined ? { project: opts.project } : {}),
            ...(opts.global === false ? { includeGlobal: false } : {}),
            ...(opts.limit !== undefined ? { limit: opts.limit } : {}),
          }),
        );
        if (results.length === 0) {
          console.log(
            JSON.stringify(
              {
                status: "success",
                results: [],
                system_directive:
                  "0 results found. If you passed 'must_include', retry the search using 'should_include' to broaden the scope. If the user provided new information, use 'okf_concept_upsert' to store it.",
              },
              null,
              2,
            ),
          );
          return;
        }
        console.log(JSON.stringify({ status: "success", results }, null, 2));
      } catch (err) {
        if (err instanceof SearchQuerySyntaxError) {
          console.log(
            JSON.stringify(
              {
                status: "error",
                system_directive:
                  "Syntax Error processing the search query. Simplify your search terms and try again.",
              },
              null,
              2,
            ),
          );
          return;
        }
        throw err;
      }
    },
  );

program
  .command("serve")
  .description("Expose the vault over MCP (stdio + HTTP) and a REST API.")
  .option("--host <host>", "REST API bind host (env HOST)", config.HOST)
  .option("--port <port>", "REST API port (env PORT)", String(config.PORT))
  .option("--database-url <url>", "Postgres connection string (env DATABASE_URL)")
  .option("--log-level <level>", "Log level (env LOG_LEVEL)")
  .option("--log-pretty", "Pretty-print logs (env LOG_PRETTY)")
  .option("--cors-origins <origins>", "Comma-separated origins or '*' (env CORS_ORIGINS)")
  .option("--api-key <key>", "Bearer token for auth (env API_KEY)")
  .option("--max-body-size <bytes>", "Max request body in bytes (env MAX_BODY_SIZE)")
  .option("--rate-limit-rps <rps>", "Max requests/sec per IP (env RATE_LIMIT_RPS)")
  .option("--mcp-transport <mode>", "MCP transport: stdio|http|sse|both (env MCP_TRANSPORT)")
  .option("--migrate", "Apply pending migrations before serving.")
  .action(
    async (opts: {
      host: string;
      port: string;
      databaseUrl?: string;
      logLevel?: string;
      logPretty?: boolean;
      corsOrigins?: string;
      apiKey?: string;
      maxBodySize?: string;
      rateLimitRps?: string;
      mcpTransport?: string;
      migrate?: boolean;
    }) => {
      // Re-resolve config with CLI flags as highest-precedence overrides so they
      // are validated/coerced by the same schema as env/file values.
      const overrides: Record<string, string> = {};
      const set = (key: string, value: string | undefined) => {
        if (value !== undefined) overrides[key] = value;
      };
      // --database-url falls back to the global option for backward compatibility.
      set("DATABASE_URL", opts.databaseUrl ?? program.opts<{ databaseUrl?: string }>().databaseUrl);
      set("HOST", opts.host);
      set("PORT", opts.port);
      set("LOG_LEVEL", opts.logLevel);
      if (opts.logPretty === true) set("LOG_PRETTY", "true");
      set("CORS_ORIGINS", opts.corsOrigins);
      set("API_KEY", opts.apiKey);
      set("MAX_BODY_SIZE", opts.maxBodySize);
      set("RATE_LIMIT_RPS", opts.rateLimitRps);
      set("MCP_TRANSPORT", opts.mcpTransport);

      const merged = loadConfig(undefined, overrides);
      const serveLog = createLogger(merged);

      if (opts.migrate === true) await runMigrations(merged.DATABASE_URL, serveLog);
      const handle = createDb(merged.DATABASE_URL);
      await serve({
        config: merged,
        log: serveLog,
        db: handle.db,
        onShutdown: () => handle.close(),
      });
    },
  );

program.parseAsync().catch((error: unknown) => {
  log.error({ err: error }, "Fatal error");
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
