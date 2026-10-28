/**
 * A designed gallery style applied to a post (server/posts.ts assignStyles): the pin's design becomes
 * the post's layers (ov.design, from the style: ov.designFrom) in place of the plain typography, built
 * again with the words written for the style; a plain style or no style takes an automatic design off;
 * layers the designer edited by hand (the Text studio's save) stay and are never rebuilt; a campaign
 * post is left alone. The preview answers the model calls: nothing is paid and nothing is fetched.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig } from "../shared/config";
import type { Post } from "../shared/posts";
import type { User } from "../shared/types";
import type { StyleDesign } from "../shared/style-design";
import { isTextLayer, type TextLayer } from "../shared/layers";
import { INSTAGRAM_GROUP, TYPOGRAPHY_GROUP } from "../shared/style-layers";
import { assignStyles, ownedPlan, savePlan } from "../server/posts";

type FakeEnv = ReturnType<typeof fakeEnv>;
const ADMIN: User = { id: "u1", email: "admin@test", name: "Firas", role: "admin" };

const design: StyleDesign = {
  kind: ["typography", "mockup"],
  texts: [
    {
      role: "big",
      x: 0.08,
      y: 0.1,
      w: 0.22,
      h: 0.5,
      rotate: -90,
      weight: "heavy",
      case: "upper",
      tone: "light",
      align: "center",
      decoration: "none",
      behind: true,
      sample: "BRIGADEIRO",
    },
    {
      role: "label",
      x: 0.6,
      y: 0.5,
      w: 0.3,
      h: 0.05,
      rotate: 0,
      weight: "regular",
      case: "upper",
      tone: "light",
      align: "center",
      decoration: "oval",
      behind: false,
      sample: "new",
    },
  ],
  mockup: {
    ui: "instagram-post",
    panel: { x: 0.05, y: 0.6, w: 0.9, h: 0.36, radius: 0.03, tone: "light" },
    parts: {
      actions: true,
      likes: true,
      caption: true,
      hashtags: true,
      account: true,
      comments: true,
      logo: true,
    },
    logo: { x: 0.75, y: 0.05, w: 0.2 },
  },
  space: "the left third beside the pour and the lower third",
  accent: "brand",
};

const post = (index: number, over: Partial<Post> = {}): Post =>
  ({
    index,
    type: "product",
    title: `Post ${index}`,
    brief: "A pour of chocolate.",
    caption: "Our pour is back. Order before Sunday.",
    hashtags: "#habibah",
    headline: "Brigadeiro season",
    subline: "Handmade in Amman",
    ...over,
  }) as Post;

async function seed(): Promise<FakeEnv> {
  const env = fakeEnv({ PREVIEW_NO_IMAGES: "1" } as never);
  const t = Date.now();
  await env.DB.prepare(
    "INSERT INTO users (id, email, name, password_hash, created) VALUES ('u1', 'admin@test', 'Firas', 'x', ?)",
  )
    .bind(t)
    .run();
  await env.DB.prepare(
    "INSERT INTO clients (id, name, slug, status, created, updated, colors, fonts, logo_key, language) VALUES ('c1', 'Habibah', 'habibah-design', 'active', ?, 9, ?, ?, 'clients/c1/logo', 'en')",
  )
    .bind(
      t,
      JSON.stringify([{ name: "Navy", hex: "#0b1f6b" }]),
      JSON.stringify({ headline: "Graphic School", body: "Almarai" }),
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO client_profiles (client, instagram, updated) VALUES ('c1', '@habibah.sweets', 1)",
  ).run();
  const hand = {
    version: 1,
    layers: [
      {
        id: "h1",
        type: "text",
        text: "My own words",
        x: 0.1,
        y: 0.1,
        w: 0.8,
        font: "Inter",
        weight: 700,
        size: 0.06,
        lineHeight: 1.1,
        align: "left",
        fill: { type: "solid", color: "#ffffff" },
      },
    ],
  };
  const config = postConfig("c1", "2026-11", {
    model: "nano-banana-pro",
    plan: [
      post(1, {
        ov: {
          typo: { style: "behind", word: "Brigadeiro", font: "Anton" },
          typoFor: "u1/b1/out.png",
        },
      }),
      post(2, {
        group: { id: "g1", kind: "carousel", slide: 1, of: 2 },
        ov: { design: hand as never },
      }),
      post(3, { ov: { design: hand as never } }),
    ],
  });
  await env.DB.prepare(
    "INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'Habibah · November', ?, 'idle', ?, ?, 'c1', '2026-11')",
  )
    .bind(JSON.stringify(config), t, t)
    .run();
  await env.DB.prepare(
    "INSERT INTO styles (id, kind, status, title, prompt, tags, source, note, created, updated, products, design) VALUES ('designed', 'product', 'active', 'Brigadeiro pour', 'a slow chocolate pour over the box, a huge word along the pour', 'typography', '', '', ?, ?, 1, ?)",
  )
    .bind(t, t, JSON.stringify(design))
    .run();
  await env.DB.prepare(
    "INSERT INTO styles (id, kind, status, title, prompt, tags, source, note, created, updated, products) VALUES ('plain', 'product', 'active', 'Starry Slush', 'the product alone under a starry sky, low angle', 'night', '', '', ?, ?, 1)",
  )
    .bind(t, t)
    .run();
  return env;
}

const planOf = async (env: FakeEnv) =>
  (JSON.parse((await ownedPlan(env, ADMIN, "b1")).config) as { plan: Post[] }).plan;
const texts = (p: Post) =>
  (p.ov?.design?.layers ?? []).filter((l): l is TextLayer => isTextLayer(l));

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
});
afterEach(() => {
  expect(reached.map((r) => r.url)).toEqual([]);
});

describe("a designed style applied to a post", () => {
  it("writes the pin's design as the post's layers with the client's account and the words written for the style, and drops the plain typography", async () => {
    const env = await seed();
    const plan = await assignStyles(env, ADMIN, "b1", [{ index: 1, style: "designed" }]);
    const one = plan.find((p) => p.index === 1)!;
    expect(one.style).toBe("designed");
    expect(one.ov?.designFrom).toBe("designed");
    expect(one.ov?.designHand).toBeUndefined();
    expect(one.ov?.typo).toBeUndefined();
    expect(one.ov?.typoFor).toBeUndefined();
    const layers = one.ov!.design!.layers;
    expect(layers.filter((l) => l.group === INSTAGRAM_GROUP).length).toBeGreaterThan(8);
    expect(layers.filter((l) => l.group === TYPOGRAPHY_GROUP).length).toBe(3);
    // The words were written again for the style (the preview's sample headline), and the design followed them.
    expect(one.headline).toBe("Sample headline");
    expect(
      texts(one).find((l) => l.name === "Big word (behind the product on the pin)")!.text,
    ).toBe("Sample");
    expect(
      texts(one)
        .find((l) => l.name === "Caption")!
        .text.startsWith("habibah.sweets "),
    ).toBe(true);
    expect(texts(one).find((l) => l.name === "Account name")!.text).toBe("Habibah");
    expect(layers.find((l) => l.name === "Profile picture")).toMatchObject({
      type: "image",
      src: "/api/studio/clients/c1/logo?v=9",
    });
    expect(layers.some((l) => l.type === "logo")).toBe(true);
    expect(
      texts(one).find((l) => l.name === "Big word (behind the product on the pin)")!.font,
    ).toBe("Graphic School");
  });

  it("takes the automatic design off with its style, whether the style goes or a plain one replaces it", async () => {
    const env = await seed();
    await assignStyles(env, ADMIN, "b1", [{ index: 1, style: "designed" }]);
    const plain = (await assignStyles(env, ADMIN, "b1", [{ index: 1, style: "plain" }])).find(
      (p) => p.index === 1,
    )!;
    expect(plain.style).toBe("plain");
    expect(plain.ov?.design).toBeUndefined();
    expect(plain.ov?.designFrom).toBeUndefined();
    await assignStyles(env, ADMIN, "b1", [{ index: 1, style: "designed" }]);
    const off = (await assignStyles(env, ADMIN, "b1", [{ index: 1, style: null }])).find(
      (p) => p.index === 1,
    )!;
    expect(off.style).toBeUndefined();
    expect(off.ov?.design).toBeUndefined();
    expect(off.ov?.designFrom).toBeUndefined();
  });

  it("marks layers the designer edited by hand and keeps them when the style is taken off", async () => {
    const env = await seed();
    await assignStyles(env, ADMIN, "b1", [{ index: 1, style: "designed" }]);
    // The Text studio saves the plan with the layers changed: a hand edit, stamped as such.
    const before = await planOf(env);
    const edited = before.map((p) =>
      p.index === 1
        ? {
            ...p,
            ov: {
              ...p.ov,
              design: {
                ...p.ov!.design!,
                layers: p.ov!.design!.layers.filter((l) => l.group !== INSTAGRAM_GROUP),
              },
            },
          }
        : p,
    );
    await savePlan(env, await ownedPlan(env, ADMIN, "b1"), edited as Post[]);
    const saved = (await planOf(env)).find((p) => p.index === 1)!;
    expect(saved.ov?.designHand).toBe(true);
    expect(saved.ov?.designFrom).toBe("designed");
    // Saving the same layers again is not a hand edit.
    const untouched = (await planOf(env)).find((p) => p.index === 3)!;
    await savePlan(env, await ownedPlan(env, ADMIN, "b1"), await planOf(env));
    expect((await planOf(env)).find((p) => p.index === 3)!.ov).toEqual(untouched.ov);
    // The style goes; the designer's layers stay (no longer tied to the style).
    const off = (await assignStyles(env, ADMIN, "b1", [{ index: 1, style: null }])).find(
      (p) => p.index === 1,
    )!;
    expect(off.ov?.design?.layers.length).toBe(saved.ov!.design!.layers.length);
    expect(off.ov?.designHand).toBe(true);
    expect(off.ov?.designFrom).toBeUndefined();
  });

  it("leaves a campaign post's own design alone and keeps a hand-made design through a plain style", async () => {
    const env = await seed();
    const plan = await assignStyles(env, ADMIN, "b1", [
      { index: 2, style: "designed" },
      { index: 3, style: "plain" },
    ]);
    const campaign = plan.find((p) => p.index === 2)!;
    expect(campaign.style).toBe("designed");
    expect(campaign.ov?.designFrom).toBeUndefined();
    expect(texts(campaign).map((l) => l.text)).toEqual(["My own words"]);
    const own = plan.find((p) => p.index === 3)!;
    expect(own.style).toBe("plain");
    expect(texts(own).map((l) => l.text)).toEqual(["My own words"]);
  });
});
