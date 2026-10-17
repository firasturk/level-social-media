/**
 * Autopilot: the admin's one button that walks the whole journey for a client. Its own decisions
 * are written here: which grid from the library the month follows.
 */

export interface GridCandidate {
  id: string;
  title: string;
  tags: string;
  /** The grid's reading: its colours, light, tiles. */
  about: string;
  tiles: number;
  /** Suggested for this client by its Analysis. */
  forClient: boolean;
}

export const GRID_PICK_SCHEMA = {
  type: "object",
  properties: {
    grid: { type: "integer" },
    reason: { type: "string" },
  },
  required: ["grid", "reason"],
};

export function gridPickInstruction(r: {
  client: string;
  profile: string;
  brand: string;
  products: string[];
  places: string;
  count: number;
  grids: GridCandidate[];
}): string {
  return [
    `You are the art director of a social media studio in Jordan. Pick the ONE feed grid from the library that the brand "${r.client}" should follow for its next month of ${r.count} Instagram posts.`,
    r.profile ? `What the studio knows of the brand (from its Instagram, website and the brands it is compared with):\n${r.profile}` : "",
    r.brand ? `Its brand kit: ${r.brand}` : "",
    r.products.length ? `What it sells (its photos): ${r.products.slice(0, 40).join(", ")}.` : "",
    r.places ? `Photos of its own spaces: ${r.places}.` : "It has no photos of its own shop: a grid built on interiors fits badly.",
    `THE GRIDS:\n${r.grids
      .map((g, i) => `${i + 1}. "${g.title}"${g.forClient ? " (suggested for this brand by its Analysis)" : ""}, ${g.tiles || "?"} tiles, ${g.tags}: ${g.about.replace(/\s+/g, " ").slice(0, 420)}`)
      .join("\n")}`,
    [
      "Choose the grid that fits best:",
      "- the brand's world: a sweets, food or drinks brand takes a food grid, never a fashion or wellness one;",
      "- colours and mood that sit with the brand's colours and its audience, and that its products look right in;",
      "- tiles it can fill with what it has: product, people and text tiles from its photos, place tiles only when it has photos of its spaces;",
      `- about ${r.count} tiles, or more;`,
      "- a grid suggested by the Analysis is a good sign, not a must.",
    ].join("\n"),
    "Return the grid's number and one short sentence on why, in English.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function parseGridPick(raw: unknown, grids: GridCandidate[]): { grid: GridCandidate; reason: string } | null {
  const x = raw && typeof raw === "object" ? (raw as { grid?: unknown; reason?: unknown }) : {};
  const i = Math.round(Number(x.grid)) - 1;
  const grid = grids[i];
  return grid ? { grid, reason: String(x.reason ?? "").trim().slice(0, 300) } : null;
}
