/**
 * The approval page keeps one answer per reviewer: a reviewer sees only their own answer, a second
 * reviewer never sees the first one's note, and the studio's effective status is "changes" as soon
 * as anyone asks for a change, with every answer listed.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch } from "./support/paid-guard";
import { effectiveApproval, postConfig, type Config } from "../shared/config";
import type { User } from "../shared/types";

type FakeEnv = ReturnType<typeof fakeEnv>;
const TOKEN = "a".repeat(32);

async function app() {
  const { StudioError } = await import("../server/errors");
  const { shareRoutes } = await import("../server/share");
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.route("/api/share", shareRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

async function seed() {
  const env = fakeEnv();
  const t = Date.now();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Sample', 'sample', 'active', ?, ?)").bind(t, t).run();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, disabled, created) VALUES ('u1', 'admin@test', 'Firas', 'x', 'admin', 0, ?)").bind(t).run();
  const config = postConfig("c1", "2026-10", { shareToken: TOKEN, plan: [{ index: 1, type: "product", title: "Cup", brief: "", caption: "", hashtags: "" } as never] });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'October', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  return env;
}

type App = Awaited<ReturnType<typeof app>>;
const read = async (a: App, env: FakeEnv, rid: string) => (await (await a.request(`/api/share/${TOKEN}?rid=${rid}`, {}, env)).json()) as { posts: { index: number; approval: { status: string; note?: string; by?: string; rid: string } | null }[] };
const answer = (a: App, env: FakeEnv, body: object) => a.request(`/api/share/${TOKEN}/review`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }, env);

beforeEach(() => {
  guardFetch();
});

describe("answers per reviewer", () => {
  it("shows each reviewer only their own answer, and keeps both for the studio", async () => {
    const env = await seed();
    const a = await app();
    const r1 = await answer(a, env, { index: 1, status: "changes", note: "Bigger cup", by: "Nada", rid: "rid-nada-01" });
    expect(r1.status).toBe(200);
    expect(((await r1.json()) as { approval: unknown }).approval).toMatchObject({ rid: "rid-nada-01", status: "changes", note: "Bigger cup" });
    // Ahmad opens the same link: nothing of Nada's shows.
    const ahmad = await read(a, env, "rid-ahmad-01");
    expect(ahmad.posts[0].approval).toBeNull();
    await answer(a, env, { index: 1, status: "approved", by: "Ahmad", rid: "rid-ahmad-01" });
    expect((await read(a, env, "rid-ahmad-01")).posts[0].approval).toMatchObject({ status: "approved", by: "Ahmad" });
    // Nada still sees her own change request, not Ahmad's approval.
    expect((await read(a, env, "rid-nada-01")).posts[0].approval).toMatchObject({ status: "changes", note: "Bigger cup" });
    // Someone without an id sees nothing.
    expect((await read(a, env, "")).posts[0].approval).toBeNull();
    // The studio: a change asked wins, both answers kept, names joined.
    const cfg = JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as Config;
    const eff = cfg.approvals!["1"];
    expect(eff.status).toBe("changes");
    expect(eff.note).toBe("Bigger cup");
    expect(eff.by).toBe("Nada");
    expect(eff.answers?.map((x) => x.by)).toEqual(["Nada", "Ahmad"]);
  });

  it("replaces only the same reviewer's earlier answer", async () => {
    const env = await seed();
    const a = await app();
    await answer(a, env, { index: 1, status: "changes", note: "Bigger cup", by: "Nada", rid: "rid-nada-01" });
    await answer(a, env, { index: 1, status: "approved", by: "Nada", rid: "rid-nada-01" });
    const cfg = JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as Config;
    expect(cfg.approvals!["1"].answers).toHaveLength(1);
    expect(cfg.approvals!["1"].status).toBe("approved");
  });
});

describe("effectiveApproval", () => {
  it("joins the notes of everyone who asked for a change, names first when there are several", () => {
    const eff = effectiveApproval([
      { rid: "a", status: "changes", note: "Bigger cup", by: "Nada", at: 1 },
      { rid: "b", status: "changes", note: "Darker blue", by: "Ahmad", at: 2 },
      { rid: "c", status: "approved", by: "Lina", at: 3 },
    ])!;
    expect(eff.status).toBe("changes");
    expect(eff.note).toBe("Nada: Bigger cup · Ahmad: Darker blue");
    expect(eff.by).toBe("Nada, Ahmad");
    expect(eff.at).toBe(2);
    expect(effectiveApproval([])).toBeNull();
  });
});
