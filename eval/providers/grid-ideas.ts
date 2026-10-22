/**
 * Follow a grid: the grid instruction (shared/posts.ts gridIdeasInstruction) is answered by the
 * demo fixture's grid read (nine tiles, one of them a text tile) and its posts are parsed as the
 * /grid-ideas route parses them.
 */
import { GRID_SCHEMA, gridIdeasInstruction, parseIdeas, type TileKind } from "../../shared/posts";
import { demoAnswer } from "../../server/demo";
import { CLIENT, PALETTE, PRODUCT_NAMES, PRODUCT_NOTES, approvedLessonLines, num, str, unapprovedLessonLines } from "./fixtures";

export function gridIdeas(vars: Record<string, unknown>) {
  const count = num(vars.count, 9);
  const instruction = gridIdeasInstruction({
    clientName: CLIENT.name,
    tone: CLIENT.tone,
    dos: CLIENT.dos,
    donts: str(vars.donts, CLIENT.donts),
    language: CLIENT.language,
    palette: PALETTE,
    style: CLIENT.style,
    themeTitle: "",
    themeDirection: "",
    products: PRODUCT_NAMES,
    productNotes: PRODUCT_NOTES,
    month: "2026-11",
    count,
    lessons: approvedLessonLines(),
    hasPlaces: false,
  });
  const text = demoAnswer(instruction, GRID_SCHEMA, 1);
  const read = JSON.parse(text) as { world: string; tiles: { kind: TileKind; position: string }[]; fonts: { headline: string; body: string } };
  const posts = parseIdeas(text, count, PRODUCT_NAMES);
  const textTiles = read.tiles.filter((t) => t.kind === "text").length;
  return {
    method: "grid-ideas",
    instruction,
    world: read.world,
    tiles: read.tiles.map((t) => ({ position: t.position, kind: t.kind })),
    posts: posts.map((p) => ({ index: p.index, type: p.type, title: p.title, product: p.product ?? "" })),
    counts: { tiles: read.tiles.length, textTiles, posts: posts.length, picturesIfTextTilesDrawnHere: posts.length - Math.min(posts.length, textTiles) },
    memory: { approved: approvedLessonLines(), unapproved: unapprovedLessonLines() },
  };
}
