import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig, type Config } from "../shared/config";
import {
  defaultPaletteSource,
  dedupeColours,
  gridColours,
  paletteSourceLine,
  resolvePalette,
  savedPaletteSource,
} from "../shared/palette-source";
import { gridTiles } from "../shared/grid-preview";
import type { User } from "../shared/types";

/**
 * Where a month's colours come from on the Direction board: the brand kit, the followed grid's
 * reading, both, or set by hand. A theme's palette is no longer a source: an old month that saved
 * one reads as "from an older theme" until a source is chosen, and saving a month's colours never
 * writes to a theme. The cast is saved on the month the same way the classic journey saves it.
 * No vendor is reached.
 */
type FakeEnv = ReturnType<typeof fakeEnv>;

const BRAND = [
  { name: "Pistachio", hex: "#8FBF6A" },
  { name: "Cream", hex: "#f3ece0" },
];
const GRID = [
  { name: "Cream", hex: "#f3ece0" },
  { name: "Walnut", hex: "#5a3b2e" },
  { name: "Ink", hex: "#111111" },
];

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
});
afterEach(() => {
  expect(reached.map((r) => r.url)).toEqual([]);
});

describe("the four colour sources", () => {
  it("brand: the brand kit's colours, each once", () => {
    const r = resolvePalette({
      source: "brand",
      brand: [...BRAND, { name: "again", hex: "#8fbf6a" }],
      grid: GRID,
      manual: [],
      gridFollowed: true,
    });
    expect(r.palette).toEqual([
      { name: "Pistachio", hex: "#8fbf6a" },
      { name: "Cream", hex: "#f3ece0" },
    ]);
    expect(r.needsGridRead).toBe(false);
    expect(r.warning).toBe("");
  });
  it("brand with an empty brand kit says so instead of guessing", () => {
    const r = resolvePalette({
      source: "brand",
      brand: [],
      grid: GRID,
      manual: [],
      gridFollowed: true,
    });
    expect(r.palette).toEqual([]);
    expect(r.warning).toMatch(/brand kit has no colours/);
  });
  it("grid: the followed grid's colours; a grid not read yet asks for the reading first", () => {
    expect(
      resolvePalette({ source: "grid", brand: BRAND, grid: GRID, manual: [], gridFollowed: true })
        .palette,
    ).toEqual(GRID);
    const unread = resolvePalette({
      source: "grid",
      brand: BRAND,
      grid: null,
      manual: [],
      gridFollowed: true,
    });
    expect(unread.palette).toEqual([]);
    expect(unread.needsGridRead).toBe(true);
    expect(unread.warning).toMatch(/Read the grid first/);
    // No grid followed: the reading cannot help; the designer picks a grid or another source.
    const none = resolvePalette({
      source: "grid",
      brand: BRAND,
      grid: null,
      manual: [],
      gridFollowed: false,
    });
    expect(none.needsGridRead).toBe(false);
    expect(none.warning).toMatch(/follows no grid/);
  });
  it("both: the brand colours first, then the grid's, a shared colour once", () => {
    const r = resolvePalette({
      source: "both",
      brand: BRAND,
      grid: GRID,
      manual: [],
      gridFollowed: true,
    });
    expect(r.palette.map((c) => c.hex)).toEqual(["#8fbf6a", "#f3ece0", "#5a3b2e", "#111111"]);
    // The grid's reading named no colours: the brand colours stand alone, and the card says so.
    const alone = resolvePalette({
      source: "both",
      brand: BRAND,
      grid: [],
      manual: [],
      gridFollowed: true,
    });
    expect(alone.palette.map((c) => c.hex)).toEqual(["#8fbf6a", "#f3ece0"]);
    expect(alone.warning).toMatch(/brand colours stand alone/);
  });
  it("manual: the colours set by hand, valid hexes only, at most eight", () => {
    const manual = [
      { name: "Rose", hex: "#E8B4B8" },
      { name: "bad", hex: "pink" },
      { name: "", hex: "#002a5c" },
    ];
    const r = resolvePalette({
      source: "manual",
      brand: BRAND,
      grid: GRID,
      manual,
      gridFollowed: false,
    });
    expect(r.palette.map((c) => c.hex)).toEqual(["#e8b4b8", "#002a5c"]);
    expect(r.palette[0].name).toBe("Rose");
    // A colour without a name is named from its hex, never left blank.
    expect(r.palette[1].name).not.toBe("");
    expect(
      dedupeColours(
        Array.from({ length: 12 }, (_, i) => ({ name: "c", hex: `#00000${i.toString(16)}` })),
      ),
    ).toHaveLength(8);
    expect(
      resolvePalette({
        source: "manual",
        brand: BRAND,
        grid: GRID,
        manual: [],
        gridFollowed: false,
      }).warning,
    ).toMatch(/No colours set yet/);
  });
  it("defaults to the brand colours; to the grid's when the brand kit has none and a grid is followed", () => {
    expect(defaultPaletteSource(BRAND, true)).toBe("brand");
    expect(defaultPaletteSource(BRAND, false)).toBe("brand");
    expect(defaultPaletteSource([], true)).toBe("grid");
    expect(defaultPaletteSource([], false)).toBe("brand");
  });
});

describe("what a saved month reads as", () => {
  it("the four sources read back as themselves; the older markers read as set by hand", () => {
    for (const from of ["brand", "grid", "both", "manual"] as const)
      expect(savedPaletteSource({ palette: BRAND, paletteFrom: from }, [])).toBe(from);
    expect(savedPaletteSource({ palette: BRAND, paletteFrom: "designer" }, [])).toBe("manual");
    expect(savedPaletteSource({ palette: BRAND, paletteFrom: "brief" }, [])).toBe("manual");
    expect(paletteSourceLine("manual", { palette: BRAND, paletteFrom: "brief" })).toBe(
      "set by the brief",
    );
    expect(paletteSourceLine("manual", { palette: BRAND, paletteFrom: "manual" })).toBe(
      "set by you",
    );
  });
  it("a month with no colours of its own on a theme that has some is an older theme's, never offered again", () => {
    expect(savedPaletteSource({}, GRID)).toBe("theme");
    expect(paletteSourceLine("theme")).toMatch(/older theme/);
    expect(paletteSourceLine("theme")).toMatch(/no longer offered/);
    // Nothing saved, no theme palette: the default applies.
    expect(savedPaletteSource({}, [])).toBeNull();
    expect(savedPaletteSource(null, null)).toBeNull();
    expect(paletteSourceLine(null)).toBe("not chosen yet");
  });
});

describe("the grid's colours from its reading", () => {
  const read = {
    world: "Marble and walnut, warm light; a soft cream #F3ECE0 runs through the feed.",
    tiles: [
      {
        position: "row 1, col 1",
        scene: "A cup",
        productPlacement: "",
        textPlacement: "",
        kind: "product" as const,
        items: "cup",
        background: "marble",
        text: {
          position: "bottom" as const,
          align: "center" as const,
          size: "medium" as const,
          color: "#111111",
          style: "serif",
        },
      },
      {
        position: "row 1, col 2",
        scene: "Words",
        productPlacement: "",
        textPlacement: "",
        kind: "text" as const,
        items: "",
        background: "cream #f3ece0",
        text: {
          position: "center" as const,
          align: "center" as const,
          size: "huge" as const,
          color: "#5A3B2E",
          style: "bold sans",
        },
      },
      {
        position: "row 1, col 3",
        scene: "A tray",
        productPlacement: "",
        textPlacement: "",
        kind: "product" as const,
        items: "tray",
        background: "deep walnut #5a3b2e",
        text: {
          position: "none" as const,
          align: "center" as const,
          size: "small" as const,
          color: "#ffffff",
          style: "",
        },
      },
    ],
  };
  it("takes the plain backgrounds first, then the lettering, then the world, each hex once, named from the words beside it", () => {
    const { tiles } = gridTiles(read);
    expect(tiles.map((t) => t.colour)).toEqual(["#111111", "#5a3b2e", ""]);
    const colours = gridColours(tiles, read.world);
    expect(colours.map((c) => c.hex)).toEqual(["#f3ece0", "#5a3b2e", "#111111"]);
    expect(colours[0].name).toBe("Cream");
    expect(colours[1].name).toBe("Deep walnut");
    // The lettering colour of tile 1 has no words beside it: named from the hex itself.
    expect(colours[2].name).not.toBe("");
  });
  it("a grid not read, or read without a colour, gives nothing", () => {
    expect(gridColours(null)).toEqual([]);
    expect(gridColours([{ background: "marble", colour: "" }], "warm light")).toEqual([]);
  });
});

async function app() {
  const { StudioError } = await import("../server/errors");
  const { studioRoutes } = await import("../server/studio");
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", { id: "u1", email: "u@test", name: "U", role: "admin" } as User);
    await next();
  });
  a.route("/api/studio", studioRoutes);
  a.onError((e, c) =>
    e instanceof StudioError
      ? c.json({ error: e.message, ...(e.data ?? {}) }, e.status as 400)
      : c.json({ error: String(e) }, 500),
  );
  return a;
}

async function seed(config: Config) {
  const env = fakeEnv({ PREVIEW_NO_IMAGES: "1" } as never);
  const t = Date.now();
  await env.DB.prepare(
    "INSERT INTO users (id, email, name, password_hash, created) VALUES ('u1', 'u@test', 'U', 'x', ?)",
  )
    .bind(t)
    .run();
  await env.DB.prepare(
    "INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Sample', 'sample', 'active', ?, ?)",
  )
    .bind(t, t)
    .run();
  await env.DB.prepare(
    "INSERT INTO skills (id, title, client, palette, palette_auto, created, updated) VALUES ('th1', 'Autumn', 'c1', ?, 1, ?, ?)",
  )
    .bind(JSON.stringify(GRID), t, t)
    .run();
  await env.DB.prepare(
    "INSERT INTO batches (id, owner, name, config, state, created, updated, client, month, theme) VALUES ('b1', 'u1', 'Test month', ?, 'idle', ?, ?, 'c1', '2026-10', 'th1')",
  )
    .bind(JSON.stringify(config), t, t)
    .run();
  return env;
}
const configOf = async (env: FakeEnv) =>
  JSON.parse(
    (await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{
      config: string;
    }>())!.config,
  ) as Config;
const themePalette = async (env: FakeEnv) =>
  (await env.DB.prepare("SELECT palette FROM skills WHERE id = 'th1'").first<{
    palette: string;
  }>())!.palette;
const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("saving the month's colours and cast", () => {
  it("saves the colours with their source on the month alone; the theme keeps its own palette", async () => {
    const env = await seed(postConfig("c1", "2026-10", { theme: "th1" }));
    const a = await app();
    const r = await a.request(
      "/api/studio/posts/palette",
      json({ batch: "b1", palette: [...BRAND, ...GRID], from: "both" }),
      env,
    );
    expect(r.status).toBe(200);
    const body = (await r.json()) as { palette: { hex: string }[]; from: string };
    expect(body.from).toBe("both");
    expect(body.palette.map((c) => c.hex)).toEqual(["#8fbf6a", "#f3ece0", "#5a3b2e", "#111111"]);
    const cfg = await configOf(env);
    expect(cfg.paletteFrom).toBe("both");
    expect(cfg.palette?.map((c) => c.hex)).toEqual(["#8fbf6a", "#f3ece0", "#5a3b2e", "#111111"]);
    // The theme's palette is untouched: a month's colours never change a theme any more.
    expect(JSON.parse(await themePalette(env))).toEqual(GRID);
    expect(savedPaletteSource(cfg, GRID)).toBe("both");
  });
  it("a save without a source is set by hand; an unknown source is refused; no colours clears the month's", async () => {
    const env = await seed(postConfig("c1", "2026-10", { theme: "th1" }));
    const a = await app();
    expect(
      (await a.request("/api/studio/posts/palette", json({ batch: "b1", palette: BRAND }), env))
        .status,
    ).toBe(200);
    expect((await configOf(env)).paletteFrom).toBe("manual");
    expect(
      (
        await a.request(
          "/api/studio/posts/palette",
          json({ batch: "b1", palette: BRAND, from: "theme" }),
          env,
        )
      ).status,
    ).toBe(400);
    expect((await configOf(env)).paletteFrom).toBe("manual");
    expect(
      (await a.request("/api/studio/posts/palette", json({ batch: "b1", palette: [] }), env))
        .status,
    ).toBe(200);
    const cleared = await configOf(env);
    expect(cleared.palette).toBeUndefined();
    expect(cleared.paletteFrom).toBeUndefined();
    // The old theme-write-through field is ignored rather than honoured: the theme never changes.
    expect(
      (
        await a.request(
          "/api/studio/posts/palette",
          json({ batch: "b1", palette: BRAND, from: "brand", theme: true }),
          env,
        )
      ).status,
    ).toBe(200);
    expect(JSON.parse(await themePalette(env))).toEqual(GRID);
  });
  it("the Models row saves the cast through the settings route, as the classic journey does", async () => {
    const env = await seed(postConfig("c1", "2026-10", { theme: "th1" }));
    const a = await app();
    const r = await a.request(
      "/api/studio/posts/settings",
      {
        ...json({ batch: "b1", ambassadors: ["amb-omar", "amb-lina", "amb-omar"] }),
        method: "PUT",
      },
      env,
    );
    expect(r.status).toBe(200);
    expect((await configOf(env)).ambassadors).toEqual(["amb-omar", "amb-lina"]);
    // Taking everyone out of the month leaves an empty cast, not the old one.
    await a.request(
      "/api/studio/posts/settings",
      { ...json({ batch: "b1", ambassadors: [] }), method: "PUT" },
      env,
    );
    expect((await configOf(env)).ambassadors).toEqual([]);
    // More than three is refused: the month casts at most three.
    expect(
      (
        await a.request(
          "/api/studio/posts/settings",
          { ...json({ batch: "b1", ambassadors: ["a", "b", "c", "d"] }), method: "PUT" },
          env,
        )
      ).status,
    ).toBe(400);
  });
});
