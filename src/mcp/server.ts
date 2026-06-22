import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import type { Database } from "../db/client.js";
import { createServices } from "../services/factory.js";
import { serializeConcept } from "../services/okf-document.js";
import { pathsBySubtree } from "../services/paths-by-subtree.js";
import type { Config } from "../config.js";
import type { Logger } from "../logger.js";

export interface ServeOptions {
  readonly config: Config;
  readonly log: Logger;
  readonly db: Database;
  readonly onShutdown?: () => Promise<void>;
}

function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

/**
 * Builds the MCP server exposing OKF bundles and concepts as Tools. The tool
 * surface mirrors the REST API so an agent can discover (list/index/search)
 * and mutate (create/update/delete) without falling back to raw file paths.
 */
export function createMcpServer(db: Database, log: Logger): McpServer {
  const svc = createServices(db);
  const bundles = svc.bundleService;
  const concepts = svc.conceptService;
  const search = svc.searchService;
  const indexer = svc.indexService;
  const conceptRepo = svc.conceptRepo;

  const server = new McpServer({ name: "okf-vault", version: "0.2.0" });

  server.registerTool(
    "okf_bundle_list",
    { title: "List bundles", description: "List all knowledge bundles.", inputSchema: {} },
    async () => {
      log.debug("MCP okf_bundle_list");
      const rows = await bundles.list();
      return json(rows.map((b) => ({ slug: b.slug, title: b.title, description: b.description })));
    },
  );

  server.registerTool(
    "okf_bundle_create",
    {
      title: "Create bundle",
      description: "Create a knowledge bundle identified by a slug.",
      inputSchema: {
        slug: z.string().min(1).max(200),
        title: z.string().max(500).optional(),
        description: z.string().max(2000).optional(),
      },
    },
    async ({ slug, title, description }) => {
      log.debug({ slug }, "MCP okf_bundle_create");
      const b = await bundles.create({
        slug,
        ...(title !== undefined ? { title } : {}),
        ...(description !== undefined ? { description } : {}),
      });
      return json({ slug: b.slug, title: b.title, description: b.description });
    },
  );

  server.registerTool(
    "okf_bundle_delete",
    {
      title: "Delete bundle",
      description: "Soft-delete a bundle and its concepts.",
      inputSchema: { slug: z.string() },
    },
    async ({ slug }) => {
      log.debug({ slug }, "MCP okf_bundle_delete");
      await bundles.delete(slug);
      return json({ deleted: slug });
    },
  );

  server.registerTool(
    "okf_bundle_index",
    {
      title: "Bundle index",
      description:
        "Directory listing for progressive disclosure. Optionally scope to a subdirectory path.",
      inputSchema: { bundle: z.string(), path: z.string().optional() },
    },
    async ({ bundle, path }) => {
      log.debug({ bundle, path }, "MCP okf_bundle_index");
      const segments = [bundle, ...(path ?? "").split("/")].filter(Boolean);
      return json(await indexer.index(segments));
    },
  );

  server.registerTool(
    "okf_concept_search",
    {
      title: "Search concepts",
      description: [
        "Full-text + structured search across concepts, ranked by relevance.",
        "Filter by `bundle`, `type`, `tags`, named `scopes`, and `project`.",
        "Global concepts are always included regardless of scope.",
      ].join(" "),
      inputSchema: {
        bundle: z.string().optional(),
        text: z.string().max(500).optional(),
        type: z.string().max(200).optional(),
        tags: z.array(z.string()).optional(),
        scopes: z.array(z.string()).optional(),
        project: z.string().max(200).optional(),
        limit: z.number().int().min(1).max(100).optional(),
        offset: z.number().int().min(0).optional(),
      },
    },
    async ({ bundle, text, type, tags, scopes, project, limit, offset }) => {
      log.debug({ bundle, text, type, scopes, project }, "MCP okf_concept_search");
      return json(
        await search.search({
          ...(bundle !== undefined ? { bundlePath: bundle } : {}),
          ...(text !== undefined ? { text } : {}),
          ...(type !== undefined ? { type } : {}),
          ...(tags !== undefined ? { tags } : {}),
          ...(scopes !== undefined ? { scopes } : {}),
          ...(project !== undefined ? { project } : {}),
          ...(limit !== undefined ? { limit } : {}),
          ...(offset !== undefined ? { offset } : {}),
        }),
      );
    },
  );

  server.registerTool(
    "okf_concept_get",
    {
      title: "Get concept",
      description: "Read a concept by bundle slug and concept path (with or without .md).",
      inputSchema: { bundle: z.string(), path: z.string() },
    },
    async ({ bundle, path }) => {
      log.debug({ bundle, path }, "MCP okf_concept_get");
      return json(await concepts.read(bundle, path, { trackRead: true }));
    },
  );

  server.registerTool(
    "okf_concept_create",
    {
      title: "Create concept",
      description: "Create a concept with OKF frontmatter. `type` is required.",
      inputSchema: {
        bundle: z.string(),
        path: z.string(),
        type: z.string().min(1).max(200),
        title: z.string().max(500).optional(),
        description: z.string().max(2000).optional(),
        resource: z.string().max(2000).optional(),
        tags: z.array(z.string().max(200)).optional(),
        body: z.string().max(1_048_576).optional(),
      },
    },
    async ({ bundle, path, type, title, description, resource, tags, body }) => {
      log.debug({ bundle, path }, "MCP okf_concept_create");
      return json(
        await concepts.create(bundle, path, {
          type,
          ...(title !== undefined ? { title } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(resource !== undefined ? { resource } : {}),
          ...(tags !== undefined ? { tags } : {}),
          ...(body !== undefined ? { body } : {}),
        }),
      );
    },
  );

  server.registerTool(
    "okf_concept_update",
    {
      title: "Update concept",
      description: "Replace a concept's frontmatter fields and/or body.",
      inputSchema: {
        bundle: z.string(),
        path: z.string(),
        type: z.string().max(200).optional(),
        title: z.string().max(500).optional(),
        description: z.string().max(2000).optional(),
        resource: z.string().max(2000).optional(),
        tags: z.array(z.string().max(200)).optional(),
        body: z.string().max(1_048_576).optional(),
      },
    },
    async ({ bundle, path, type, title, description, resource, tags, body }) => {
      log.debug({ bundle, path }, "MCP okf_concept_update");
      const current = await concepts.read(bundle, path);
      return json(
        await concepts.update(
          bundle,
          path,
          {
            ...current.frontmatter,
            ...(type !== undefined ? { type } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(description !== undefined ? { description } : {}),
            ...(resource !== undefined ? { resource } : {}),
            ...(tags !== undefined ? { tags } : {}),
          },
          body ?? current.body,
        ),
      );
    },
  );

  server.registerTool(
    "okf_concept_delete",
    {
      title: "Delete concept",
      description: "Soft-delete a concept.",
      inputSchema: { bundle: z.string(), path: z.string() },
    },
    async ({ bundle, path }) => {
      log.debug({ bundle, path }, "MCP okf_concept_delete");
      await concepts.delete(bundle, path);
      return json({ deleted: `${bundle}/${path}` });
    },
  );

  server.registerPrompt(
    "create_concept",
    {
      title: "Create concept",
      description: "Prompt to guide concept creation with OKF frontmatter.",
      argsSchema: {
        bundle: z.string().describe("Bundle slug"),
        path: z.string().describe("Concept path (e.g. 'guides/deploy')"),
        type: z.string().describe("Concept type (e.g. Playbook, Reference)"),
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
              "Use the okf_concept_create tool with the following structure:",
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
        "List OKF references extracted from a concept's body (okf:// URIs and relative paths).",
      inputSchema: { bundle: z.string(), path: z.string() },
    },
    async ({ bundle, path }) => {
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
      return json([...new Set(links)]);
    },
  );

  server.registerTool(
    "okf_concept_backlinks",
    {
      title: "Concept backlinks",
      description: "Find concepts in the same bundle whose body references the given concept path.",
      inputSchema: { bundle: z.string(), path: z.string() },
    },
    async ({ bundle, path }) => {
      log.debug({ bundle, path }, "MCP okf_concept_backlinks");
      const segments = bundle.split("/").filter(Boolean);
      const { bundle: resolved } = await bundles.resolve(segments);
      const rows = await conceptRepo.listByBundle(resolved.id);
      const results: { id: string; type: string; title?: string }[] = [];
      for (const row of rows) {
        if (row.body.includes(path) || row.body.includes(`okf://${bundle}/${path}`)) {
          results.push({
            id: row.slug,
            type: row.type,
            ...(row.title ? { title: row.title } : {}),
          });
        }
      }
      return json(results);
    },
  );

  server.registerTool(
    "okf_concept_history",
    {
      title: "Concept history",
      description: "List all saved versions of a concept (past 8 snapshots).",
      inputSchema: { bundle: z.string(), path: z.string() },
    },
    async ({ bundle, path }) => {
      log.debug({ bundle, path }, "MCP okf_concept_history");
      return json(await concepts.listVersions(bundle, path));
    },
  );

  server.registerTool(
    "okf_concept_read_version",
    {
      title: "Read concept version",
      description: "Read a specific historical version of a concept by version number.",
      inputSchema: { bundle: z.string(), path: z.string(), version: z.number().int().min(1) },
    },
    async ({ bundle, path, version }) => {
      log.debug({ bundle, path, version }, "MCP okf_concept_read_version");
      return json(await concepts.readVersion(bundle, path, version));
    },
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

/**
 * Starts the REST API and MCP server in the same process and registers
 * graceful-shutdown handlers that drain HTTP and close the database pool.
 * MCP transport can be "stdio" (default) or "sse".
 */
export async function serve({ config, log, db, onShutdown }: ServeOptions): Promise<void> {
  const { createApiServer } = await import("../api/server.js");
  const { serve: honoServe } = await import("@hono/node-server");

  const mcpServer = createMcpServer(db, log);
  const apiApp = createApiServer({ config, log, db });

  const transport = config.MCP_TRANSPORT ?? "stdio";

  let sseTransport: SSEServerTransport | undefined;

  if (transport === "sse") {
    apiApp.get("/mcp", async (c) => {
      const incoming = c.env as {
        incoming: import("node:http").IncomingMessage;
        outgoing: import("node:http").ServerResponse;
      };
      sseTransport = new SSEServerTransport("/mcp", incoming.outgoing);
      await mcpServer.connect(sseTransport);
      await sseTransport.start();
    });

    apiApp.post("/mcp", async (c) => {
      const incoming = c.env as {
        incoming: import("node:http").IncomingMessage;
        outgoing: import("node:http").ServerResponse;
      };
      if (!sseTransport) {
        return c.json({ error: "SSE connection not established" }, 500);
      }
      await sseTransport.handlePostMessage(incoming.incoming, incoming.outgoing, c.req.raw.body);
    });
  }

  const httpServer = await new Promise<ReturnType<typeof honoServe>>((resolve, reject) => {
    try {
      const srv = honoServe(
        { fetch: apiApp.fetch, hostname: config.HOST, port: config.PORT },
        (info) => {
          log.info({ host: config.HOST, port: info.port }, "REST API listening");
          log.info(`OpenAPI: http://${config.HOST}:${info.port}/openapi.json`);
          log.info(`Docs:    http://${config.HOST}:${info.port}/docs`);
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
    void sseTransport?.close().catch(() => {});
    httpServer.close((err) => {
      if (err) log.error({ err }, "Error closing HTTP server");
      void Promise.resolve(onShutdown?.()).finally(() => process.exit(err ? 1 : 0));
    });
  };

  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));

  if (transport === "stdio") {
    log.info({ transport: "stdio" }, "MCP server starting");
    await mcpServer.connect(new StdioServerTransport());
  } else {
    log.info(
      { transport: "sse", url: `http://${config.HOST}:${config.PORT}/mcp` },
      "MCP SSE listening",
    );
  }
}

// pathsBySubtree imported from ../services/paths-by-subtree.js
