/**
 * The preview of a library grid before it is applied: what its tiles are (their kind, purpose and
 * layout, from the read kept in grid_reads), what the month would get from it (one post per
 * tile, the text tiles drawn free), and what happens when the month asks for a different number
 * of posts than the grid has tiles. Pure: nothing here reads storage or calls a model.
 */
import { TILE_KINDS, type GridRead, type TileKind } from "./posts";

export const TILE_KIND_LABEL: Record<TileKind | "picture", string> = {
  product: "Product",
  drink: "Drink",
  food: "Food",
  place: "Place",
  person: "Person",
  text: "Text tile",
  texture: "Texture",
  detail: "Detail",
  picture: "Picture",
};

export interface GridTilePreview {
  /** 1-based tile number, in reading order (the post that follows it). */
  n: number;
  position: string;
  row: number;
  col: number;
  kind: TileKind | "picture";
  /** What the tile shows, in a line. */
  purpose: string;
  items: string;
  background: string;
  /** Where the tile's words sit ("words at the bottom, large" / "no words"). */
  words: string;
  /** The lettering's colour as read (#rrggbb), or "" when the tile has no words or none was read. */
  colour: string;
  /** A text tile is drawn in the studio, free; every other tile is a picture from the engine. */
  free: boolean;
}

const kindOf = (k: string | undefined): TileKind | "picture" => (k && (TILE_KINDS as readonly string[]).includes(k) ? (k as TileKind) : "picture");

/** The tiles of a read grid, one line each, with the layout they sit in. */
export function gridTiles(read: Pick<GridRead, "tiles"> | null | undefined): { tiles: GridTilePreview[]; rows: number; cols: number } {
  const tiles: GridTilePreview[] = [];
  let rows = 0;
  let cols = 0;
  for (const [i, t] of (read?.tiles ?? []).entries()) {
    const m = /row\s*(\d+).*?col\s*(\d+)/i.exec(t.position ?? "");
    const row = m ? Number(m[1]) : Math.floor(i / 3) + 1;
    const col = m ? Number(m[2]) : (i % 3) + 1;
    rows = Math.max(rows, row);
    cols = Math.max(cols, col);
    const kind = kindOf(t.kind);
    const text = t.text;
    const words = !text || text.position === "none" ? "no words on it" : `words at the ${text.position}, ${text.size}${text.style ? `, ${text.style}` : ""}`;
    tiles.push({
      n: i + 1,
      position: t.position ?? `row ${row}, col ${col}`,
      row,
      col,
      kind,
      purpose: String(t.scene ?? "").replace(/\s+/g, " ").trim().slice(0, 160),
      items: String(t.items ?? "").slice(0, 120),
      background: String(t.background ?? "").slice(0, 80),
      words,
      colour: text && text.position !== "none" ? (/#[0-9a-f]{6}\b/i.exec(text.color ?? "")?.[0]?.toLowerCase() ?? "") : "",
      free: kind === "text",
    });
  }
  return { tiles, rows, cols };
}

export interface GridMismatch {
  /** Tiles in the grid (its posts when used as it is). */
  grid: number;
  /** Posts the month asks for. */
  requested: number;
  /** Tiles that get no post when the month has fewer posts than tiles (1-based). */
  dropped: number[];
  /** Tiles that are used twice when the month has more posts than tiles (1-based). */
  repeated: number[];
  /** Text tiles (separators) among the dropped and the repeated. */
  textDropped: number;
  textRepeated: number;
  /** One paragraph each: what "Use the grid's N posts" and "Adapt to my M posts" do. */
  useGrid: string;
  adapt: string;
}

const list = (ns: number[]) => (ns.length <= 1 ? ns.join("") : ns.length === 2 ? `${ns[0]} and ${ns[1]}` : `${ns[0]}–${ns[ns.length - 1]}`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The month follows the grid tile by tile and cycles: post k takes tile ((k-1) mod N)+1. With
 * fewer posts than tiles the last tiles are dropped; with more, the first tiles are used again at
 * the end of the feed. Null when the numbers match.
 */
export function gridMismatch(tiles: number | { kind?: string }[], requested: number): GridMismatch | null {
  const kinds = typeof tiles === "number" ? Array.from({ length: tiles }, () => "picture") : tiles.map((t) => kindOf(t.kind));
  const n = kinds.length;
  const m = Math.max(1, Math.round(requested));
  if (!n || n === m) return null;
  const dropped = m < n ? Array.from({ length: n - m }, (_, i) => m + i + 1) : [];
  const repeated = m > n ? Array.from({ length: m - n }, (_, i) => (i % n) + 1) : [];
  const textAt = (ns: number[]) => ns.filter((t) => kinds[t - 1] === "text").length;
  const textDropped = textAt(dropped);
  const textRepeated = textAt(repeated);
  const texts = kinds.filter((k) => k === "text").length;
  const useGrid = `Every one of the ${plural(n, "tile")} becomes one post, in the grid's order${texts ? `, with its ${plural(texts, "text tile")} drawn here as the separator${texts === 1 ? "" : "s"} where the grid has ${texts === 1 ? "it" : "them"}` : ""}. The month is set to ${plural(n, "post")} and the feed reads exactly like the grid.`;
  const adapt =
    m < n
      ? `The first ${plural(m, "tile")} become the ${plural(m, "post")}; tile${dropped.length === 1 ? "" : "s"} ${list(dropped)} ${dropped.length === 1 ? "gets" : "get"} no post${textDropped ? `, so ${plural(textDropped, "separator")} (text tile${textDropped === 1 ? "" : "s"}) of the grid ${textDropped === 1 ? "is" : "are"} lost` : ""}. The feed keeps the grid's rhythm up to tile ${m} and stops there.`
      : `All ${plural(n, "tile")} become posts, then tile${repeated.length === 1 ? "" : "s"} ${list(repeated)} ${repeated.length === 1 ? "is" : "are"} used a second time for post${repeated.length === 1 ? "" : "s"} ${list(repeated.map((_, i) => n + i + 1))}${textRepeated ? `, so ${plural(textRepeated, "separator")} appear${textRepeated === 1 ? "s" : ""} twice` : ""}. The feed repeats the grid's first row${m - n >= 3 ? "s" : ""} at the end, in the same order.`;
  return { grid: n, requested: m, dropped, repeated, textDropped, textRepeated, useGrid, adapt };
}

/** The month a grid gives: one post per tile, every tile a single design, the text tiles free. */
export function gridMonth(tiles: { kind?: string }[] | number, count: number): { posts: number; designs: number; images: number; tiles: number } {
  const kinds = typeof tiles === "number" ? Array.from({ length: tiles }, () => "picture") : tiles.map((t) => kindOf(t.kind));
  const n = kinds.length;
  const m = Math.max(1, Math.round(count));
  let text = 0;
  for (let k = 0; k < m; k++) if (n && kinds[k % n] === "text") text++;
  return { posts: m, designs: m, images: m - text, tiles: text };
}

/** The read of a grid alone (its world, tiles and fonts), without planning a month from it. */
export const GRID_READ_SCHEMA = {
  type: "object",
  properties: {
    world: { type: "string" },
    tiles: {
      type: "array",
      items: {
        type: "object",
        properties: {
          position: { type: "string" },
          scene: { type: "string" },
          productPlacement: { type: "string" },
          textPlacement: { type: "string" },
          kind: { type: "string", enum: [...TILE_KINDS] },
          items: { type: "string" },
          background: { type: "string" },
          text: {
            type: "object",
            properties: {
              position: { type: "string", enum: ["top", "center", "bottom", "none"] },
              align: { type: "string", enum: ["left", "center", "right"] },
              size: { type: "string", enum: ["small", "medium", "large", "huge"] },
              color: { type: "string" },
              style: { type: "string" },
            },
            required: ["position", "align", "size", "color", "style"],
          },
        },
        required: ["position", "scene", "productPlacement", "textPlacement", "kind", "items", "background", "text"],
      },
    },
    fonts: {
      type: "object",
      properties: { headline: { type: "string" }, body: { type: "string" }, why: { type: "string" } },
      required: ["headline", "body", "why"],
    },
  },
  required: ["world", "tiles", "fonts"],
};

export function gridReadInstruction(tilesHint: number): string {
  return [
    `The attached image is a social-media feed grid (several post tiles in one picture${tilesHint ? `, about ${tilesHint} tiles` : ""}). Read it tile by tile so a designer can see what each tile is before planning a month from it. Nothing is planned here: describe the grid only.`,
    "world: one paragraph on the sets, materials, surfaces, props, palette with colour words, light, camera angles, mood, how products are staged and where text sits. Ignore the grid's brand, products, logos and words: only the staging matters.",
    `tiles: one entry per tile in reading order (left to right, top to bottom): position like 'row 1, col 2'; scene (one sentence: what the tile shows and what it is for in the feed); productPlacement; textPlacement; kind (${TILE_KINDS.join(", ")}: "text" is a tile that is mostly words on a plain or textured background, "place" shows a shop, café, kitchen or interior, "drink" a beverage, "food" a dish or dessert, "product" a packaged item, "person" a person, "texture" a close-up surface, "detail" a close-up of an ingredient or object); items (the objects and props on it, as words); background (its colour words with #rrggbb when it is plain, or the texture); text (position top, center, bottom or none; align; size small, medium, large or huge; color #rrggbb; style: the lettering).`,
    "fonts: headline and body as the names of fonts closest to the grid's lettering (or \"\"), and why in one sentence.",
    'Return ONLY JSON: {"world": "...", "tiles": [...], "fonts": {...}}.',
  ].join("\n\n");
}
