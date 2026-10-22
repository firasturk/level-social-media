/**
 * Where a month's colours come from, chosen on the Direction board: the client's brand colours,
 * the colours of the grid the month follows (read from the grid picture), both, or colours set by
 * hand. A theme's palette is no longer offered: a month saved on one before this change keeps its
 * colours, labelled as coming from an older theme, until a source is chosen. Pure: nothing here
 * reads storage or calls a model.
 */
import { colourName } from "./posts";

export type Colour = { name: string; hex: string };

/** The four sources a designer can choose. */
export type PaletteSource = "brand" | "grid" | "both" | "manual";
export const PALETTE_SOURCES: readonly PaletteSource[] = ["brand", "grid", "both", "manual"];

/** What a month may have saved as `paletteFrom`: the four sources, or the two older markers. */
export type SavedPaletteFrom = PaletteSource | "brief" | "designer";

export const PALETTE_SOURCE_LABELS: Record<PaletteSource, { title: string; note: string }> = {
  brand: {
    title: "Client's brand colours",
    note: "The colours saved in the brand kit, every month the same.",
  },
  grid: {
    title: "The followed grid's colours",
    note: "Read from the grid picture the month follows: its backgrounds and lettering.",
  },
  both: { title: "Both", note: "The brand colours first, then the grid's, each colour once." },
  manual: { title: "Set by you", note: "Colours you pick for this month only." },
};

const HEX = /#([0-9a-f]{6})\b/gi;

/** Each colour once (by hex, lowercased), valid 6-digit hexes only, at most eight. */
export function dedupeColours(list: readonly (Colour | null | undefined)[], max = 8): Colour[] {
  const seen = new Set<string>();
  const out: Colour[] = [];
  for (const c of list) {
    const hex = (c?.hex ?? "").trim().toLowerCase();
    if (!/^#[0-9a-f]{6}$/.test(hex) || seen.has(hex)) continue;
    seen.add(hex);
    out.push({ name: (c?.name ?? "").trim().slice(0, 40) || colourName(hex) || hex, hex });
    if (out.length >= max) break;
  }
  return out;
}

/** "cream #f3ece0" → "Cream"; "deep blue #0042aa background" → "Deep blue"; no words → the hex's own name. */
function nameBefore(text: string, hex: string): string {
  const at = text.toLowerCase().indexOf(hex);
  const before = at >= 0 ? text.slice(0, at) : "";
  const words = before
    .replace(/[^a-z\s-]/gi, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(-2)
    .filter((w) => !/^(a|an|the|of|on|in|with|and|plain|background|tile|tiles|is|are)$/i.test(w));
  const name = words.join(" ");
  return name ? name.charAt(0).toUpperCase() + name.slice(1) : colourName(hex) || hex;
}

/**
 * The colours of a read grid: every #rrggbb the reading wrote for a tile's plain background or its
 * lettering, then the ones in its world paragraph, each once. Backgrounds come first (the first
 * colour is a post's background), text colours after. Empty when the grid was not read, or its
 * reading named no colour.
 */
export function gridColours(
  tiles: readonly { background?: string; colour?: string }[] | null | undefined,
  world = "",
): Colour[] {
  const found: Colour[] = [];
  const take = (text: string | undefined) => {
    for (const m of (text ?? "").matchAll(HEX))
      found.push({ name: nameBefore(text ?? "", m[0].toLowerCase()), hex: m[0].toLowerCase() });
  };
  for (const t of tiles ?? []) take(t.background);
  for (const t of tiles ?? []) take(t.colour);
  take(world);
  return dedupeColours(found);
}

/**
 * The source a month starts on: the client's brand colours; when the brand kit has none and the
 * month follows a grid, the grid's.
 */
export function defaultPaletteSource(
  brand: readonly Colour[],
  gridFollowed: boolean,
): PaletteSource {
  return brand.length ? "brand" : gridFollowed ? "grid" : "brand";
}

export interface SavedPalette {
  palette?: Colour[];
  paletteFrom?: SavedPaletteFrom | string;
}

/**
 * How a saved month reads: the source it chose, "theme" for a month saved before sources existed
 * whose colours came from its theme (nothing saved on the month, a theme palette present), or null
 * when nothing was chosen yet (the default applies). "brief" and "designer" are older markers for
 * colours set on the month by hand or by the planner: they read as "manual".
 */
export function savedPaletteSource(
  config: SavedPalette | null | undefined,
  themePalette: readonly Colour[] | null | undefined,
): PaletteSource | "theme" | null {
  if (config?.palette?.length) {
    const from = config.paletteFrom;
    if (from === "brand" || from === "grid" || from === "both" || from === "manual") return from;
    return "manual";
  }
  return themePalette?.length ? "theme" : null;
}

/** "from the brief", "set by you", "from an older theme"…: the words under the swatches. */
export function paletteSourceLine(
  source: PaletteSource | "theme" | null,
  saved?: SavedPalette | null,
): string {
  if (source === "theme")
    return "from an older theme (no longer offered): choose where this month's colours come from";
  if (source === null) return "not chosen yet";
  if (source === "manual")
    return saved?.paletteFrom === "brief" ? "set by the brief" : "set by you";
  if (source === "brand") return "the client's brand colours";
  if (source === "grid") return "the followed grid's colours";
  return "the brand colours, then the grid's";
}

export interface ResolveInput {
  source: PaletteSource;
  brand: readonly Colour[];
  /** The grid's colours, or null when the month follows a grid that has not been read yet. */
  grid: readonly Colour[] | null;
  /** The colours set by hand (the month's saved palette). */
  manual: readonly Colour[];
  gridFollowed: boolean;
}

export interface Resolved {
  palette: Colour[];
  /** The month follows a grid that has no reading yet, and the source asks for the grid's colours. */
  needsGridRead: boolean;
  /** Why the palette is empty or short, in a line for the designer; "" when nothing needs saying. */
  warning: string;
}

/** The colours a source gives, with what is missing for it. */
export function resolvePalette(i: ResolveInput): Resolved {
  const gridWanted = i.source === "grid" || i.source === "both";
  const needsGridRead = gridWanted && i.gridFollowed && i.grid === null;
  const grid = i.grid ?? [];
  let palette: Colour[];
  switch (i.source) {
    case "brand":
      palette = dedupeColours(i.brand);
      break;
    case "grid":
      palette = dedupeColours(grid);
      break;
    case "both":
      palette = dedupeColours([...i.brand, ...grid]);
      break;
    default:
      palette = dedupeColours(i.manual);
  }
  let warning = "";
  if (i.source === "brand" && !i.brand.length)
    warning = "The brand kit has no colours yet: add them there, or choose another source.";
  else if (gridWanted && !i.gridFollowed)
    warning = "This month follows no grid: pick one on Start, or choose another source.";
  else if (needsGridRead) warning = "Read the grid first: its colours come from the reading.";
  else if (gridWanted && !grid.length)
    warning =
      i.source === "both" && i.brand.length
        ? "The grid's reading named no colours: the brand colours stand alone."
        : "The grid's reading named no colours. Read it again, or choose another source.";
  else if (i.source === "manual" && !i.manual.length)
    warning = "No colours set yet: edit them below.";
  return { palette, needsGridRead, warning };
}
