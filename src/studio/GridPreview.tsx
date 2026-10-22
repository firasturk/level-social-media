/**
 * A library grid before it is applied: its picture with the tiles marked on it, the real post
 * count and what each tile is (from the grid's read), what the month would get from it, and the
 * choice to make when the month asks for a different number of posts than the grid has tiles.
 * Nothing here applies anything: the Start board's Continue does, after its confirm.
 */
import { Grid3x3, RefreshCw, TriangleAlert } from "lucide-react";
import type { StyleItem } from "@shared/styles";
import { gridMismatch, gridMonth, TILE_KIND_LABEL, type GridTilePreview } from "@shared/grid-preview";
import { styleThumb } from "./StyleGallery";
import Working from "@/components/Working";

/** What /api/studio/styles/:id/grid answers: the summary, and the tiles one by one once read. */
export interface GridInfo {
  read: boolean;
  tiles: number;
  kinds: { kind: string; n: number }[];
  textTiles: number;
  layout: string;
  world: string;
  tileList?: GridTilePreview[];
  rows?: number;
  cols?: number;
}

const KIND_LABEL: Record<string, string> = { product: "product", drink: "drink", food: "food", place: "place", person: "person", text: "text tile", texture: "texture", detail: "detail", picture: "picture" };
export const kindsLine = (g: Pick<GridInfo, "kinds">) => g.kinds.map((k) => `${k.n} ${KIND_LABEL[k.kind] ?? k.kind}${k.n === 1 ? "" : "s"}`).join(" · ");

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface GridPreviewProps {
  grid: StyleItem;
  info: GridInfo | null;
  /** The grid is being read tile by tile (one vision call), so the preview can show its contents. */
  analysing: boolean;
  analyseError: string | null;
  onAnalyse: () => void;
  /** The posts the month asks for, and the count chosen when it differs from the grid's tiles. */
  requested: number;
  choice: number | null;
  onChoice: (n: number) => void;
  /** Picked but not applied yet, or the grid the month already follows. */
  pending: boolean;
  onChange: () => void;
  /** The grid follows a brief this month (its words and products), told on the preview. */
  withBrief?: boolean;
}

export default function GridPreview(p: GridPreviewProps) {
  const tiles = p.info?.tileList ?? [];
  const count = p.info?.tiles || p.grid.tiles || 0;
  const read = !!p.info?.read && tiles.length > 0;
  const mismatch = count ? gridMismatch(read ? tiles : count, p.requested) : null;
  const chosen = mismatch ? (p.choice ?? null) : count;
  const month = count ? gridMonth(read ? tiles : count, chosen ?? count) : null;
  const rows = p.info?.rows || 0;
  const cols = p.info?.cols || 0;
  return (
    <div className="grid-preview" role="region" aria-label={`Grid preview: ${p.grid.title}`}>
      <div className="grid-preview-top">
        <figure className={`grid-preview-picture ${rows && cols ? "has-tiles" : ""}`}>
          <img src={styleThumb(p.grid, true)} alt={`The grid ${p.grid.title}`} />
          {rows > 0 && cols > 0 && (
            <ol className="grid-preview-cells" style={{ gridTemplateRows: `repeat(${rows}, 1fr)`, gridTemplateColumns: `repeat(${cols}, 1fr)` }} aria-hidden>
              {Array.from({ length: rows * cols }, (_, i) => {
                const t = tiles.find((x) => x.row === Math.floor(i / cols) + 1 && x.col === (i % cols) + 1);
                const dropped = !!t && !!mismatch && chosen !== null && chosen < count && t.n > chosen;
                const again = !!t && !!mismatch && chosen !== null && chosen > count && mismatch.repeated.includes(t.n);
                return (
                  <li key={i} className={`${t?.free ? "free" : ""} ${dropped ? "dropped" : ""} ${again ? "again" : ""}`}>
                    {t ? <span>{t.n}{again ? " ×2" : ""}</span> : null}
                  </li>
                );
              })}
            </ol>
          )}
        </figure>
        <div className="grid-preview-side">
          <b className="grid-preview-title">{p.grid.title}</b>
          {count ? (
            <div className="grid-preview-numbers">
              <span>
                <b>{count}</b> post{count === 1 ? "" : "s"} in the grid
              </span>
              {month && (
                <>
                  <span>
                    <b>{month.designs}</b> design{month.designs === 1 ? "" : "s"}, all single pictures
                  </span>
                  <span>
                    <b>{month.images}</b> image{month.images === 1 ? "" : "s"} to generate{month.tiles ? ` · ${plural(month.tiles, "text tile")} drawn here, free` : ""}
                  </span>
                </>
              )}
            </div>
          ) : (
            <span className="flow-muted">Its post count is read from its tiles below.</span>
          )}
          {p.info?.layout ? <span className="flow-muted">{p.info.layout}</span> : null}
          {read && <span className="flow-muted">{kindsLine(p.info!)}</span>}
          <span className="flow-muted">Carousels and separators come from your brief; a grid plans one picture per tile, in the grid's order{p.withBrief ? ", with your brief's words and products on them" : ""}.</span>
          <span className={`flow-pill ${p.pending ? "" : "ok"}`}>{p.pending ? "Picked · not applied yet" : "The month follows this grid"}</span>
          <button type="button" className="cta secondary small" onClick={p.onChange}>
            <Grid3x3 size={14} /> Change grid
          </button>
        </div>
      </div>

      {p.analysing && (
        <div className="grid-preview-analysing">
          <Working label="Analysing the grid…" />
          <span className="flow-muted">Reading its tiles one by one: what each shows, which are text tiles, and where the words sit. One text call; the read is kept for next time.</span>
        </div>
      )}
      {!p.analysing && !read && (
        <div className="grid-preview-analysing">
          <span className="flow-muted">
            <TriangleAlert size={13} /> {p.analyseError ? `The grid could not be analysed: ${p.analyseError}` : "Not analysed yet."} {count ? `What is known: ${plural(count, "tile")}, one post each.` : "Its tile count is not known yet."}
          </span>
          <button type="button" className="text-button" onClick={p.onAnalyse}>
            <RefreshCw size={13} /> {p.analyseError ? "Try again" : "Analyse the grid"}
          </button>
        </div>
      )}
      {read && (
        <details className="grid-preview-tiles" open={tiles.length <= 12}>
          <summary>The {plural(tiles.length, "tile")}, one post each</summary>
          <ol>
            {tiles.map((t) => {
              const dropped = mismatch && chosen !== null && chosen < count && t.n > chosen;
              const again = mismatch && chosen !== null && chosen > count && mismatch.repeated.includes(t.n);
              return (
                <li key={t.n} className={`${t.free ? "free" : ""} ${dropped ? "dropped" : ""}`}>
                  <span className="grid-tile-n">{t.n}</span>
                  <span className="grid-tile-kind">{TILE_KIND_LABEL[t.kind]}</span>
                  <span className="grid-tile-text">
                    <b>{t.purpose || `${TILE_KIND_LABEL[t.kind]} tile`}</b>
                    <small className="flow-muted">
                      {t.position}
                      {t.background ? ` · ${t.background}` : ""} · {t.words}
                      {t.free ? " · drawn here, free" : ""}
                      {dropped ? " · no post at this count" : again ? ` · used twice (post ${t.n} and post ${count + mismatch!.repeated.indexOf(t.n) + 1})` : ""}
                    </small>
                  </span>
                </li>
              );
            })}
          </ol>
          {p.info?.world ? <p className="flow-muted">{p.info.world}</p> : null}
        </details>
      )}

      {mismatch && (
        <div className="grid-mismatch" role="radiogroup" aria-label="Post count">
          <span className="flow-eyebrow">
            The grid has {plural(mismatch.grid, "post")}; the month asks for {mismatch.requested}
          </span>
          <div className="grid-mismatch-options">
            <button type="button" role="radio" aria-checked={chosen === mismatch.grid} className={`grid-mismatch-option ${chosen === mismatch.grid ? "on" : ""}`} onClick={() => p.onChoice(mismatch.grid)}>
              <b>Use the grid's {plural(mismatch.grid, "post")}</b>
              <span>{mismatch.useGrid}</span>
            </button>
            <button type="button" role="radio" aria-checked={chosen === mismatch.requested} className={`grid-mismatch-option ${chosen === mismatch.requested ? "on" : ""}`} onClick={() => p.onChoice(mismatch.requested)}>
              <b>Adapt to my {plural(mismatch.requested, "post")}</b>
              <span>{mismatch.adapt}</span>
            </button>
          </div>
          {chosen === null && <small className="flow-muted">Choose one before continuing; nothing is applied until you confirm on Continue.</small>}
        </div>
      )}
    </div>
  );
}
