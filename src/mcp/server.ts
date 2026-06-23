import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { createServices } from "../services/factory.js";
import { serializeConcept } from "../services/okf-document.js";
import { pathsBySubtree } from "../services/paths-by-subtree.js";
import { conceptTypeGuide } from "../domain/concept-types.js";
import {
  json,
  jsonWithDirective,
  runTool,
  resolveConceptAddress,
  toToolError,
} from "./tool-helpers.js";
import { SearchQuerySyntaxError } from "../services/search-query.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";

const TYPE_FIELD_DESCRIPTION = [
  "The concept's category. Choose the single best-fitting type from the catalog below",
  "(custom types are allowed but discouraged):",
  "",
  conceptTypeGuide(),
].join("\n");

const BUNDLE_NAMING_GUIDANCE =
  "Bundle naming: use 'global' for knowledge NOT tied to a specific project (user preferences, " +
  "cross-cutting standards, general facts). For project-specific knowledge, use the git repository " +
  "name or project name as the bundle (e.g. 'okf-vault'). The 'global' bundle always exists.";

const TRIGGER_RULES =
  " TRIGGER RULES: You MUST execute 'okf_concept_upsert' autonomously immediately after " +
  "successfully completing a complex multi-step task. Consolidate the key decisions made during " +
  "the current interaction and save them before replying to the user. Also run this with long " +
  "conversations from time to time if necessary.";

const BUNDLE_DESC =
  "Root bundle slug. Use 'global' for cross-project knowledge, or the git repo / project name for " +
  "project-specific knowledge (e.g. 'okf-vault'). May also be a nested address like 'okf-vault/api'.";
const PATH_DESC =
  "Concept path within the bundle, slash-separated, no leading slash, '.md' optional " +
  "(e.g. 'preferences/formatting'). Intermediate directories are auto-created on write.";

export interface ServeOptions {
  readonly config: Config;
  readonly log: Logger;
  readonly db: Database;
  readonly onShutdown?: () => Promise<void>;
}

/**
 * Builds the MCP server exposing OKF bundles and concepts as Tools. Concepts
 * live in named bundles: use the reserved `global` bundle for cross-project
 * knowledge, or the git repo / project name for project-specific knowledge.
 * The agent discovers (list/index/search) and mutates (upsert) without ever
 * touching raw file paths.
 */
export function createMcpServer(db: Database, log: Logger): McpServer {
  const svc = createServices(db);
  const bundles = svc.bundleService;
  const concepts = svc.conceptService;
  const search = svc.searchService;
  const indexer = svc.indexService;
  const conceptRepo = svc.conceptRepo;

  // The reserved `global` bundle must always exist.
  void bundles.ensureGlobal().catch((err: unknown) => log.error({ err }, "ensureGlobal failed"));

  const server = new McpServer({ name: "okf-vault", version: "0.2.0" });

  server.registerTool(
    "okf_bundle_list",
    {
      title: "List bundles",
      description:
        "List all top-level knowledge bundles (slug, title, description). Use this to discover " +
        "which bundles exist before indexing or searching." +
        TRIGGER_RULES,
      inputSchema: {},
    },
    async () =>
      runTool(async () => {
        log.debug("MCP okf_bundle_list");
        const rows = await bundles.list();
        return jsonWithDirective(
          rows.map((b) => ({ slug: b.slug, title: b.title, description: b.description })),
        );
      }),
  );

  server.registerTool(
    "okf_bundle_create",
    {
      title: "Create bundle",
      description:
        "Create a top-level knowledge bundle (a namespace for related concepts). Note: writing a " +
        "concept with okf_concept_upsert auto-creates intermediate directories, so you rarely need " +
        "this unless seeding a brand-new root namespace." +
        TRIGGER_RULES,
      inputSchema: {
        slug: z
          .string()
          .min(1)
          .max(200)
          .describe("Unique bundle identifier, lowercase-kebab recommended (e.g. 'memory')."),
        title: z.string().max(500).optional().describe("Human-readable display title."),
        description: z.string().max(2000).optional().describe("One-line summary of the bundle."),
      },
    },
    async ({ slug, title, description }) =>
      runTool(async () => {
        log.debug({ slug }, "MCP okf_bundle_create");
        const b = await bundles.create({
          slug,
          ...(title !== undefined ? { title } : {}),
          ...(description !== undefined ? { description } : {}),
        });
        return json({ slug: b.slug, title: b.title, description: b.description });
      }),
  );

  server.registerTool(
    "okf_bundle_delete",
    {
      title: "Delete bundle",
      description:
        "DESTRUCTIVE. Soft-delete a bundle and ALL of its concepts. Avoid in the append/update " +
        "memory model — prefer updating concepts via okf_concept_upsert. Use only on explicit request." +
        TRIGGER_RULES,
      inputSchema: { slug: z.string().describe("Slug of the bundle to soft-delete.") },
    },
    async ({ slug }) =>
      runTool(async () => {
        log.debug({ slug }, "MCP okf_bundle_delete");
        await bundles.delete(slug);
        return json({ status: "success", deleted: slug });
      }),
  );

  server.registerTool(
    "okf_bundle_index",
    {
      title: "Bundle index",
      description:
        "List the directory structure of a bundle. Use this when you need to understand the " +
        "hierarchy of stored concepts before searching. Returns a tree of titles/links, not bodies." +
        TRIGGER_RULES,
      inputSchema: {
        bundle: z.string().describe(BUNDLE_DESC),
        path: z
          .string()
          .optional()
          .describe("Optional sub-directory to scope the listing (e.g. 'projects/api')."),
      },
    },
    async ({ bundle, path }) =>
      runTool(async () => {
        log.debug({ bundle, path }, "MCP okf_bundle_index");
        const segments = [bundle, ...(path ?? "").split("/")].filter(Boolean);
        return jsonWithDirective(await indexer.index(segments));
      }),
  );

  server.registerTool(
    "okf_concept_search",
    {
      title: "Search concepts",
      description:
        "Search long-term memory for past context, user preferences, or system states. " +
        "ALWAYS use this tool first when a user asks a question about past interactions, " +
        "established projects, or personal preferences before answering. " +
        "Returns a lightweight list of matches (link, title, summary snippet) — NOT full " +
        "documents. Pick the most relevant 'link' and call okf_concept_get to read its full content. " +
        BUNDLE_NAMING_GUIDANCE +
        TRIGGER_RULES,
      inputSchema: {
        must_include: z
          .array(z.string())
          .optional()
          .describe("Keywords that MUST be present in the document (acts as AND)."),
        should_include: z
          .array(z.string())
          .optional()
          .describe("Keywords that are relevant but not strictly required (acts as OR)."),
        text: z
          .string()
          .max(500)
          .optional()
          .describe(
            "Optional free-text query. Used only when must_include/should_include are absent.",
          ),
        bundle: z
          .string()
          .optional()
          .describe("Restrict the search to this bundle (or sub-path). Omit to search everything."),
        type: z
          .string()
          .max(200)
          .optional()
          .describe(
            "Filter to a single concept type (e.g. Preference, Architecture, Reference). See okf_concept_upsert for the full catalog.",
          ),
        tags: z.array(z.string()).optional().describe("Require ALL of these tags to be present."),
        scopes: z
          .array(z.string())
          .optional()
          .describe("Named scope keys to include (global concepts are always included)."),
        project: z
          .string()
          .max(200)
          .optional()
          .describe("Include concepts scoped to this project."),
        include_global: z
          .boolean()
          .optional()
          .describe(
            "When a 'bundle' is set, also fold in matches from the reserved 'global' bundle " +
              "(bundle-local matches rank first). Defaults to true. Set false to search ONLY the " +
              "specified bundle.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Max results to return (default 20, max 100)."),
        offset: z.number().int().min(0).optional().describe("Pagination offset (default 0)."),
      },
    },
    async ({
      must_include,
      should_include,
      text,
      bundle,
      type,
      tags,
      scopes,
      project,
      include_global,
      limit,
      offset,
    }) => {
      log.debug(
        { bundle, must_include, should_include, type, scopes, project, include_global },
        "MCP okf_concept_search",
      );
      try {
        const results = await search.search({
          ...(bundle !== undefined ? { bundlePath: bundle } : {}),
          ...(must_include !== undefined ? { must_include } : {}),
          ...(should_include !== undefined ? { should_include } : {}),
          ...(text !== undefined ? { text } : {}),
          ...(type !== undefined ? { type } : {}),
          ...(tags !== undefined ? { tags } : {}),
          ...(scopes !== undefined ? { scopes } : {}),
          ...(project !== undefined ? { project } : {}),
          ...(include_global !== undefined ? { includeGlobal: include_global } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(offset !== undefined ? { offset } : {}),
        });
        if (results.length === 0) {
          return jsonWithDirective({
            status: "success",
            results: [],
            system_directive:
              "0 results found. If you passed 'must_include', retry the search using 'should_include' to broaden the scope. If the user provided new information, use 'okf_concept_upsert' to store it.",
          });
        }
        return jsonWithDirective({
          status: "success",
          results,
          system_directive:
            "These are lightweight previews, not full documents. Review the snippets, then call 'okf_concept_get' with the 'link' (or bundle + path) of ONLY the concept(s) critically relevant to the current turn.",
        });
      } catch (err) {
        if (err instanceof SearchQuerySyntaxError) {
          return json({
            status: "error",
            error_code: "SEARCH_SYNTAX",
            system_directive:
              "Syntax Error processing the search query. Simplify your search terms and try again.",
          });
        }
        return json(toToolError(err));
      }
    },
  );

  server.registerTool(
    "okf_concept_get",
    {
      title: "Get concept",
      description:
        "Fetch the FULL markdown of ONE concept. This is step 2 of the search→get loop: call it " +
        "after okf_concept_search to hydrate a result you selected. Accepts the search result's " +
        "'link' (okf:// URI) OR an explicit bundle + path." +
        TRIGGER_RULES,
      inputSchema: {
        link: z
          .string()
          .optional()
          .describe(
            "An okf:// URI from a search result (e.g. 'okf://memory/preferences/tone'). " +
              "Case-insensitive. Provide this OR bundle+path.",
          ),
        bundle: z
          .string()
          .optional()
          .describe(BUNDLE_DESC + " Required if 'link' is omitted."),
        path: z
          .string()
          .optional()
          .describe(PATH_DESC + " Required if 'link' is omitted."),
      },
    },
    async ({ link, bundle, path }) =>
      runTool(async () => {
        log.debug({ link, bundle, path }, "MCP okf_concept_get");
        const addr = resolveConceptAddress({ link, bundle, path });
        const concept = await concepts.read(addr.bundle, addr.path, { trackRead: true });
        const markdown =
          serializeConcept(concept.frontmatter, concept.body) +
          "\n\n[System Note: If any of this retrieved information is now outdated based on the user's latest prompt, immediately use 'okf_concept_upsert' to update it.]";
        // Return metadata + rendered markdown; omit the duplicate raw `body`.
        const { id, scope, frontmatter } = concept;
        return jsonWithDirective({ id, scope, frontmatter, markdown });
      }),
  );

  server.registerTool(
    "okf_concept_upsert",
    {
      title: "Upsert concept",
      description:
        "Store or update a verified fact, preference, procedure, system state, or multi-step " +
        "behavior in long-term memory. Creates the concept if it does not exist, otherwise updates " +
        "it (saving a version snapshot). " +
        BUNDLE_NAMING_GUIDANCE +
        " TRIGGER RULES: You MUST execute this tool autonomously immediately after successfully " +
        "completing a complex multi-step task. Consolidate the key decisions made during the " +
        "current interaction and save them before replying to the user. Also run this with long " +
        "conversations from time to time if necessary.",
      inputSchema: {
        bundle: z.string().describe(BUNDLE_DESC),
        path: z.string().describe(PATH_DESC),
        type: z.string().min(1).max(200).describe(TYPE_FIELD_DESCRIPTION),
        title: z.string().max(500).optional().describe("Display title."),
        description: z.string().max(2000).optional().describe("One-line summary."),
        resource: z
          .string()
          .max(2000)
          .optional()
          .describe("Source/reference URI for this concept."),
        tags: z.array(z.string().max(200)).optional().describe("Lowercase keyword tags."),
        body: z.string().max(1_048_576).optional().describe("Markdown body content."),
      },
    },
    async ({ bundle, path, type, title, description, resource, tags, body }) =>
      runTool(async () => {
        log.debug({ bundle, path }, "MCP okf_concept_upsert");
        return json(
          await concepts.upsert(bundle, path, {
            type,
            ...(title !== undefined ? { title } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(resource !== undefined ? { resource } : {}),
            ...(tags !== undefined ? { tags } : {}),
            ...(body !== undefined ? { body } : {}),
          }),
        );
      }),
  );

  server.registerTool(
    "okf_concept_delete",
    {
      title: "Delete concept",
      description:
        "DESTRUCTIVE. Soft-delete a single concept. Avoid in the append/update memory model — " +
        "prefer correcting content via okf_concept_upsert. Use only on explicit request." +
        TRIGGER_RULES,
      inputSchema: {
        bundle: z.string().describe(BUNDLE_DESC),
        path: z.string().describe(PATH_DESC),
      },
    },
    async ({ bundle, path }) =>
      runTool(async () => {
        log.debug({ bundle, path }, "MCP okf_concept_delete");
        await concepts.delete(bundle, path);
        return json({ status: "success", deleted: `${bundle}/${path}` });
      }),
  );

  server.registerPrompt(
    "create_concept",
    {
      title: "Create concept",
      description: "Guide concept creation with OKF frontmatter via okf_concept_upsert.",
      argsSchema: {
        bundle: z.string().describe("Bundle slug (e.g. 'global' or a project name)."),
        path: z.string().describe("Concept path within the bundle (e.g. 'guides/deploy')."),
        type: z
          .string()
          .describe("Concept type (e.g. Preference, Architecture, Reference, Playbook)."),
      },
    },
    ({ bundle, path, type }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Create a new concept in bundle "${bundle}" at path "${path}" of type "${type}".`,
              "",
              "Use the okf_concept_upsert tool with the following structure:",
              `- bundle: ${bundle}`,
              `- path: ${path}`,
              `- type: ${type}`,
              "- body: markdown content describing the concept",
              "",
              "Include relevant frontmatter fields (title, description, tags) as appropriate.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.registerTool(
    "okf_concept_links",
    {
      title: "Concept links",
      description:
        "List outbound OKF references in a concept's body (okf:// URIs and relative paths). Use to " +
        "traverse the knowledge graph forward from a concept you are reading." +
        TRIGGER_RULES,
      inputSchema: {
        bundle: z.string().describe(BUNDLE_DESC),
        path: z.string().describe(PATH_DESC),
      },
    },
    async ({ bundle, path }) =>
      runTool(async () => {
        log.debug({ bundle, path }, "MCP okf_concept_links");
        const concept = await concepts.read(bundle, path);
        const links: string[] = [];
        const okfRe = /\[([^\]]*)\]\(okf:\/\/([^)]+)\)/g;
        let m: RegExpExecArray | null;
        while ((m = okfRe.exec(concept.body)) !== null) {
          if (m[2]) links.push(m[2]);
        }
        const relRe = /\[([^\]]*)\]\(\.\/([^)]+)\)/g;
        while ((m = relRe.exec(concept.body)) !== null) {
          if (m[2]) links.push(m[2].replace(/\.md$/, ""));
        }
        return jsonWithDirective([...new Set(links)]);
      }),
  );

  server.registerTool(
    "okf_concept_backlinks",
    {
      title: "Concept backlinks",
      description:
        "Find concepts in the same bundle whose body references the given concept path. Use to " +
        "traverse the knowledge graph backward (what depends on / mentions this concept)." +
        TRIGGER_RULES,
      inputSchema: {
        bundle: z.string().describe(BUNDLE_DESC),
        path: z.string().describe(PATH_DESC),
      },
    },
    async ({ bundle, path }) =>
      runTool(async () => {
        log.debug({ bundle, path }, "MCP okf_concept_backlinks");
        const segments = bundle.split("/").filter(Boolean);
        const { bundle: resolved, path: bundlePath } = await bundles.resolve(segments);
        const rows = await conceptRepo.listByBundle(resolved.id);
        // Match references case-insensitively against the (lowercased) target.
        const target = path.toLowerCase();
        const okfTarget = `okf://${bundlePath}/${target}`;
        const results: { id: string; link: string; type: string; title?: string }[] = [];
        for (const row of rows) {
          const body = row.body.toLowerCase();
          if (body.includes(target) || body.includes(okfTarget)) {
            results.push({
              id: row.slug,
              link: `okf://${bundlePath}/${row.slug}`,
              type: row.type,
              ...(row.title ? { title: row.title } : {}),
            });
          }
        }
        return jsonWithDirective(results);
      }),
  );

  server.registerTool(
    "okf_concept_history",
    {
      title: "Concept history",
      description:
        "List saved version snapshots of a concept (most recent first). Use to see how a concept " +
        "changed over time before reading a specific version with okf_concept_read_version." +
        TRIGGER_RULES,
      inputSchema: {
        bundle: z.string().describe(BUNDLE_DESC),
        path: z.string().describe(PATH_DESC),
      },
    },
    async ({ bundle, path }) =>
      runTool(async () => {
        log.debug({ bundle, path }, "MCP okf_concept_history");
        return jsonWithDirective(await concepts.listVersions(bundle, path));
      }),
  );

  server.registerTool(
    "okf_concept_read_version",
    {
      title: "Read concept version",
      description:
        "Read a specific historical version of a concept by version number (obtain numbers from " +
        "okf_concept_history)." +
        TRIGGER_RULES,
      inputSchema: {
        bundle: z.string().describe(BUNDLE_DESC),
        path: z.string().describe(PATH_DESC),
        version: z.number().int().min(1).describe("Version number from okf_concept_history."),
      },
    },
    async ({ bundle, path, version }) =>
      runTool(async () => {
        log.debug({ bundle, path, version }, "MCP okf_concept_read_version");
        return jsonWithDirective(await concepts.readVersion(bundle, path, version));
      }),
  );

  server.registerResource(
    "concept",
    new ResourceTemplate("okf://{bundle}/{+path}", {
      list: async () => {
        const bundleRepo = svc.bundleRepo;
        const roots = await bundles.list();
        const resources: { uri: string; name: string; description?: string; mimeType: string }[] =
          [];
        for (const root of roots) {
          const subtree = await bundleRepo.listSubtree(root.id);
          const paths = pathsBySubtree(root.slug, subtree);
          for (const b of subtree) {
            const chain = paths.get(b.id) ?? root.slug;
            const rows = await conceptRepo.listByBundle(b.id);
            for (const row of rows) {
              resources.push({
                uri: `okf://${chain}/${row.slug}`,
                name: row.title ?? row.slug,
                ...(row.description ? { description: row.description } : {}),
                mimeType: "text/markdown",
              });
            }
          }
        }
        return { resources };
      },
    }),
    { title: "OKF Concept", description: "An OKF concept document", mimeType: "text/markdown" },
    async (uri, variables) => {
      const bundle = variables["bundle"] as string;
      const path = variables["path"] as string;
      const concept = await concepts.read(bundle, path, { trackRead: true });
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "text/markdown",
            text: serializeConcept(concept.frontmatter, concept.body),
          },
        ],
      };
    },
  );

  return server;
}

/** Raw Node req/res pair surfaced by @hono/node-server via `c.env`. */
interface NodeHttpEnv {
  readonly incoming: import("node:http").IncomingMessage;
  readonly outgoing: import("node:http").ServerResponse;
}

/**
 * Starts the REST API and MCP server in the same process and registers
 * graceful-shutdown handlers that drain HTTP and close the database pool.
 *
 * The Streamable HTTP MCP endpoint (`/mcp`) is ALWAYS mounted so the server is
 * reachable by URL. When `MCP_TRANSPORT` is `stdio` (default) or `both`, a
 * stdio transport is additionally connected so a parent process can speak MCP
 * over stdin/stdout. Set `MCP_TRANSPORT=http` (or legacy `sse`) for HTTP only.
 */
export async function serve({ config, log, db, onShutdown }: ServeOptions): Promise<void> {
  const { createApiServer } = await import("../api/server.js");
  const { serve: honoServe } = await import("@hono/node-server");
  const { RESPONSE_ALREADY_SENT } = await import("@hono/node-server/utils/response");

  const apiApp = createApiServer({ config, log, db });

  const mode = config.MCP_TRANSPORT ?? "stdio";
  const enableStdio = mode === "stdio" || mode === "both";

  // ── Streamable HTTP transport (always mounted) ──────────────────────────
  // One transport + McpServer per session, keyed by the MCP session id header.
  const httpSessions = new Map<string, StreamableHTTPServerTransport>();

  const handleMcp = async (c: { req: { raw: Request }; env: unknown }) => {
    const { incoming, outgoing } = c.env as NodeHttpEnv;
    const sessionId = c.req.raw.headers.get("mcp-session-id") ?? undefined;
    const method = c.req.raw.method;

    let transport = sessionId ? httpSessions.get(sessionId) : undefined;

    if (!transport) {
      if (method !== "POST") {
        outgoing.statusCode = 400;
        outgoing.setHeader("content-type", "application/json");
        outgoing.end(
          JSON.stringify({
            jsonrpc: "2.0",
            error: { code: -32000, message: "No valid session. Initialize with a POST first." },
            id: null,
          }),
        );
        return RESPONSE_ALREADY_SENT;
      }
      // New session: spin up a fresh server bound to a new stateful transport.
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          httpSessions.set(id, transport!);
          log.debug({ sessionId: id }, "MCP HTTP session initialized");
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) httpSessions.delete(transport!.sessionId);
      };
      const server = createMcpServer(db, log);
      await server.connect(transport as Parameters<McpServer["connect"]>[0]);
    }

    let body: unknown;
    if (method === "POST") {
      try {
        body = await c.req.raw.clone().json();
      } catch {
        body = undefined;
      }
    }
    await transport.handleRequest(incoming, outgoing, body);
    return RESPONSE_ALREADY_SENT;
  };

  apiApp.post("/mcp", handleMcp);
  apiApp.get("/mcp", handleMcp);
  apiApp.delete("/mcp", handleMcp);

  const httpServer = await new Promise<ReturnType<typeof honoServe>>((resolve, reject) => {
    try {
      const srv = honoServe(
        { fetch: apiApp.fetch, hostname: config.HOST, port: config.PORT },
        (info) => {
          log.info({ host: config.HOST, port: info.port }, "REST API listening");
          log.info(`OpenAPI: http://${config.HOST}:${info.port}/openapi.json`);
          log.info(`Docs:    http://${config.HOST}:${info.port}/docs`);
          log.info(`MCP:     http://${config.HOST}:${info.port}/mcp (Streamable HTTP)`);
          resolve(srv);
        },
      );
      srv.on("error", (err: unknown) =>
        reject(err instanceof Error ? err : new Error(String(err))),
      );
    } catch (err) {
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "Shutdown signal — draining connections");
    for (const t of httpSessions.values()) void t.close().catch(() => {});
    httpSessions.clear();
    httpServer.close((err) => {
      if (err) log.error({ err }, "Error closing HTTP server");
      void Promise.resolve(onShutdown?.()).finally(() => process.exit(err ? 1 : 0));
    });
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  // ── stdio transport (optional) ──────────────────────────────────────────
  if (enableStdio) {
    const stdioServer = createMcpServer(db, log);
    log.info({ transport: mode }, "MCP stdio transport connecting");
    await stdioServer.connect(new StdioServerTransport());
  } else {
    log.info({ transport: mode }, "MCP over HTTP only (stdio disabled)");
  }
}

// pathsBySubtree imported from ../services/paths-by-subtree.js
