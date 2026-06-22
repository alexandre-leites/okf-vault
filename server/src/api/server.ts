import { Readable } from "node:stream";
import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { cors } from "hono/cors";
import { logger as httpLogger } from "hono/logger";
import { HTTPException } from "hono/http-exception";
import { bearerAuth } from "hono/bearer-auth";
import type { Logger } from "../logger.js";
import type { Config } from "../config.js";
import type { Database } from "../db/client.js";
import type { ConceptService } from "../services/concept-service.js";
import { sql } from "drizzle-orm";
import { createServices } from "../services/factory.js";
import { parseCorsOrigins } from "../config.js";
import { serializeConcept } from "../services/okf-document.js";
import {
  BundleNotFoundError,
  ConceptNotFoundError,
  ConflictError,
  OkfValidationError,
  ReservedConceptIdError,
} from "../domain/errors.js";
import { RateLimiter, bodySizeLimit, correlationId } from "./middleware.js";

const ScopeResponseSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("global") }),
  z.object({ kind: z.literal("named"), key: z.string() }),
  z.object({ kind: z.literal("project"), key: z.string() }),
]);

const BundleSchema = z.object({
  slug: z.string().openapi({ example: "acme-sales" }),
  title: z.string().nullable(),
  description: z.string().nullable(),
  okfVersion: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

const SearchResultSchema = z.object({
  bundle: z.string(),
  id: z.string(),
  type: z.string(),
  scope: ScopeResponseSchema,
  title: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
  snippet: z.string().optional(),
});

const ErrorSchema = z.object({ error: z.string() });

const CreateBundleBodySchema = z.object({
  slug: z.string().min(1).openapi({ example: "acme-sales" }),
  title: z.string().min(1).max(500),
  description: z.string().min(1).max(2000),
  parentPath: z.string().optional().openapi({
    description: "Slash-separated parent slug path to nest under (e.g. 'okf-vault/scopes').",
    example: "okf-vault/scopes",
  }),
});

const UpdateBundleBodySchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().min(1).max(2000),
});

const CreateConceptBodySchema = z.object({
  type: z.string().min(1).max(200).openapi({ example: "Architecture" }),
  title: z.string().min(1).max(500),
  description: z.string().min(1).max(2000),
  resource: z.string().max(2000).optional(),
  tags: z.array(z.string().max(200)).optional(),
  body: z.string().max(1_048_576).optional(),
});

const bundleParam = z.object({
  bundle: z.string().openapi({ description: "Bundle slug.", example: "acme-sales" }),
});

const BatchOperationSchema = z.object({
  method: z.enum(["POST", "PUT", "DELETE"]),
  bundle: z.string().min(1),
  path: z.string().min(1),
  type: z.string().max(200).optional(),
  title: z.string().max(500).optional(),
  description: z.string().max(2000).optional(),
  resource: z.string().max(2000).optional(),
  tags: z.array(z.string().max(200)).optional(),
  body: z.string().max(1_048_576).optional(),
});

const BatchBodySchema = z.object({
  operations: z.array(BatchOperationSchema).min(1).max(50),
});

const routes = {
  health: createRoute({
    method: "get",
    path: "/health",
    summary: "Health check",
    tags: ["System"],
    responses: {
      200: {
        content: { "application/json": { schema: z.object({ status: z.string() }) } },
        description: "Service and database reachable",
      },
      503: { content: { "application/json": { schema: ErrorSchema } }, description: "Unhealthy" },
    },
  }),

  bundleList: createRoute({
    method: "get",
    path: "/okf/bundles",
    summary: "List bundles",
    tags: ["Bundles"],
    responses: {
      200: {
        content: { "application/json": { schema: z.array(BundleSchema) } },
        description: "Bundles",
      },
    },
  }),

  bundleCreate: createRoute({
    method: "post",
    path: "/okf/bundles",
    summary: "Create a bundle",
    tags: ["Bundles"],
    request: {
      body: { content: { "application/json": { schema: CreateBundleBodySchema } }, required: true },
    },
    responses: {
      201: { content: { "application/json": { schema: BundleSchema } }, description: "Created" },
      409: { content: { "application/json": { schema: ErrorSchema } }, description: "Conflict" },
      422: { content: { "application/json": { schema: ErrorSchema } }, description: "Invalid" },
    },
  }),

  bundleDelete: createRoute({
    method: "delete",
    path: "/okf/bundles/{bundle}",
    summary: "Delete a bundle (soft delete)",
    tags: ["Bundles"],
    request: { params: bundleParam },
    responses: {
      204: { description: "Deleted" },
      404: { content: { "application/json": { schema: ErrorSchema } }, description: "Not found" },
    },
  }),

  bundleUpdate: createRoute({
    method: "patch",
    path: "/okf/bundles/{bundle}",
    summary: "Update a bundle's title and description",
    tags: ["Bundles"],
    request: {
      params: bundleParam,
      body: {
        content: { "application/json": { schema: UpdateBundleBodySchema } },
        required: true,
      },
    },
    responses: {
      200: { content: { "application/json": { schema: BundleSchema } }, description: "Updated" },
      404: { content: { "application/json": { schema: ErrorSchema } }, description: "Not found" },
      422: { content: { "application/json": { schema: ErrorSchema } }, description: "Invalid" },
    },
  }),

  bundleIndex: createRoute({
    method: "get",
    path: "/okf/bundles/{bundle}",
    summary: "Bundle directory listing (progressive disclosure)",
    description: "Synthesized OKF index.md for the bundle root (text/markdown).",
    tags: ["Bundles"],
    request: { params: bundleParam },
    responses: {
      200: {
        content: { "text/markdown": { schema: z.string() } },
        description: "Synthesized index.md (OKF §6)",
      },
      404: { content: { "application/json": { schema: ErrorSchema } }, description: "Not found" },
    },
  }),

  search: createRoute({
    method: "get",
    path: "/okf/search",
    summary: "Search concepts",
    description:
      "Full-text + structured search across bundles. Filter by bundle, type, tags, scopes, project. Ranked by relevance.",
    tags: ["Search"],
    request: {
      query: z.object({
        bundle: z.string().optional(),
        text: z.string().max(500).optional(),
        type: z.string().max(200).optional(),
        tags: z.string().max(500).optional().openapi({ example: "errors,oncall" }),
        scopes: z.string().max(500).optional().openapi({ example: "tech/typescript,network" }),
        project: z.string().max(200).optional(),
        include_global: z.coerce.boolean().optional().openapi({
          description:
            "With `bundle` set, also include matches from the reserved 'global' bundle (default true).",
        }),
        limit: z.coerce.number().int().min(1).max(100).optional(),
        offset: z.coerce.number().int().min(0).optional(),
      }),
    },
    responses: {
      200: {
        content: { "application/json": { schema: z.array(SearchResultSchema) } },
        description: "Matching concepts",
      },
    },
  }),

  batch: createRoute({
    method: "post",
    path: "/okf/batch",
    summary: "Batch operations",
    description:
      "Execute multiple concept operations (POST/PUT/DELETE) in one request. Each operation is independent.",
    tags: ["Concepts"],
    request: {
      body: { content: { "application/json": { schema: BatchBodySchema } }, required: true },
    },
    responses: {
      200: {
        content: {
          "application/json": {
            schema: z.array(
              z.object({ status: z.number(), path: z.string(), error: z.string().optional() }),
            ),
          },
        },
        description: "Batch results",
      },
    },
  }),
} as const;

export interface ApiServerOptions {
  readonly config: Config;
  readonly log: Logger;
  readonly db: Database;
}

/**
 * Creates the OpenAPI-documented Hono REST API over the OKF Postgres store.
 * Concept documents are returned as OKF markdown (`text/markdown`); bundle and
 * search responses are JSON. When `API_KEY` is set, all routes require a
 * matching bearer token.
 */
export function createApiServer({ config, log, db }: ApiServerOptions): OpenAPIHono {
  const svc = createServices(db, config);
  const bundles = svc.bundleService;
  const concepts = svc.conceptService;
  const search = svc.searchService;
  const indexer = svc.indexService;
  const exportService = svc.exportService;
  const importService = svc.importService;

  const app = new OpenAPIHono({
    defaultHook: (result, c) => {
      if (!result.success) {
        const issue = result.error.issues[0];
        const message = issue ? `${issue.path.join(".")}: ${issue.message}` : "Invalid request";
        return c.json({ error: message }, 422);
      }
    },
  });

  // The MCP Streamable HTTP endpoint hijacks the raw Node response, so the
  // standard Hono middleware (logger, correlation id, CORS) must NOT run on it
  // — otherwise they re-materialize a Response and Node throws
  // ERR_HTTP_HEADERS_SENT on the second write.
  const skipMcp =
    (mw: import("hono").MiddlewareHandler): import("hono").MiddlewareHandler =>
    (c, next) =>
      c.req.path === "/mcp" ? next() : mw(c, next);

  app.use("*", skipMcp(correlationId));

  const allowedOrigins = parseCorsOrigins(config.CORS_ORIGINS);
  if (allowedOrigins.length > 0) {
    app.use(
      "*",
      skipMcp(
        cors({
          origin:
            allowedOrigins.length === 1 && allowedOrigins[0] === "*"
              ? "*"
              : (origin) => (allowedOrigins.includes(origin) ? origin : null),
          allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
          allowHeaders: ["Content-Type", "Authorization"],
          maxAge: 86400,
        }),
      ),
    );
  }

  app.use("*", skipMcp(httpLogger((message, ...rest) => log.info({ msg: message }, ...rest))));

  const rateLimiter = new RateLimiter(config.RATE_LIMIT_RPS);
  app.use("/okf/*", async (c, next) => {
    rateLimiter.check(c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown");
    await next();
  });
  // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
  app.use("/okf/*", async (c, next) => bodySizeLimit(c, next, config.MAX_BODY_SIZE));

  const sweepTimer = setInterval(() => rateLimiter.sweep(), 60_000);
  sweepTimer.unref();

  if (config.API_KEY) {
    app.use("/okf/*", bearerAuth({ token: config.API_KEY }));
  }

  app.onError((err, c) => {
    if (err instanceof ConceptNotFoundError || err instanceof BundleNotFoundError) {
      log.warn(err.message);
      return c.json({ error: err.message }, 404);
    }
    if (err instanceof ConflictError) {
      log.warn(err.message);
      return c.json({ error: err.message }, 409);
    }
    if (err instanceof OkfValidationError || err instanceof ReservedConceptIdError) {
      log.warn(err.message);
      return c.json({ error: err.message }, 422);
    }
    if (err instanceof SyntaxError) {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (err instanceof HTTPException) {
      return c.json({ error: err.message }, err.status);
    }
    log.error({ err }, "Unhandled API error");
    return c.json({ error: "Internal server error" }, 500);
  });

  app.openapi(routes.health, async (c) => {
    try {
      await db.execute(sql`select 1`);
      return c.json({ status: "ok" }, 200);
    } catch {
      return c.json({ error: "Database not reachable" }, 503);
    }
  });

  app.openapi(routes.bundleList, async (c) => {
    const rows = await bundles.list();
    return c.json(
      rows.map((b) => ({
        slug: b.slug,
        title: b.title,
        description: b.description,
        okfVersion: b.okfVersion,
        createdAt: b.createdAt.toISOString(),
        updatedAt: b.updatedAt.toISOString(),
      })),
      200,
    );
  });

  app.openapi(routes.bundleCreate, async (c) => {
    const body = c.req.valid("json");
    const b = await bundles.create(body);
    log.info({ slug: b.slug }, "Bundle created");
    return c.json(
      {
        slug: b.slug,
        title: b.title,
        description: b.description,
        okfVersion: b.okfVersion,
        createdAt: b.createdAt.toISOString(),
        updatedAt: b.updatedAt.toISOString(),
      },
      201,
    );
  });

  app.openapi(routes.bundleDelete, async (c) => {
    const { bundle } = c.req.valid("param");
    await bundles.delete(bundle);
    log.info({ slug: bundle }, "Bundle soft-deleted");
    return c.body(null, 204);
  });

  app.openapi(routes.bundleUpdate, async (c) => {
    const { bundle } = c.req.valid("param");
    const body = c.req.valid("json");
    const b = await bundles.update(bundle, body);
    log.info({ slug: bundle }, "Bundle updated");
    return c.json(
      {
        slug: b.slug,
        title: b.title,
        description: b.description,
        okfVersion: b.okfVersion,
        createdAt: b.createdAt.toISOString(),
        updatedAt: b.updatedAt.toISOString(),
      },
      200,
    );
  });

  app.openapi(routes.bundleIndex, async (c) => {
    const { bundle } = c.req.valid("param");
    return c.text(await indexer.indexMarkdown([bundle]), 200, {
      "Content-Type": "text/markdown; charset=utf-8",
    });
  });

  app.openapi(routes.search, async (c) => {
    const q = c.req.valid("query");
    const results = await search.search({
      ...(q.bundle !== undefined ? { bundlePath: q.bundle } : {}),
      ...(q.text !== undefined ? { text: q.text } : {}),
      ...(q.type !== undefined ? { type: q.type } : {}),
      ...(q.tags !== undefined ? { tags: q.tags.split(",").map((t) => t.trim()) } : {}),
      ...(q.scopes !== undefined ? { scopes: q.scopes.split(",").map((s) => s.trim()) } : {}),
      ...(q.project !== undefined ? { project: q.project } : {}),
      ...(q.include_global !== undefined ? { includeGlobal: q.include_global } : {}),
      ...(q.limit !== undefined ? { limit: q.limit } : {}),
      ...(q.offset !== undefined ? { offset: q.offset } : {}),
    });
    return c.json(results, 200);
  });

  app.openapi(routes.batch, async (c) => {
    const { operations } = c.req.valid("json");
    const results: { status: number; path: string; error?: string }[] = [];
    for (const op of operations) {
      try {
        switch (op.method) {
          case "POST":
            if (!op.title) throw new OkfValidationError("title is required");
            if (!op.description) throw new OkfValidationError("description is required");
            await concepts.create(op.bundle, op.path, {
              type: op.type ?? "Note",
              title: op.title,
              description: op.description,
              resource: op.resource,
              tags: op.tags,
              body: op.body,
            });
            results.push({ status: 201, path: `${op.bundle}/${op.path}` });
            break;
          case "PUT": {
            const current = await concepts.read(op.bundle, op.path);
            await concepts.update(
              op.bundle,
              op.path,
              {
                ...current.frontmatter,
                ...(op.type !== undefined ? { type: op.type } : {}),
                ...(op.title !== undefined ? { title: op.title } : {}),
                ...(op.description !== undefined ? { description: op.description } : {}),
                ...(op.resource !== undefined ? { resource: op.resource } : {}),
                ...(op.tags !== undefined ? { tags: op.tags } : {}),
              },
              op.body ?? current.body,
            );
            results.push({ status: 200, path: `${op.bundle}/${op.path}` });
            break;
          }
          case "DELETE":
            await concepts.delete(op.bundle, op.path);
            results.push({ status: 204, path: `${op.bundle}/${op.path}` });
            break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ status: 422, path: `${op.bundle}/${op.path}`, error: message });
      }
    }
    return c.json(results, 200);
  });

  // ── Bundle export / import ─────────────────────────────────────────────

  app.get("/okf/bundles/:bundle/export", async (c) => {
    const bundle = c.req.param("bundle");
    const stream = await exportService.exportStream(bundle);
    return new Response(Readable.toWeb(stream), {
      headers: {
        "Content-Type": "application/gzip",
        "Content-Disposition": `attachment; filename="${bundle}.tar.gz"`,
      },
    });
  });

  app.post("/okf/bundles/:bundle/import", async (c) => {
    const bundle = c.req.param("bundle");
    const buffer = await c.req.arrayBuffer();
    const result = await importService.importTarGz(bundle, Buffer.from(buffer));
    log.info(
      { bundle, created: result.created, updated: result.updated, errors: result.errors.length },
      "Bundle import",
    );
    return c.json(result, 200);
  });

  // ── Graph traversal helpers ────────────────────────────────────────────

  const extractLinks = (body: string): string[] => {
    const links: string[] = [];
    const okfRe = /\[([^\]]*)\]\(okf:\/\/([^)]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = okfRe.exec(body)) !== null) {
      if (m[2]) links.push(m[2]);
    }
    const relRe = /\[([^\]]*)\]\(\.\/([^)]+)\)/g;
    while ((m = relRe.exec(body)) !== null) {
      if (m[2]) links.push(m[2].replace(/\.md$/, ""));
    }
    return [...new Set(links)];
  };

  const findBacklinks = async (
    bundleSlug: string,
    targetPath: string,
  ): Promise<{ id: string; type: string; title?: string }[]> => {
    const segments = bundleSlug.split("/").filter(Boolean);
    const { bundle } = await bundles.resolve(segments);
    const rows = await svc.conceptRepo.listByBundle(bundle.id);
    const results: { id: string; type: string; title?: string }[] = [];
    for (const row of rows) {
      if (row.body.includes(targetPath) || row.body.includes(`okf://${bundleSlug}/${targetPath}`)) {
        results.push({
          id: row.slug,
          type: row.type,
          ...(row.title ? { title: row.title } : {}),
        });
      }
    }
    return results;
  };

  // ── Concept + directory routes ─────────────────────────────────────────
  // Uses a wildcard so paths may contain slashes. The reserved `index.md` /
  // `log.md` files are synthesized live; graph traversal uses `.links` /
  // `.backlinks` extensions.
  const markdown = { "Content-Type": "text/markdown; charset=utf-8" } as const;

  const segmentsFor = (bundle: string, dir: string): string[] =>
    [bundle, ...dir.split("/")].filter(Boolean);

  app.get("/okf/bundles/:bundle/*", async (c) => {
    const bundle = c.req.param("bundle");
    const rest = conceptRest(c.req.path, bundle);

    if (rest === "index.md" || rest.endsWith("/index.md") || rest === "" || rest.endsWith("/")) {
      const dir = rest.replace(/\/?index\.md$/, "").replace(/\/+$/, "");
      return c.text(await indexer.indexMarkdown(segmentsFor(bundle, dir)), 200, markdown);
    }
    if (rest === "log.md" || rest.endsWith("/log.md")) {
      const dir = rest.replace(/\/?log\.md$/, "").replace(/\/+$/, "");
      return c.text(await indexer.logMarkdown(segmentsFor(bundle, dir)), 200, markdown);
    }

    if (rest.endsWith(".links")) {
      const conceptPath = rest.replace(/\.links$/, "");
      const concept = await concepts.read(bundle, conceptPath);
      const links = extractLinks(concept.body);
      return c.json(links, 200);
    }
    if (rest.endsWith(".backlinks")) {
      const conceptPath = rest.replace(/\.backlinks$/, "");
      const backlinks = await findBacklinks(bundle, conceptPath);
      return c.json(backlinks, 200);
    }

    if (rest.endsWith(".history")) {
      const conceptPath = rest.replace(/\.history$/, "");
      const versions = await concepts.listVersions(bundle, conceptPath);
      return c.json(
        versions.map((v) => ({
          version: v.version,
          type: v.type,
          title: v.title,
          description: v.description,
          tags: v.tags,
          resource: v.resource,
          createdAt: v.createdAt.toISOString(),
        })),
        200,
      );
    }

    if (!rest.endsWith(".md") && !rest.endsWith(".json")) {
      const dir = rest.replace(/\/+$/, "");
      return c.text(await indexer.indexMarkdown(segmentsFor(bundle, dir)), 200, markdown);
    }

    const versionParam = c.req.query("version");
    if (versionParam !== undefined) {
      const version = Number(versionParam);
      if (!Number.isInteger(version) || version < 1) {
        return c.json({ error: "Invalid version" }, 422);
      }
      const concept = await concepts.readVersion(bundle, rest, version);
      return c.text(serializeConcept(concept.frontmatter, concept.body), 200, markdown);
    }

    const concept = await concepts.read(bundle, rest, { trackRead: true });
    return c.text(serializeConcept(concept.frontmatter, concept.body), 200, markdown);
  });

  app.post("/okf/bundles/:bundle/*", async (c) => {
    const bundle = c.req.param("bundle");
    const rest = conceptRest(c.req.path, bundle);
    const concept = await readConceptBody(c, bundle, rest, concepts, "create");
    log.info({ bundle, path: concept.id }, "Concept created");
    return c.text(serializeConcept(concept.frontmatter, concept.body), 201, markdown);
  });

  app.put("/okf/bundles/:bundle/*", async (c) => {
    const bundle = c.req.param("bundle");
    const rest = conceptRest(c.req.path, bundle);
    const concept = await readConceptBody(c, bundle, rest, concepts, "update");
    log.info({ bundle, path: concept.id }, "Concept updated");
    return c.text(serializeConcept(concept.frontmatter, concept.body), 200, markdown);
  });

  app.delete("/okf/bundles/:bundle/*", async (c) => {
    const bundle = c.req.param("bundle");
    const rest = conceptRest(c.req.path, bundle);
    await concepts.delete(bundle, rest);
    log.info({ bundle, path: rest }, "Concept soft-deleted");
    return c.body(null, 204);
  });

  app.get("/openapi.json", (c) =>
    c.json(
      app.getOpenAPIDocument({
        openapi: "3.1.0",
        info: {
          title: "OKF Vault API",
          version: "0.1.0",
          description: "REST API for the Open Knowledge Format vault (Postgres-backed).",
        },
        ...(config.API_KEY
          ? {
              security: [{ bearerAuth: [] }],
              components: {
                securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
              },
            }
          : {}),
      }),
    ),
  );

  app.get("/docs", swaggerUI({ url: "/openapi.json" }));

  return app;
}

/** Extracts the concept path (after `/okf/bundles/:bundle/`) from the URL. */
function conceptRest(path: string, bundle: string): string {
  const prefix = `/okf/bundles/${bundle}/`;
  const idx = path.indexOf(prefix);
  return decodeURIComponent(idx === -1 ? path : path.slice(idx + prefix.length));
}

/**
 * Reads a create/update body that may be either structured JSON or a raw OKF
 * markdown document (Content-Type: text/markdown), and dispatches to the
 * matching service method.
 */
async function readConceptBody(
  c: {
    req: {
      header: (n: string) => string | undefined;
      text: () => Promise<string>;
      json: () => Promise<unknown>;
    };
  },
  bundle: string,
  path: string,
  concepts: ConceptService,
  mode: "create" | "update",
) {
  const contentType = c.req.header("content-type") ?? "";
  if (contentType.includes("markdown") || contentType.includes("text/plain")) {
    const md = await c.req.text();
    return mode === "create"
      ? concepts.createFromMarkdown(bundle, path, md)
      : concepts.updateFromMarkdown(bundle, path, md);
  }
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new SyntaxError("Invalid JSON body");
  }
  const parsed = CreateConceptBodySchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new OkfValidationError(
      first ? `${first.path.join(".")}: ${first.message}` : "Invalid request body",
    );
  }
  const body = parsed.data;
  if (mode === "create") {
    return concepts.create(bundle, path, body);
  }
  const current = await concepts.read(bundle, path);
  return concepts.update(
    bundle,
    path,
    {
      ...current.frontmatter,
      type: body.type,
      ...(body.title !== undefined ? { title: body.title } : {}),
      ...(body.description !== undefined ? { description: body.description } : {}),
      ...(body.resource !== undefined ? { resource: body.resource } : {}),
      ...(body.tags !== undefined ? { tags: body.tags } : {}),
    },
    body.body ?? current.body,
  );
}
