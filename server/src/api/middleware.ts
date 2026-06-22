import { randomUUID } from "node:crypto";
import type { Context, Next } from "hono";
import { HTTPException } from "hono/http-exception";

/** Sliding-window rate limiter keyed by client IP. */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly windowMs = 1000;
  private readonly maxRequests: number;

  constructor(rps: number) {
    this.maxRequests = rps;
  }

  check(key: string): void {
    const now = Date.now();
    let entries = this.hits.get(key);
    if (!entries) {
      entries = [];
      this.hits.set(key, entries);
    }
    const cutoff = now - this.windowMs;
    while (entries.length > 0 && entries[0]! < cutoff) entries.shift();
    if (entries.length >= this.maxRequests) {
      throw new HTTPException(429, { message: "Too many requests" });
    }
    entries.push(now);
  }

  sweep(): void {
    const cutoff = Date.now() - this.windowMs * 2;
    for (const [key, entries] of this.hits) {
      while (entries.length > 0 && entries[0]! < cutoff) entries.shift();
      if (entries.length === 0) this.hits.delete(key);
    }
  }
}

/** Sets or propagates `x-request-id` for request tracing. */
export async function correlationId(c: Context, next: Next): Promise<void> {
  const existing = c.req.header("x-request-id");
  const id = existing ?? randomUUID();
  c.set("requestId", id);
  c.res.headers.set("x-request-id", id);
  await next();
}

/** Rejects requests whose Content-Length exceeds `maxBytes`. */
export async function bodySizeLimit(c: Context, next: Next, maxBytes: number): Promise<void> {
  const cl = c.req.header("content-length");
  if (cl !== undefined && Number.parseInt(cl, 10) > maxBytes) {
    throw new HTTPException(413, { message: `Request body exceeds ${maxBytes} byte limit` });
  }
  await next();
}
