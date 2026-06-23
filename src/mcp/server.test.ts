import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createLogger } from "../logger.js";
import { createDb, type DbHandle } from "../db/client.js";
import { runMigrations } from "../db/migrate.js";
import { createMcpServer } from "./server.js";

const url = process.env["DATABASE_URL"] ?? process.env["TEST_DATABASE_URL"];

async function reachable(u: string): Promise<boolean> {
  const probe = createDb(u, { max: 1 });
  try {
    await probe.sql`select 1`;
    return true;
  } catch {
    return false;
  } finally {
    await probe.close();
  }
}

const live = url !== undefined && (await reachable(url));
const suite = live ? describe : describe.skip;

interface ToolResult {
  content: { type: "text"; text: string }[];
}

async function callTool(client: Client, name: string, args: Record<string, unknown>) {
  const result = (await client.callTool({ name, arguments: args })) as ToolResult;
  return JSON.parse(result.content[0]!.text);
}

suite("MCP server", () => {
  let handle: DbHandle;
  let client: Client;
  const slug = `mcp-test-${Date.now().toString(36)}`;

  beforeAll(async () => {
    await runMigrations(url!);
    handle = createDb(url!);
    const log = createLogger({ LOG_LEVEL: "silent", LOG_PRETTY: false });
    const server = createMcpServer(handle.db, log);

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterAll(async () => {
    await client.close();
    if (handle) await handle.close();
  });

  it("okf_bundle_list returns an array of bundles", async () => {
    const data = await callTool(client, "okf_bundle_list", {});
    expect(Array.isArray(data)).toBe(true);
    for (const b of data) {
      expect(b).toMatchObject({ slug: expect.any(String) });
    }
  });

  it("okf_bundle_create creates a bundle", async () => {
    const data = await callTool(client, "okf_bundle_create", {
      slug,
      title: "MCP Test",
      description: "Created via MCP",
    });
    expect(data.slug).toBe(slug);
    expect(data.title).toBe("MCP Test");
  });

  it("okf_bundle_list now includes the created bundle", async () => {
    const data = await callTool(client, "okf_bundle_list", {});
    expect(data).toEqual(
      expect.arrayContaining([expect.objectContaining({ slug, title: "MCP Test" })]),
    );
  });

  it("okf_bundle_index returns tree for root bundle", async () => {
    const data = await callTool(client, "okf_bundle_index", { bundle: slug });
    expect(data.bundle).toBe(slug);
    expect(Array.isArray(data.tree)).toBe(true);
  });

  it("okf_concept_create creates a concept in a subdirectory", async () => {
    const data = await callTool(client, "okf_concept_create", {
      bundle: slug,
      path: "mcp/subdir/test-concept",
      type: "reference",
      title: "Test",
    });
    expect(data.id).toBe("mcp/subdir/test-concept");
    expect(data.frontmatter.title).toBe("Test");
  });

  it("okf_concept_create accepts optional resource field", async () => {
    const data = await callTool(client, "okf_concept_create", {
      bundle: slug,
      path: "mcp/subdir/resource-concept",
      type: "reference",
      title: "With Resource",
      resource: "https://example.com/doc",
    });
    expect(data.id).toBe("mcp/subdir/resource-concept");
    expect(data.frontmatter.resource).toBe("https://example.com/doc");
  });

  it("okf_concept_get reads the created concept", async () => {
    const data = await callTool(client, "okf_concept_get", {
      bundle: slug,
      path: "mcp/subdir/test-concept",
    });
    expect(data.id).toBe("mcp/subdir/test-concept");
    expect(data.frontmatter.title).toBe("Test");
  });

  it("okf_concept_get appends the upsert system note to markdown", async () => {
    const data = await callTool(client, "okf_concept_get", {
      bundle: slug,
      path: "mcp/subdir/test-concept",
    });
    expect(data.markdown).toContain("[System Note:");
    expect(data.markdown).toContain("okf_concept_upsert");
  });

  it("okf_concept_upsert creates when absent and updates when present", async () => {
    const created = await callTool(client, "okf_concept_upsert", {
      bundle: slug,
      path: "mcp/upsert-concept",
      type: "reference",
      title: "Upsert New",
    });
    expect(created.id).toBe("mcp/upsert-concept");
    expect(created.frontmatter.title).toBe("Upsert New");

    const updated = await callTool(client, "okf_concept_upsert", {
      bundle: slug,
      path: "mcp/upsert-concept",
      type: "reference",
      title: "Upsert Updated",
    });
    expect(updated.frontmatter.title).toBe("Upsert Updated");

    const history = await callTool(client, "okf_concept_history", {
      bundle: slug,
      path: "mcp/upsert-concept",
    });
    expect(history.length).toBeGreaterThanOrEqual(1);
  });

  it("okf_concept_update modifies the concept", async () => {
    const data = await callTool(client, "okf_concept_update", {
      bundle: slug,
      path: "mcp/subdir/test-concept",
      title: "Updated",
    });
    expect(data.frontmatter.title).toBe("Updated");
  });

  it("okf_concept_update can set resource field", async () => {
    const data = await callTool(client, "okf_concept_update", {
      bundle: slug,
      path: "mcp/subdir/test-concept",
      resource: "https://example.com/updated",
    });
    expect(data.frontmatter.resource).toBe("https://example.com/updated");
  });

  it("okf_concept_search finds the concept by text", async () => {
    const data = await callTool(client, "okf_concept_search", {
      bundle: slug,
      text: "Updated",
    });
    expect(data.status).toBe("success");
    expect(data.results.length).toBeGreaterThanOrEqual(1);
    expect(data.results[0]!.id).toBe(`${slug}/mcp/subdir/test-concept`);
    expect(data.results[0]!.bundle).toBe(slug);
  });

  it("okf_concept_search supports structured must_include/should_include", async () => {
    const data = await callTool(client, "okf_concept_search", {
      bundle: slug,
      must_include: ["Updated"],
      should_include: ["test", "concept"],
    });
    expect(data.status).toBe("success");
    expect(data.results.length).toBeGreaterThanOrEqual(1);
  });

  it("okf_concept_search returns a system_directive on zero results", async () => {
    const data = await callTool(client, "okf_concept_search", {
      bundle: slug,
      must_include: ["zzzznonexistentterm"],
    });
    expect(data.status).toBe("success");
    expect(data.results).toEqual([]);
    expect(data.system_directive).toContain("0 results found");
    expect(data.system_directive).toContain("okf_concept_upsert");
  });

  it("okf_concept_search returns snippet in results", async () => {
    // Create a concept with body content so snippet is populated
    await callTool(client, "okf_concept_create", {
      bundle: slug,
      path: "mcp/snippet-test",
      type: "reference",
      title: "Snippet Test",
      body: "This is the body content that should appear in the search snippet.",
    });
    const data = await callTool(client, "okf_concept_search", {
      bundle: slug,
      text: "snippet",
    });
    const match = data.results.find((r: { id: string }) => r.id.endsWith("snippet-test"));
    expect(match).toBeDefined();
    expect(match.snippet).toBeDefined();
    expect(match.snippet).toContain("body content");
  });

  // ── Optional-field branch coverage ──────────────────────────────────────

  it("okf_bundle_create works with only a slug (no title/description)", async () => {
    const bareSlug = `${slug}-bare`;
    const data = await callTool(client, "okf_bundle_create", { slug: bareSlug });
    expect(data.slug).toBe(bareSlug);
    expect(data.title).toBeNull();
  });

  it("okf_concept_create works with all optional fields", async () => {
    const data = await callTool(client, "okf_concept_create", {
      bundle: slug,
      path: "mcp/full-concept",
      type: "reference",
      title: "Full",
      description: "A full concept",
      resource: "https://example.com/full",
      tags: ["a", "b"],
      body: "# Full\n",
    });
    expect(data.frontmatter.description).toBe("A full concept");
    expect(data.frontmatter.tags).toEqual(["a", "b"]);
  });

  it("okf_concept_create works with type only (minimal)", async () => {
    const data = await callTool(client, "okf_concept_create", {
      bundle: slug,
      path: "mcp/minimal-concept",
      type: "reference",
    });
    expect(data.id).toBe("mcp/minimal-concept");
  });

  it("okf_concept_update can change type and tags", async () => {
    const data = await callTool(client, "okf_concept_update", {
      bundle: slug,
      path: "mcp/full-concept",
      type: "Playbook",
      tags: ["x", "y"],
      description: "Updated description",
    });
    expect(data.frontmatter.type).toBe("Playbook");
    expect(data.frontmatter.tags).toEqual(["x", "y"]);
  });

  it("okf_concept_search with type, tags, scopes, project, limit, offset", async () => {
    const data = await callTool(client, "okf_concept_search", {
      bundle: slug,
      text: "Full",
      type: "Playbook",
      tags: ["x"],
      scopes: ["mcp"],
      project: "proj",
      limit: 10,
      offset: 0,
    });
    expect(data.status).toBe("success");
    expect(Array.isArray(data.results)).toBe(true);
  });

  it("okf_concept_search with no bundle filter (global)", async () => {
    const data = await callTool(client, "okf_concept_search", { text: "Full" });
    expect(data.status).toBe("success");
    expect(Array.isArray(data.results)).toBe(true);
  });

  // ── Resource template ───────────────────────────────────────────────────

  it("listResources enumerates concepts as okf:// resources", async () => {
    const result = await client.listResources();
    expect(Array.isArray(result.resources)).toBe(true);
    // At least one concept resource should be listed
    expect(result.resources.some((r) => r.uri.startsWith("okf://"))).toBe(true);
    const withMime = result.resources.find((r) => r.mimeType === "text/markdown");
    expect(withMime).toBeDefined();
  }, 30000);

  it("readResource returns concept markdown via okf:// template", async () => {
    const result = await client.readResource({
      uri: `okf://${slug}/mcp/subdir/resource-concept`,
    });
    expect(result.contents).toHaveLength(1);
    const content = result.contents[0] as { mimeType?: string; text: string };
    expect(content.mimeType).toBe("text/markdown");
    expect(content.text).toContain("type: Reference");
    expect(content.text).toContain("https://example.com/doc");
  });

  it("okf_concept_links returns extracted links", async () => {
    await callTool(client, "okf_concept_create", {
      bundle: slug,
      path: "linking-concept",
      type: "reference",
      title: "Links Out",
      body: `Link to [target](okf://${slug}/linked-target) and [local](./local-link.md).`,
    });
    const links = await callTool(client, "okf_concept_links", {
      bundle: slug,
      path: "linking-concept",
    });
    expect(links).toContain(`${slug}/linked-target`);
    expect(links).toContain("local-link");
  });

  it("okf_concept_backlinks finds inbound references", async () => {
    await callTool(client, "okf_concept_create", {
      bundle: slug,
      path: "linked-target",
      type: "reference",
      title: "Linked Target",
    });
    const backlinks = await callTool(client, "okf_concept_backlinks", {
      bundle: slug,
      path: "linked-target",
    });
    expect(backlinks.some((b: { id: string }) => b.id === "linking-concept")).toBe(true);
  });

  it("okf_concept_history lists versions after update", async () => {
    await callTool(client, "okf_concept_update", {
      bundle: slug,
      path: "linking-concept",
      title: "Updated Links Out",
      body: "New body after update",
    });
    const history = await callTool(client, "okf_concept_history", {
      bundle: slug,
      path: "linking-concept",
    });
    expect(Array.isArray(history)).toBe(true);
    expect(history.length).toBeGreaterThanOrEqual(1);
  });

  it("okf_concept_read_version reads a specific previous version", async () => {
    const history = await callTool(client, "okf_concept_history", {
      bundle: slug,
      path: "linking-concept",
    });
    const firstVersion = history[history.length - 1] as { version: number };
    const versionData = await callTool(client, "okf_concept_read_version", {
      bundle: slug,
      path: "linking-concept",
      version: firstVersion.version,
    });
    expect(versionData).toHaveProperty("id");
    expect(versionData.body).toBeDefined();
  });

  it("readResource returns 404 for nonexistent concept", async () => {
    await expect(client.readResource({ uri: `okf://${slug}/nonexistent` })).rejects.toThrow();
  });

  it("okf_concept_delete soft-deletes the concept", async () => {
    const data = await callTool(client, "okf_concept_delete", {
      bundle: slug,
      path: "mcp/subdir/test-concept",
    });
    expect(data.deleted).toBe(`${slug}/mcp/subdir/test-concept`);
  });

  it("okf_bundle_delete soft-deletes the bundle", async () => {
    const data = await callTool(client, "okf_bundle_delete", { slug });
    expect(data.deleted).toBe(slug);
  });

  it("okf_concept_get returns a structured error envelope on deleted concept", async () => {
    const data = await callTool(client, "okf_concept_get", {
      bundle: slug,
      path: "mcp/subdir/test-concept",
    });
    expect(data.status).toBe("error");
    expect(data.error_code).toBe("NOT_FOUND");
    expect(data.system_directive).toBeDefined();
  });

  // ── serve() startup and shutdown ──────────────────────────────────────

  it("serve starts HTTP API and shuts down on SIGTERM", async () => {
    const exitMock = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    const { serve } = await import("./server.js");
    const log = createLogger({ LOG_LEVEL: "silent", LOG_PRETTY: false });

    const servePromise = serve({
      config: {
        DATABASE_URL: url!,
        HOST: "127.0.0.1",
        PORT: 0,
        LOG_LEVEL: "silent",
        LOG_PRETTY: false,
        CORS_ORIGINS: "",
        API_KEY: "",
        MAX_BODY_SIZE: 1048576,
        RATE_LIMIT_RPS: 1000,
        MCP_TRANSPORT: "stdio",
      },
      log,
      db: handle.db,
      onShutdown: vi.fn(),
    });

    // Wait for server to be ready
    await servePromise;

    // Simulate SIGTERM
    process.emit("SIGTERM" as NodeJS.Signals);
    // Give event loop time to process shutdown
    await new Promise((r) => setTimeout(r, 100));

    expect(exitMock).toHaveBeenCalled();

    exitMock.mockRestore();
  });

  it("serve SSE transport and double signal", async () => {
    // Clear any leftover signal listeners from the stdio test above
    for (const sig of ["SIGTERM", "SIGINT"] as const) {
      for (const h of process.listeners(sig)) process.removeListener(sig, h);
    }

    const exitMock = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    const { serve } = await import("./server.js");
    const log = createLogger({ LOG_LEVEL: "silent", LOG_PRETTY: false });

    const servePromise = serve({
      config: {
        DATABASE_URL: url!,
        HOST: "127.0.0.1",
        PORT: 0,
        LOG_LEVEL: "silent",
        LOG_PRETTY: false,
        CORS_ORIGINS: "",
        API_KEY: "",
        MAX_BODY_SIZE: 1048576,
        RATE_LIMIT_RPS: 1000,
        MCP_TRANSPORT: "sse",
      },
      log,
      db: handle.db,
      onShutdown: vi.fn(),
    });

    await servePromise;

    // SIGINT triggers shutdown (covers SIGINT path)
    process.emit("SIGINT" as NodeJS.Signals);
    await new Promise((r) => setTimeout(r, 50));

    // Second signal: shuttingDown flag prevents re-entry
    process.emit("SIGTERM" as NodeJS.Signals);
    await new Promise((r) => setTimeout(r, 50));

    expect(exitMock).toHaveBeenCalled();

    exitMock.mockRestore();
  });

  it("serve mounts the Streamable HTTP /mcp endpoint and handles requests", async () => {
    for (const sig of ["SIGTERM", "SIGINT"] as const) {
      for (const h of process.listeners(sig)) process.removeListener(sig, h);
    }
    const exitMock = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);

    // Reserve a free port, then release it for the server to bind.
    const net = await import("node:net");
    const port = await new Promise<number>((resolve) => {
      const srv = net.createServer();
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const p = typeof addr === "object" && addr ? addr.port : 0;
        srv.close(() => resolve(p));
      });
    });

    const { serve } = await import("./server.js");
    const log = createLogger({ LOG_LEVEL: "silent", LOG_PRETTY: false });

    await serve({
      config: {
        DATABASE_URL: url!,
        HOST: "127.0.0.1",
        PORT: port,
        LOG_LEVEL: "silent",
        LOG_PRETTY: false,
        CORS_ORIGINS: "",
        API_KEY: "",
        MAX_BODY_SIZE: 1048576,
        RATE_LIMIT_RPS: 1000,
        MCP_TRANSPORT: "http",
      },
      log,
      db: handle.db,
      onShutdown: vi.fn(),
    });

    const base = `http://127.0.0.1:${port}/mcp`;

    // GET without a session id → 400 (no valid session branch).
    const noSession = await fetch(base, { method: "GET" });
    expect(noSession.status).toBe(400);

    // POST initialize → creates a session and returns an mcp-session-id header.
    const init = await fetch(base, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "test", version: "1.0.0" },
        },
      }),
    });
    expect(init.status).toBeLessThan(500);
    expect(init.headers.get("mcp-session-id")).toBeTruthy();

    process.emit("SIGTERM" as NodeJS.Signals);
    await new Promise((r) => setTimeout(r, 100));
    expect(exitMock).toHaveBeenCalled();

    exitMock.mockRestore();
  });

  // ── Prompts ─────────────────────────────────────────────────────────────

  it("getPrompt returns the create_concept prompt", async () => {
    const result = await client.getPrompt({
      name: "create_concept",
      arguments: {
        bundle: slug,
        path: "guides/deploy",
        type: "Playbook",
      },
    });
    expect(result.messages).toHaveLength(1);
    const msg = result.messages[0]!;
    expect(msg.role).toBe("user");
    expect(msg.content.type).toBe("text");
    const text = msg.content.type === "text" ? msg.content.text : "";
    expect(text).toContain(slug);
    expect(text).toContain("guides/deploy");
    expect(text).toContain("Playbook");
  });
});
