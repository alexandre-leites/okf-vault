import { describe, it, expect, vi } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { RateLimiter, bodySizeLimit, correlationId } from "./middleware.js";

// ── RateLimiter unit tests ──────────────────────────────────────────────────

describe("RateLimiter", () => {
  it("allows requests within the limit", () => {
    const rl = new RateLimiter(5);
    for (let i = 0; i < 5; i++) {
      expect(() => rl.check("alice")).not.toThrow();
    }
  });

  it("throws after exceeding the limit", () => {
    const rl = new RateLimiter(2);
    rl.check("bob");
    rl.check("bob");
    expect(() => rl.check("bob")).toThrow(HTTPException);
    expect(() => rl.check("bob")).toThrow("Too many requests");
  });

  it("different keys have independent counters", () => {
    const rl = new RateLimiter(1);
    rl.check("carol");
    expect(() => rl.check("carol")).toThrow();
    expect(() => rl.check("dave")).not.toThrow();
  });

  it("sweep clears expired entries", async () => {
    const rl = new RateLimiter(5);
    rl.check("eve");
    expect(rl["hits"].has("eve")).toBe(true);
    // Manually set timestamps to expired
    const entries = rl["hits"].get("eve")!;
    entries[0] = Date.now() - 3000; // 3s ago, beyond 1s window
    rl.sweep();
    expect(rl["hits"].has("eve")).toBe(false);
  });

  it("sweep preserves entries still within window", async () => {
    const rl = new RateLimiter(5);
    rl.check("faythe");
    // Sweep runs with cutoff = now - 2000ms; current entry is within that
    rl.sweep();
    expect(rl["hits"].has("faythe")).toBe(true);
  });

  it("sweep handles multiple entries: some expired, some fresh", () => {
    const rl = new RateLimiter(5);
    // Add one stale entry followed by a fresh one (same key simulates sequential calls)
    rl.check("grace");
    rl.check("grace");
    const entries = rl["hits"].get("grace")!;
    // Keep second entry fresh, push first far in the past
    const now = Date.now();
    entries[0] = now - 3000;
    rl.sweep();
    // After sweep: entries should still have the fresh entry
    expect(rl["hits"].has("grace")).toBe(true);
    expect(rl["hits"].get("grace")!.length).toBe(1);
    // The fresh entry should be at or near the current time
    expect(rl["hits"].get("grace")![0]!).toBeGreaterThan(now - 100);
  });

  it("window slides: old entries are ignored", () => {
    const rl = new RateLimiter(2);
    const entries: number[] = [];
    vi.spyOn(rl["hits"], "get").mockReturnValue(entries);
    vi.spyOn(rl["hits"], "set").mockImplementation(() => rl["hits"]);

    // Simulate entries outside the 1s window
    entries.push(Date.now() - 2000, Date.now() - 1500);
    expect(() => rl.check("frank")).not.toThrow();
  });
});

// ── bodySizeLimit ───────────────────────────────────────────────────────────

describe("bodySizeLimit", () => {
  it("allows requests under the limit", async () => {
    const app = new Hono();
    app.use("/test", async (c, next) => bodySizeLimit(c, next, 100));
    app.post("/test", (c) => c.text("ok"));

    const res = await app.request("/test", {
      method: "POST",
      headers: { "content-length": "50", "content-type": "text/plain" },
      body: "x".repeat(50),
    });
    expect(res.status).toBe(200);
  });

  it("rejects requests over the limit", async () => {
    const app = new Hono();
    app.use("/test", async (c, next) => bodySizeLimit(c, next, 100));
    app.post("/test", (c) => c.text("ok"));

    const res = await app.request("/test", {
      method: "POST",
      headers: { "content-length": "150", "content-type": "text/plain" },
      body: "x".repeat(150),
    });
    expect(res.status).toBe(413);
    const text = await res.text();
    expect(text).toContain("byte limit");
  });

  it("allows GET requests without content-length", async () => {
    const app = new Hono();
    app.use("/test", async (c, next) => bodySizeLimit(c, next, 100));
    app.get("/test", (c) => c.text("ok"));

    const res = await app.request("/test");
    expect(res.status).toBe(200);
  });
});

// ── correlationId ───────────────────────────────────────────────────────────

describe("correlationId", () => {
  it("sets x-request-id on the response", async () => {
    const app = new Hono();
    app.use("*", correlationId);
    app.get("/test", (c) => c.text("ok"));

    const res = await app.request("/test");
    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  it("propagates an existing x-request-id from the request", async () => {
    const app = new Hono();
    app.use("*", correlationId);
    app.get("/test", (c) => c.text("ok"));

    const res = await app.request("/test", {
      headers: { "x-request-id": "my-trace-id" },
    });
    expect(res.headers.get("x-request-id")).toBe("my-trace-id");
  });

  it("sets a different id per request", async () => {
    const app = new Hono();
    app.use("*", correlationId);
    app.get("/test", (c) => c.text("ok"));

    const [r1, r2] = await Promise.all([app.request("/test"), app.request("/test")]);
    const id1 = r1.headers.get("x-request-id");
    const id2 = r2.headers.get("x-request-id");
    expect(id1).toBeTruthy();
    expect(id2).toBeTruthy();
    expect(id1).not.toBe(id2);
  });
});
