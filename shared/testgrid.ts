/**
 * The test grid: one picture of the month's whole feed, made before any post is paid for, to check
 * the colours, the rhythm of the tiles and the look against the grid the month follows. The engine
 * paints the cells without words; the studio draws each post's words on its cell in the month's
 * fonts, so the Arabic is right.
 */
import { matchProduct, withoutBags, type Post } from "./posts";

export const TEST_GRID_MAX = 12;
export const TEST_GRID_COLUMNS = 3;

export interface TestGridLayout {
  rows: number;
  cols: number;
  /** The posts in the cells, left to right and top to bottom (the newest first, like Instagram). */
  order: number[];
  aspectRatio: string;
}

export interface TestGridInfo extends TestGridLayout {
  at: number;
}

/**
 * The cells in feed order: by grid tile when the month follows a grid, else the newest post first
 * (the top-left cell is the latest post on a profile). At most twelve, the newest ones.
 */
export function testGridLayout(plan: Post[]): TestGridLayout {
  const tileOf = (p: Post) => Number(/^Tile (\d+)/.exec(p.tile ?? "")?.[1] ?? NaN);
  const tiled = plan.length > 0 && plan.every((p) => !Number.isNaN(tileOf(p)));
  const sorted = tiled ? [...plan].sort((a, b) => tileOf(a) - tileOf(b)) : [...plan].sort((a, b) => b.index - a.index);
  const order = sorted.slice(0, TEST_GRID_MAX).map((p) => p.index);
  const cols = TEST_GRID_COLUMNS;
  const rows = Math.max(1, Math.ceil(order.length / cols));
  // Cells are 4:5 posts: three across and `rows` down, to the nearest ratio the engine makes.
  const ratio = (cols * 4) / (rows * 5);
  const ratios: [string, number][] = [
    ["5:4", 1.25],
    ["1:1", 1],
    ["4:5", 0.8],
    ["3:4", 0.75],
    ["2:3", 2 / 3],
    ["9:16", 9 / 16],
  ];
  const aspectRatio = ratios.reduce((best, r) => (Math.abs(r[1] - ratio) < Math.abs(best[1] - ratio) ? r : best))[0];
  return { rows, cols, order, aspectRatio };
}

/** Where the words sit on a cell, so the engine leaves that part calm. */
function wordsPlace(p: Post): string {
  const pos = p.ov?.position ?? p.tileSpec?.text.position;
  if (pos === "none" || (!p.headline && !p.subline)) return "";
  return pos ? ` Leave calm, empty space at the ${pos} for words added later.` : " Leave calm space for a headline added later.";
}

export function testGridPrompt(r: {
  client: string;
  layout: TestGridLayout;
  plan: Post[];
  palette: string[];
  /** How many product photos are attached first. */
  products: string[];
  /** A reference grid is attached after the products. */
  reference: boolean;
}): string {
  const { rows, cols, order } = r.layout;
  const byIndex = new Map(r.plan.map((p) => [p.index, p]));
  const cells = order.map((index, i) => {
    const p = byIndex.get(index)!;
    const row = Math.floor(i / cols) + 1;
    const col = (i % cols) + 1;
    const kind = p.tileSpec ? `${p.tileSpec.kind} tile` : p.type;
    const what = withoutBags(p.scene || p.brief || p.title).replace(/\s+/g, " ").slice(0, 420);
    const bg = p.tileSpec?.kind === "text" && p.tileSpec.background ? ` A plain background: ${p.tileSpec.background}.` : "";
    // Each cell names the photo of its own product, so the cells never swap products.
    const photo = (name: string) => {
      const m = matchProduct(name, r.products);
      return m ? `${name} (exactly as in Image ${r.products.indexOf(m) + 1})` : name;
    };
    const product = p.product ? ` Product: ${photo(p.product)}${p.products?.length ? ` with ${p.products.map(photo).join(", ")}` : ""}.` : "";
    return `Cell ${i + 1} (row ${row}, column ${col}), ${kind}: ${what}${bg}${product}${wordsPlace(p)}`;
  });
  return [
    `Make ONE image: the Instagram profile feed of the brand "${r.client}" for one month, seen as a grid of ${cols} columns and ${rows} rows of equal portrait 4:5 cells, edge to edge, separated by thin straight white lines (about 1% of the width). Every cell is a finished photograph of one post, each with its own scene; together they read as one consistent feed.`,
    r.products.length ? `Images 1 to ${r.products.length} are the brand's product photos (${r.products.join("; ")}): the products in the cells look like them, in their real colours and packaging.` : "",
    r.reference
      ? `Image ${r.products.length + 1} is the feed the brand wants to look like: follow its overall look, light, colour rhythm and the pattern of its tiles (where the plain text tiles, close-ups and wide shots fall). Never copy its products, text, logos or people.`
      : "",
    r.palette.length ? `The month's colours: ${r.palette.join(", ")}.` : "",
    `THE CELLS, left to right and top to bottom:\n${cells.join("\n")}`,
    "Each cell shows only its own product, the one its line names; a cell with no product named shows none of the brand's products.",
    "NO words, letters, numbers, logos or watermarks anywhere in the image: the words of each post are added afterwards. Packaging keeps only the design its product photo shows; never invent lettering, a logo or a label on it, on a wall, a sign or a pattern. No invented shop, branch, counter or interior with brand signs. No phone frame, no app interface, no profile header: only the grid of cells.",
  ]
    .filter(Boolean)
    .join("\n\n");
}
