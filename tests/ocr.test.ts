import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig } from "../shared/config";
import type { User } from "../shared/types";
import {
  checkRawImage,
  compareArtwork,
  isOcrFlag,
  normaliseText,
  ocrFlags,
  OCR_FLAG_PREFIX,
  OCR_LOW_PREFIX,
  similarity,
  type Finding,
  type OcrResult,
} from "../shared/ocr-check";
import { DEMO_OCR_FIXTURES, GoogleVisionOcr, imageSize, mapVisionResponse, MockOcr, NOT_CONNECTED, ocrReviewFlags, resolveOcr, shortHash, VISION_URL } from "../server/ocr";
import { selfFixable } from "../server/engine";
import { ocrRoutes } from "../server/ocr-routes";
import { StudioError } from "../server/errors";

/**
 * OCR: the normalisation of Arabic and numerals, the two checks (raw picture, final artwork), the
 * routes answered by the demo provider under a fetch guard (no network), the shape of the Google
 * Vision request against a stubbed fetch that only vision.googleapis.com may reach, and the
 * engine's rule that an OCR flag never queues a retake.
 */

const box = (x0: number, y0: number, x1: number, y1: number): [number, number, number, number] => [x0, y0, x1, y1];
const result = (blocks: OcrResult["blocks"], provider = "demo"): OcrResult => ({ blocks, provider });
const kinds = (f: Finding[]) => f.map((x) => `${x.field}:${x.kind}`);

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
  DEMO_OCR_FIXTURES.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalisation of Arabic and numerals", () => {
  it("writes Arabic-Indic and Eastern digits as ASCII", () => {
    expect(normaliseText("٢٠٢٦")).toBe("2026");
    expect(normaliseText("۱۲۳")).toBe("123");
    expect(normaliseText("خصم ٥٠٪")).toBe("خصم 50%");
    expect(normaliseText("١٥٫٥ دينار")).toBe("15.5 دينار");
  });

  it("drops diacritics and tatweel", () => {
    expect(normaliseText("مُحَمَّدٌ")).toBe("محمد");
    expect(normaliseText("كـــنافة")).toBe("كنافة");
  });

  it("unifies the alef variants, alef maqsura and (with the flag) ta marbuta", () => {
    expect(normaliseText("أحمد إبراهيم آمنة ٱلله")).toBe("احمد ابراهيم امنة الله");
    expect(normaliseText("مصطفى")).toBe("مصطفي");
    expect(normaliseText("حلوة")).toBe("حلوة");
    expect(normaliseText("حلوة", { taMarbuta: true })).toBe("حلوه");
  });

  it("collapses whitespace, folds Latin case and strips zero-width marks", () => {
    expect(normaliseText("  Only   15 JD\n today ")).toBe("only 15 jd today");
    expect(normaliseText("Sale​ 50%")).toBe("sale 50%");
    expect(similarity("abcd", "abcd")).toBe(1);
    expect(similarity("abcd", "abxd")).toBe(0.75);
  });
});

describe("the final artwork against the approved words", () => {
  const expected = { headline: "خصم ٥٠٪ على الكنافة", subline: "هذا الأسبوع فقط", price: "15 JD", allowed: ["Habibah"] };

  it("matches the approved words however the digits were read, and reads a wrapped headline", () => {
    const f = compareArtwork(
      expected,
      result([
        { text: "خصم 50%", confidence: 0.98, box: box(0.1, 0.6, 0.5, 0.68) },
        { text: "على الكنافة", confidence: 0.97, box: box(0.1, 0.69, 0.5, 0.77) },
        { text: "هذا الاسبوع فقط", confidence: 0.95, box: box(0.1, 0.78, 0.5, 0.83) },
        { text: "15 JD", confidence: 0.99, box: box(0.7, 0.85, 0.9, 0.9) },
        { text: "HABIBAH", confidence: 0.9, box: box(0.4, 0.05, 0.6, 0.1) },
      ]),
    );
    expect(kinds(f)).toEqual(["headline:match", "subline:match", "price:match"]);
    expect(f[0].box).toEqual(box(0.1, 0.6, 0.5, 0.77));
    expect(f.every((x) => x.severity === "ok")).toBe(true);
  });

  it("names a mismatch, a missing word and extra writing", () => {
    const f = compareArtwork(
      expected,
      result([
        { text: "خصم 50% على الكنافه", confidence: 0.98, box: box(0.1, 0.6, 0.5, 0.68) },
        { text: "هذا الشهر فقط", confidence: 0.95, box: box(0.1, 0.78, 0.5, 0.83) },
        { text: "Buy now", confidence: 0.93, box: box(0.7, 0.85, 0.9, 0.9) },
      ]),
    );
    expect(kinds(f)).toEqual(["headline:match", "subline:mismatch", "price:missing", "text:extra"]);
    const sub = f.find((x) => x.field === "subline")!;
    expect(sub.detected).toBe("هذا الشهر فقط");
    expect(sub.severity).toBe("warn");
    expect(f.find((x) => x.field === "price")!.severity).toBe("warn");
    expect(f.find((x) => x.kind === "extra")!.detected).toBe("Buy now");
  });

  it("hands a faint reading to a person instead of deciding", () => {
    const f = compareArtwork(
      { headline: "Fresh every morning", price: "٣ دنانير" },
      result([
        { text: "Fresh every mornlng", confidence: 0.41, box: box(0.1, 0.6, 0.5, 0.68) },
        { text: "3 دنانير", confidence: 0.99, box: box(0.7, 0.85, 0.9, 0.9) },
        { text: "~~~", confidence: 0.2, box: box(0, 0, 0.1, 0.1) },
        { text: "qz", confidence: 0.3, box: box(0.5, 0.5, 0.6, 0.6) },
      ]),
    );
    expect(kinds(f)).toEqual(["headline:low-confidence", "price:match", "text:low-confidence"]);
    expect(f[0].severity).toBe("review");
    expect(f[0].note).toMatch(/human look/i);
    expect(f[2].severity).toBe("review");
  });
});

describe("the raw picture", () => {
  it("lets packaging and brand words through, flags other writing, names garbled glyphs", () => {
    const f = checkRawImage(
      result([
        { text: "Habibah Sweets", confidence: 0.95, box: box(0.4, 0.5, 0.6, 0.55) },
        { text: "pistachio", confidence: 0.9, box: box(0.4, 0.56, 0.6, 0.6) },
        { text: "SALE 50%", confidence: 0.92, box: box(0.1, 0.1, 0.4, 0.2) },
        { text: "Kنnاfة", confidence: 0.88, box: box(0.6, 0.1, 0.9, 0.2) },
        { text: "mmmmm", confidence: 0.7, box: box(0.6, 0.3, 0.9, 0.4) },
        { text: "•", confidence: 0.9, box: box(0, 0, 0.01, 0.01) },
      ]),
      ["Habibah", "pistachio"],
    );
    expect(f.map((x) => [x.kind, x.detected])).toEqual([
      ["extra", "SALE 50%"],
      ["extra", "Kنnاfة"],
      ["extra", "mmmmm"],
    ]);
    expect(f[1].note).toMatch(/garbled/i);
    expect(f[2].note).toMatch(/garbled/i);
  });

  it("turns findings into review flags, faint ones apart, and the engine knows them as its own", () => {
    const f = checkRawImage(
      result([
        { text: "OPEN", confidence: 0.9, box: box(0, 0, 0.2, 0.1) },
        { text: "maybe", confidence: 0.3, box: box(0.5, 0.5, 0.7, 0.6) },
      ]),
      [],
    );
    const flags = ocrFlags(f);
    expect(flags.map((x) => x.kind)).toEqual(["text", "text"]);
    expect(flags[0].text.startsWith(OCR_FLAG_PREFIX)).toBe(true);
    expect(flags[0].text).toContain('"OPEN"');
    expect(flags[1].text.startsWith("Check the writing (low OCR confidence)")).toBe(true);
    expect(flags[1].text.startsWith(OCR_LOW_PREFIX)).toBe(true);
    expect(flags.every(isOcrFlag)).toBe(true);
    expect(isOcrFlag({ kind: "text", text: "Writing in the picture: a menu board" })).toBe(false);
    expect(ocrFlags([])).toEqual([]);
  });
});

describe("the engine never retakes on an OCR flag", () => {
  it("keeps the vision review's text flag as self-fixable and leaves both OCR flags out", () => {
    const qa = {
      found: false,
      count: 0,
      box: [],
      productConcern: false,
      notes: "",
      automated: true,
      flags: [
        { kind: "text" as const, text: "Writing in the picture: a menu board" },
        { kind: "text" as const, text: `${OCR_FLAG_PREFIX}"SALE".` },
        { kind: "text" as const, text: `${OCR_LOW_PREFIX}"maybe" may be writing; a human should look.` },
        { kind: "staging" as const, text: "Not how it is served: the cup is in the bowl." },
      ],
    };
    expect(selfFixable(qa).map((f) => f.text)).toEqual(["Writing in the picture: a menu board"]);
    expect(selfFixable({ ...qa, automated: false })).toEqual([]);
  });

  it("adds nothing and reaches nothing when OCR is not connected", async () => {
    const env = fakeEnv();
    const qa = { found: false, count: 0, box: [], productConcern: false, notes: "Checked.", automated: true, flags: [] };
    const out = await ocrReviewFlags(env, { id: "b1", client: null }, { id: "t1", post: 1 }, qa, { bytes: new Uint8Array([1, 2, 3]).buffer, mime: "image/png" }, ["pistachio"]);
    expect(out).toBe(qa);
    expect(reached).toEqual([]);
    const o = await resolveOcr(env);
    expect(o.connected).toBe(false);
    expect(o.provider.name).toBe("demo");
    expect(o.reason).toBe(NOT_CONNECTED);
  });

  it("with a Google key, reads the stored picture, keeps the check and adds review flags that never retake", async () => {
    const env = fakeEnv({ GEMINI_API_KEY: "test-key" } as never);
    const t = Date.now();
    await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Habibah', 'test-client', 'active', ?, ?)").bind(t, t).run();
    const stub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (!url.startsWith("https://vision.googleapis.com/")) throw new Error(`unexpected network call: ${url}`);
      return new Response(
        JSON.stringify({
          responses: [
            {
              fullTextAnnotation: {
                text: "Habibah\nSALE 50%\nxq",
                pages: [
                  {
                    width: 1000,
                    height: 1000,
                    blocks: [
                      { paragraphs: [{ confidence: 0.95, boundingBox: { vertices: [{ x: 400, y: 50 }, { x: 600, y: 50 }, { x: 600, y: 100 }, { x: 400, y: 100 }] }, words: [{ symbols: [..."Habibah"].map((ch) => ({ text: ch })) }] }] },
                      { paragraphs: [{ confidence: 0.93, boundingBox: { vertices: [{ x: 100, y: 800 }, { x: 500, y: 800 }, { x: 500, y: 900 }, { x: 100, y: 900 }] }, words: [{ symbols: [..."SALE"].map((ch) => ({ text: ch })) }, { symbols: [..."50%"].map((ch) => ({ text: ch })) }] }] },
                      { paragraphs: [{ confidence: 0.3, boundingBox: { vertices: [{ x: 700, y: 700 }, { x: 750, y: 700 }, { x: 750, y: 750 }, { x: 700, y: 750 }] }, words: [{ symbols: [..."xq"].map((ch) => ({ text: ch })) }] }] },
                    ],
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", stub);
    const qa = { found: false, count: 0, box: [], productConcern: false, notes: "Checked.", automated: true, flags: [{ kind: "staging" as const, text: "Not how it is served: the cup is in the bowl." }] };
    const out = await ocrReviewFlags(env, { id: "b1", client: "c1" }, { id: "t1", post: 2 }, qa, { bytes: new Uint8Array([9, 9, 9]).buffer, mime: "image/png" }, ["pistachio"]);
    expect(out.flags!.map((f) => f.text)).toEqual([
      "Not how it is served: the cup is in the bowl.",
      `${OCR_FLAG_PREFIX}"SALE 50%".`,
      `${OCR_LOW_PREFIX}"xq" may be writing; a human should look.`,
    ]);
    expect(out.notes).toBe("3 things to check before publishing.");
    // The OCR flags never make the engine spend: only the vision review's own fixable kinds would.
    expect(selfFixable(out)).toEqual([]);
    const rows = await env.DB.prepare("SELECT kind, provider, connected, post, task FROM ocr_checks WHERE batch = 'b1'").all<{ kind: string; provider: string; connected: number; post: number; task: string }>();
    expect(rows.results).toEqual([{ kind: "raw", provider: "google-vision", connected: 1, post: 2, task: "t1" }]);
    expect(stub).toHaveBeenCalledTimes(1);
  });
});

describe("Google Vision adapter", () => {
  it("sends DOCUMENT_TEXT_DETECTION with the key header to vision.googleapis.com only, and maps the boxes", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init: init ?? {} });
      if (new URL(url).host !== "vision.googleapis.com") throw new Error(`refused: ${url}`);
      return new Response(
        JSON.stringify({
          responses: [
            {
              fullTextAnnotation: {
                pages: [
                  {
                    width: 2000,
                    height: 1000,
                    property: { detectedLanguages: [{ languageCode: "ar", confidence: 0.9 }, { languageCode: "en", confidence: 0.4 }] },
                    blocks: [
                      {
                        paragraphs: [
                          {
                            boundingBox: { vertices: [{ x: 200, y: 100 }, { x: 1000, y: 100 }, { x: 1000, y: 300 }, { x: 200, y: 300 }] },
                            words: [
                              { confidence: 0.9, symbols: [{ text: "خ" }, { text: "ص" }, { text: "م", property: { detectedBreak: { type: "SPACE" } } }] },
                              { confidence: 0.8, symbols: [{ text: "٥" }, { text: "٠", property: { detectedBreak: { type: "LINE_BREAK" } } }] },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;
    const ocr = new GoogleVisionOcr({ key: "k-123" }, fetchImpl);
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]).buffer;
    const r = await ocr.detect({ bytes, mime: "image/png" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(VISION_URL);
    expect(calls[0].init.method).toBe("POST");
    expect((calls[0].init.headers as Record<string, string>)["x-goog-api-key"]).toBe("k-123");
    expect(calls[0].url).not.toContain("k-123");
    const body = JSON.parse(String(calls[0].init.body)) as { requests: { image: { content: string }; features: { type: string }[]; imageContext: { languageHints: string[] } }[] };
    expect(body.requests[0].features).toEqual([{ type: "DOCUMENT_TEXT_DETECTION" }]);
    expect(body.requests[0].image.content).toBe(btoa(String.fromCharCode(...new Uint8Array(bytes))));
    expect(body.requests[0].imageContext.languageHints).toContain("ar");
    expect(r.provider).toBe("google-vision");
    expect(r.language).toBe("ar");
    expect(r.blocks).toEqual([{ text: "خصم ٥٠", confidence: 0.85, box: [0.1, 0.1, 0.5, 0.3] }]);
    // Nothing but Vision was reached (the guard would have thrown on the global fetch anyway).
    expect(reached).toEqual([]);
  });

  it("falls back to the word annotations with the picture's own size, and surfaces API errors", () => {
    // A PNG header: 1000 x 500.
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(png.buffer).setUint32(16, 1000);
    new DataView(png.buffer).setUint32(20, 500);
    expect(imageSize(png.buffer)).toEqual({ width: 1000, height: 500 });
    const r = mapVisionResponse(
      {
        responses: [
          {
            textAnnotations: [
              { description: "OPEN NOW", locale: "en", boundingPoly: { vertices: [{ x: 0, y: 0 }, { x: 1000, y: 500 }] } },
              { description: "OPEN", boundingPoly: { vertices: [{ x: 100, y: 50 }, { x: 400, y: 50 }, { x: 400, y: 150 }, { x: 100, y: 150 }] } },
              { description: "NOW", boundingPoly: { vertices: [{ x: 500, y: 50 }, { x: 900, y: 50 }, { x: 900, y: 150 }, { x: 500, y: 150 }] } },
            ],
          },
        ],
      },
      { bytes: png.buffer, mime: "image/png" },
    );
    expect(r.language).toBe("en");
    expect(r.blocks.map((b) => [b.text, b.box])).toEqual([
      ["OPEN", [0.1, 0.1, 0.4, 0.3]],
      ["NOW", [0.5, 0.1, 0.9, 0.3]],
    ]);
    expect(() => mapVisionResponse({ responses: [{ error: { message: "quota" } }] })).toThrow(StudioError);
    expect(mapVisionResponse({ responses: [{}] }).blocks).toEqual([]);
  });
});

/* ───────────── Routes ───────────── */

type FakeEnv = ReturnType<typeof fakeEnv>;

function app() {
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", { id: "u1", email: "u@test", name: "U", role: "member" } as User);
    await next();
  });
  a.route("/api/studio/ocr", ocrRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message, ...(e.data ?? {}) }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}

const PICTURE = new Uint8Array([80, 78, 71, 1, 2, 3, 4, 5, 6, 7, 8, 9]).buffer;

async function seed() {
  const env = fakeEnv({ PREVIEW_NO_IMAGES: "1" } as never);
  const t = Date.now();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, created) VALUES ('u1', 'u@test', 'U', 'x', ?), ('u2', 'o@test', 'O', 'x', ?)").bind(t, t).run();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Habibah', 'test-client', 'active', ?, ?)").bind(t, t).run();
  const config = postConfig("c1", "2026-10", {
    model: "nano-banana-pro",
    plan: [
      { index: 1, type: "offer", title: "Pistachio week", brief: "The pistachio kunafa on marble.", caption: "", hashtags: "", product: "pistachio", headline: "خصم ٥٠٪", subline: "هذا الأسبوع فقط", offer: { products: ["pistachio"], price: "15 JD", details: "All week" } } as never,
    ],
  });
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'Test month', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b2', 'u2', 'Someone else', ?, 'idle', ?, ?, 'c1', '2026-10')").bind(JSON.stringify(config), t, t).run();
  await env.DB.prepare("INSERT INTO sources (id, batch, name, stem, key, mime, size, created, kind) VALUES ('s1', 'b1', 'pistachio.jpg', 'pistachio', 'u1/b1/src/s1.jpg', 'image/jpeg', 10, ?, 'product')").bind(t).run();
  await env.DB.prepare("INSERT INTO tasks (id, batch, source, card, status, output, prompt, updated, post) VALUES ('t1', 'b1', 's1', 1, 'review', 'u1/b1/output/t1/a.png', '', ?, 1)").bind(t).run();
  await env.BUCKET.put("u1/b1/output/t1/a.png", PICTURE, { httpMetadata: { contentType: "image/png" } });
  return env;
}

const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
const JSON_HEADERS = { "content-type": "application/json" };

describe("OCR routes under the fetch guard", () => {
  it("reports the demo provider when nothing is connected", async () => {
    const env = await seed();
    const r = await app().request("/api/studio/ocr/status", {}, env);
    expect(r.status).toBe(200);
    expect(await json(r)).toEqual({ connected: false, provider: "demo", reason: NOT_CONNECTED });
    expect(reached).toEqual([]);
  });

  it("checks the raw picture from storage with the demo fixture, labels it a demo result and lists it", async () => {
    const env = await seed();
    DEMO_OCR_FIXTURES.set(shortHash(PICTURE), [
      { text: "pistachio", confidence: 0.95, box: box(0.4, 0.5, 0.6, 0.55) },
      { text: "SALE 50%", confidence: 0.92, box: box(0.1, 0.1, 0.4, 0.2) },
      { text: "xq", confidence: 0.35, box: box(0.6, 0.6, 0.7, 0.7) },
    ]);
    const a = app();
    const r = await a.request("/api/studio/ocr/check", { method: "POST", body: JSON.stringify({ batch: "b1", post: 1, task: "t1", kind: "raw" }), headers: JSON_HEADERS }, env);
    expect(r.status).toBe(200);
    const d = (await json(r)) as { connected: boolean; provider: string; findings: Finding[]; check: { kind: string; connected: boolean; provider: string; task: string } };
    expect(d.connected).toBe(false);
    expect(d.provider).toBe("demo");
    expect(d.check).toMatchObject({ kind: "raw", connected: false, provider: "demo", task: "t1" });
    expect(d.findings.map((f) => [f.kind, f.detected, f.severity])).toEqual([
      ["extra", "SALE 50%", "warn"],
      ["low-confidence", "xq", "review"],
    ]);
    // Without a task id the post's latest picture is read.
    const again = await a.request("/api/studio/ocr/check", { method: "POST", body: JSON.stringify({ batch: "b1", post: 1, kind: "raw" }), headers: JSON_HEADERS }, env);
    expect(again.status).toBe(200);
    const list = (await json(await a.request("/api/studio/ocr/checks?batch=b1&post=1", {}, env))) as { checks: { kind: string; findings: Finding[]; detected: OcrResult }[] };
    expect(list.checks).toHaveLength(2);
    expect(list.checks[0].kind).toBe("raw");
    expect(list.checks[0].detected.blocks).toHaveLength(3);
    expect(reached).toEqual([]);
  });

  it("checks the uploaded artwork against the plan's words and the client's name", async () => {
    const env = await seed();
    const artwork = new Uint8Array([1, 1, 2, 3, 5, 8, 13]).buffer;
    DEMO_OCR_FIXTURES.set(shortHash(artwork), [
      { text: "خصم 50%", confidence: 0.98, box: box(0.1, 0.6, 0.5, 0.68) },
      { text: "هذا الاسبوع فقط", confidence: 0.96, box: box(0.1, 0.7, 0.5, 0.76) },
      { text: "15 JD", confidence: 0.99, box: box(0.7, 0.85, 0.9, 0.9) },
      { text: "Habibah", confidence: 0.9, box: box(0.4, 0.05, 0.6, 0.1) },
      { text: "Buy now", confidence: 0.93, box: box(0.7, 0.92, 0.9, 0.97) },
    ]);
    const form = new FormData();
    form.set("batch", "b1");
    form.set("post", "1");
    form.set("task", "t1");
    form.set("kind", "artwork");
    form.set("file", new Blob([artwork], { type: "image/png" }), "artwork.png");
    const r = await app().request("/api/studio/ocr/check", { method: "POST", body: form }, env);
    expect(r.status).toBe(200);
    const d = (await json(r)) as { findings: Finding[]; check: { kind: string; expected: { headline: string; price: string; allowed: string[] } } };
    expect(kinds(d.findings)).toEqual(["headline:match", "subline:match", "price:match", "text:extra"]);
    expect(d.check.expected).toMatchObject({ headline: "خصم ٥٠٪", price: "15 JD" });
    expect(d.check.expected.allowed).toEqual(expect.arrayContaining(["pistachio", "Habibah"]));
    expect(reached).toEqual([]);
  });

  it("refuses an artwork check without the file, a raw check without a picture, and another member's month", async () => {
    const env = await seed();
    const a = app();
    const noFile = await a.request("/api/studio/ocr/check", { method: "POST", body: JSON.stringify({ batch: "b1", post: 1, kind: "artwork" }), headers: JSON_HEADERS }, env);
    expect(noFile.status).toBe(400);
    const noPicture = await a.request("/api/studio/ocr/check", { method: "POST", body: JSON.stringify({ batch: "b1", post: 7, kind: "raw" }), headers: JSON_HEADERS }, env);
    expect(noPicture.status).toBe(404);
    const foreign = await a.request("/api/studio/ocr/check", { method: "POST", body: JSON.stringify({ batch: "b2", post: 1, kind: "raw" }), headers: JSON_HEADERS }, env);
    expect(foreign.status).toBe(404);
    expect(reached).toEqual([]);
  });

  it("the demo provider is deterministic: the same bytes give the same reading, other bytes give none", async () => {
    const fixtures = new Map([[shortHash(PICTURE), [{ text: "OPEN", confidence: 0.9, box: box(0, 0, 0.2, 0.1) }]]]);
    const mock = new MockOcr(fixtures);
    expect(mock.name).toBe("demo");
    const one = await mock.detect({ bytes: PICTURE, mime: "image/png" });
    const two = await mock.detect({ bytes: PICTURE.slice(0), mime: "image/png" });
    expect(one).toEqual(two);
    expect(one.provider).toBe("demo");
    expect((await mock.detect({ bytes: new Uint8Array([0]).buffer, mime: "image/png" })).blocks).toEqual([]);
    expect(shortHash(PICTURE)).toMatch(/^[0-9a-f]{8}$/);
  });
});
