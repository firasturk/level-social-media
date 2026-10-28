/**
 * Designed styles, the reading side (28 Oct): a pin with typography along the product or an
 * Instagram post mockup is read into `design` (shared/style-design.ts) next to a photo prompt that
 * describes the photograph alone; the design is stored in the styles table as JSON, listed with
 * the gallery, and an admin reads one style again to get it. The engine never draws letters.
 */
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch } from "./support/paid-guard";
import { StudioError } from "../server/errors";
import { geminiSchema } from "../server/vertex";
import { designLabel, STYLE_DESIGN_SCHEMA } from "../shared/style-design";
import { describeStyleInstruction, designFromJson, designJson, MIN_SCORE, parseStyle, PHOTOGRAPH_ALONE, STYLE_SCHEMA } from "../shared/styles";
import type { User } from "../shared/types";

type FakeEnv = ReturnType<typeof fakeEnv>;

/** What the reader answers for a pin: swapped per test. */
const reader = vi.hoisted(() => ({ answer: "" as string, calls: 0 }));

vi.mock("../server/posts", async (orig) => {
  const real = await orig<typeof import("../server/posts")>();
  return {
    ...real,
    askText: async () => {
      reader.calls++;
      return reader.answer;
    },
  };
});

const BRIGADEIRO = {
  kind: ["typography"],
  texts: [
    { role: "big", x: 0.55, y: 0.05, w: 0.4, h: 0.9, rotate: -90, weight: "heavy", case: "upper", tone: "light", align: "center", decoration: "none", behind: true, sample: "BRIGADEIRO" },
    { role: "line", x: 0.03, y: 0.3, w: 0.06, h: 0.5, rotate: -90, weight: "regular", case: "none", tone: "light", align: "left", decoration: "none", behind: false, sample: "brigadeiro delicioso e irresistível" },
    { role: "label", x: 0.3, y: 0.62, w: 0.25, h: 0.08, rotate: -20, weight: "light", case: "none", tone: "light", align: "center", decoration: "oval", behind: false, sample: "calda extra de" },
  ],
  mockup: null,
  space: "the right third stays an even dark backdrop",
  accent: "light",
};

const INSTAGRAM = {
  kind: ["mockup"],
  texts: [{ role: "handle", x: 0.06, y: 0.5, w: 0.4, h: 0.04, rotate: 0, weight: "heavy", case: "none", tone: "dark", align: "left", decoration: "none", behind: false, sample: "@brand" }],
  mockup: {
    ui: "instagram-post",
    panel: { x: 0, y: 0.38, w: 1, h: 0.3, radius: 0, tone: "light" },
    parts: { actions: true, likes: true, caption: true, hashtags: true, account: true, comments: true, logo: true },
    logo: { x: 0.8, y: 0.9, w: 0.15 },
  },
  space: "the middle band behind the panel stays calm",
  accent: "brand",
};

const PHOTO = "A low three-quarter view of the product on a dark glossy surface, a thick glossy pour running down one side, hard warm key light from the left, the right third an even dark backdrop that stays clean for typography.";

function reading(design: unknown, extra: Record<string, unknown> = {}) {
  return { keep: true, score: 6, kind: "product", category: "sweets", title: "Brigadeiro Pour", tags: "pour, dark, gloss", prompt: PHOTO, design, ...extra };
}

function app(role: User["role"] = "admin") {
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", { id: "u1", email: "u@test", name: "U", role } as User);
    await next();
  });
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message, ...(e.data ?? {}) }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

async function seed(env: FakeEnv, design: string | null) {
  const t = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, created) VALUES ('u1', 'u@test', 'U', 'x', ?)").bind(t).run();
  await env.DB.prepare(
    "INSERT INTO styles (id, kind, status, category, score, tiles, w, h, title, tags, prompt, design, source, note, image_key, thumb_key, position, created, updated) VALUES ('s1', 'product', 'active', 'sweets', 9, 0, 800, 1000, 'Brigadeiro Pour', 'pour', ?, ?, 'upload', 'brigadeiro pin', 'styles/s1.jpg', 'styles/s1-thumb.jpg', 0, ?, ?)",
  )
    .bind(PHOTO, design, t, t)
    .run();
  await env.BUCKET.put("styles/s1.jpg", new Uint8Array([255, 216, 255, 1, 2, 3]), { httpMetadata: { contentType: "image/jpeg" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  reader.answer = "";
  reader.calls = 0;
});

describe("reading a designed pin", () => {
  it("tells the reader to return the design apart from a photo prompt of the photograph alone", () => {
    const ins = describeStyleInstruction("Brigadeiro pour with big type");
    expect(ins).toContain("DESIGN:");
    expect(ins).toContain(PHOTOGRAPH_ALONE);
    expect(ins).toContain("no letters, no words, no typography, no UI, no panel, no icons");
    expect(ins).toContain("leaves that clean space for the design");
    // A designed post with a product photo at its heart is kept; a text-only card or a plain screenshot is not.
    expect(ins).toContain("keep is ALSO true for a designed post whose heart is a photograph of a product");
    expect(ins).toContain("Instagram post mockup framing a product photo");
    expect(ins).toContain("text-only cards (words with no product photo), plain screenshots with no product photo");
    // The shape the reader returns is the contract's.
    for (const word of ["rotate", "weight", "case", "tone", "align", "decoration", "behind", "sample", "panel", "parts", "logo", "space", "accent"]) expect(ins).toContain(`\`${word}\``);
    expect(ins).toContain('"design": null');
    // The rest of the instruction is as it was.
    expect(ins).toContain("THE BAR");
    expect(ins).toContain("score: 1-10");
    expect(ins).toContain("the product's own key ingredients");
  });

  it("parses a design block and lets a designed pin pass the bar", () => {
    const s = parseStyle(reading(BRIGADEIRO));
    expect(s.design).not.toBeNull();
    expect(s.design?.kind).toEqual(["typography"]);
    expect(s.design?.texts).toHaveLength(3);
    expect(s.design?.texts[0]).toMatchObject({ role: "big", rotate: -90, weight: "heavy", case: "upper", behind: true, sample: "BRIGADEIRO" });
    expect(s.design?.texts[2]).toMatchObject({ role: "label", decoration: "oval" });
    expect(s.design?.mockup).toBeNull();
    expect(s.design?.space).toBe("the right third stays an even dark backdrop");
    // A designed post is a concept by itself: a 6 read with a design enters as MIN_SCORE.
    expect(s.score).toBe(MIN_SCORE);
    expect(s.keep).toBe(true);
    expect(s.prompt).toBe(PHOTO);
    // A high read keeps its own score.
    expect(parseStyle(reading(INSTAGRAM, { score: 9 })).score).toBe(9);
    const m = parseStyle(reading(INSTAGRAM, { score: 9 }));
    expect(m.design?.kind).toEqual(["mockup"]);
    expect(m.design?.mockup?.panel).toMatchObject({ y: 0.38, h: 0.3, tone: "light" });
    expect(m.design?.mockup?.parts.hashtags).toBe(true);
    expect(m.design?.mockup?.logo).toMatchObject({ x: 0.8 });
    expect(designLabel(m.design)).toBe("Instagram mockup");
    expect(designLabel(s.design)).toBe("Typography");
  });

  it("reads a plain photograph as before, with no design", () => {
    const s = parseStyle(reading(null));
    expect(s.design).toBeNull();
    // Below the bar without a design: the old rule stands.
    expect(s.score).toBe(6);
    expect(s.keep).toBe(false);
    expect(parseStyle(reading(undefined, { score: 9 }))).toMatchObject({ keep: true, design: null });
    // A pin the reader drops keeps its own score, design or not.
    expect(parseStyle(reading(BRIGADEIRO, { keep: false }))).toMatchObject({ keep: false, score: 6 });
    // A design with nothing in it is no design.
    expect(parseStyle(reading({ kind: ["typography"], texts: [], mockup: null, space: "", accent: "light" }, { score: 9 })).design).toBeNull();
  });

  it("stores a design as JSON and reads it back safely", () => {
    const s = parseStyle(reading(BRIGADEIRO));
    const text = designJson(s.design);
    expect(text).toContain('"BRIGADEIRO"');
    expect(designFromJson(text)).toEqual(s.design);
    expect(designJson(null)).toBeNull();
    expect(designFromJson(null)).toBeNull();
    expect(designFromJson("")).toBeNull();
    expect(designFromJson("not json")).toBeNull();
    expect(designFromJson('{"kind":[]}')).toBeNull();
  });

  it("asks for a nullable design in the schema and writes it the way Gemini takes it", () => {
    const design = STYLE_SCHEMA.properties.design as { type: unknown; properties: Record<string, unknown>; required: string[] };
    expect(design.type).toEqual(["object", "null"]);
    expect(design.properties).toBe(STYLE_DESIGN_SCHEMA.properties);
    expect(design.required).toEqual(STYLE_DESIGN_SCHEMA.required);
    expect(STYLE_SCHEMA.required).toContain("design");
    // Gemini knows no type arrays: a nullable object becomes `type: object, nullable: true`, down the tree.
    const g = geminiSchema(STYLE_SCHEMA) as { properties: Record<string, { type: unknown; nullable?: boolean; properties?: Record<string, { type: unknown; nullable?: boolean }> }> };
    expect(g.properties.design).toMatchObject({ type: "object", nullable: true });
    expect(g.properties.design.properties?.mockup).toMatchObject({ type: "object", nullable: true });
    expect((g.properties.design.properties?.mockup as unknown as { properties: Record<string, unknown> }).properties.panel).toMatchObject({ type: "object", nullable: true });
    expect(g.properties.keep).toEqual({ type: "boolean" });
    expect(JSON.stringify(g)).not.toMatch(/"type":\s*\[/);
    expect(JSON.stringify(g)).not.toContain("anyOf");
    // The anyOf form is read the same way; the schema given is not changed.
    expect(geminiSchema({ anyOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "null" }] })).toEqual({ type: "object", properties: { a: { type: "string" } }, nullable: true });
    expect(STYLE_SCHEMA.properties.design.type).toEqual(["object", "null"]);
  });
});

describe("designed styles in the gallery", () => {
  it("lists a style's design with it, null for a plain photo", async () => {
    guardFetch();
    const env = fakeEnv();
    await seed(env, JSON.stringify(parseStyle(reading(BRIGADEIRO)).design));
    const t = Date.now();
    await env.DB.prepare("INSERT INTO styles (id, kind, status, category, score, title, tags, prompt, design, created, updated) VALUES ('s2', 'product', 'active', 'drinks', 9, 'Plain Splash', 'splash', ?, NULL, ?, ?)").bind("y".repeat(80), t, t).run();
    await env.DB.prepare("INSERT INTO styles (id, kind, status, category, score, title, tags, prompt, design, created, updated) VALUES ('s3', 'product', 'active', 'drinks', 9, 'Broken', 'x', ?, 'not json', ?, ?)").bind("y".repeat(80), t, t).run();
    const { styleRoutes } = await import("../server/styles");
    const a = app("member");
    a.route("/styles", styleRoutes);
    const r = await a.request("/styles?tab=all", {}, env);
    expect(r.status).toBe(200);
    const d = (await r.json()) as { styles: { id: string; design: unknown; prompt?: string }[] };
    const byId = Object.fromEntries(d.styles.map((s) => [s.id, s]));
    expect(byId.s1.design).toMatchObject({ kind: ["typography"], space: "the right third stays an even dark backdrop" });
    expect((byId.s1.design as { texts: unknown[] }).texts).toHaveLength(3);
    expect(byId.s2.design).toBeNull();
    expect(byId.s3.design).toBeNull();
    // The design reaches the team (the badge), the prompt stays the admin's.
    expect(byId.s1.prompt).toBeUndefined();
    expect(reader.calls).toBe(0);
  });

  it("lets the admin read one style again and stores the design it finds", async () => {
    guardFetch();
    const env = fakeEnv();
    await seed(env, null);
    reader.answer = JSON.stringify(reading(INSTAGRAM, { score: 9, title: "Feed Frame", tags: "pink, mockup", kind: "people" }));
    const { styleRoutes } = await import("../server/styles");
    const a = app();
    a.route("/styles", styleRoutes);
    const r = await a.request("/styles/s1/read-again?tab=all", { method: "POST" }, env);
    expect(r.status).toBe(200);
    const d = (await r.json()) as { ok: boolean; design: string; style: { id: string; title: string; kind: string; design: { kind: string[]; mockup: { parts: { likes: boolean } } } }; styles: { id: string }[] };
    expect(reader.calls).toBe(1);
    expect(d.design).toBe("Instagram mockup");
    expect(d.style).toMatchObject({ id: "s1", title: "Feed Frame", kind: "people" });
    expect(d.style.design.kind).toEqual(["mockup"]);
    expect(d.style.design.mockup.parts.likes).toBe(true);
    expect(d.styles.some((s) => s.id === "s1")).toBe(true);
    const row = await env.DB.prepare("SELECT status, position, design, prompt, title FROM styles WHERE id = 's1'").first<{ status: string; position: number; design: string; prompt: string; title: string }>();
    // Status and position stay; the words, the prompt and the design are the new read's.
    expect(row).toMatchObject({ status: "active", position: 0, title: "Feed Frame", prompt: PHOTO });
    expect(JSON.parse(row!.design)).toMatchObject({ kind: ["mockup"], accent: "brand" });
  });

  it("keeps Read again to admins and to styles with a picture", async () => {
    guardFetch();
    const env = fakeEnv();
    await seed(env, null);
    const { styleRoutes } = await import("../server/styles");
    const member = app("member");
    member.route("/styles", styleRoutes);
    expect((await member.request("/styles/s1/read-again", { method: "POST" }, env)).status).toBe(403);
    const admin = app();
    admin.route("/styles", styleRoutes);
    expect((await admin.request("/styles/nope/read-again", { method: "POST" }, env)).status).toBe(404);
    await env.BUCKET.delete("styles/s1.jpg");
    expect((await admin.request("/styles/s1/read-again", { method: "POST" }, env)).status).toBe(404);
    expect(reader.calls).toBe(0);
  });
});
