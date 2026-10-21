import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { User } from "../shared/types";

/**
 * The engine connection (API keys, the Higgsfield key and model) is shared by everyone, so only an
 * admin may change it. Members keep every read: catalog, models, verify, probe.
 */
async function app(role: User["role"]) {
  const { StudioError } = await import("../server/errors");
  const { studioRoutes } = await import("../server/studio");
  const a = new Hono<{ Bindings: Record<string, unknown>; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", { id: "u1", email: "x@y", name: "X", role } as User);
    await next();
  });
  a.route("/api/studio", studioRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

// Secrets set as Worker secrets make the key routes answer 409 before touching the database, so
// an admin's request proves the guard let it through without needing D1.
const env = { OPENAI_API_KEY: "secret", GEMINI_API_KEY: "secret", FAL_KEY: "secret" };

describe("engine connection permissions", () => {
  const writes: [string, string][] = [
    ["POST", "/api/studio/engine/openai-key"],
    ["DELETE", "/api/studio/engine/openai-key"],
    ["POST", "/api/studio/engine/google-key"],
    ["DELETE", "/api/studio/engine/google-key"],
    ["POST", "/api/studio/engine/vertex"],
    ["DELETE", "/api/studio/engine/vertex"],
    ["POST", "/api/studio/engine/fal-key"],
    ["DELETE", "/api/studio/engine/fal-key"],
    ["POST", "/api/studio/engine/key"],
    ["DELETE", "/api/studio/engine/key"],
    ["POST", "/api/studio/engine/model"],
  ];

  it("refuses every engine write to a member", async () => {
    const a = await app("member");
    for (const [method, path] of writes) {
      const r = await a.request(path, { method, headers: { "Content-Type": "application/json" }, body: method === "POST" ? JSON.stringify({ key: "k".repeat(30) }) : undefined }, env);
      expect(`${method} ${path} -> ${r.status}`).toBe(`${method} ${path} -> 403`);
    }
  });

  it("lets an admin through the guard (the key routes then stop on the Worker secret)", async () => {
    const a = await app("admin");
    for (const path of ["/api/studio/engine/openai-key", "/api/studio/engine/google-key", "/api/studio/engine/fal-key"]) {
      const r = await a.request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: "k".repeat(30) }) }, env);
      expect(`${path} -> ${r.status}`).toBe(`${path} -> 409`);
    }
  });

  it("keeps the read routes open to members (no 403)", async () => {
    const a = await app("member");
    for (const path of ["/api/studio/engine/catalog", "/api/studio/engine/models", "/api/studio/engine/verify", "/api/studio/engine/probe"]) {
      const r = await a.request(path, { method: "GET" }, env);
      expect(`${path} -> ${r.status}`).not.toBe(`${path} -> 403`);
    }
  });
});
