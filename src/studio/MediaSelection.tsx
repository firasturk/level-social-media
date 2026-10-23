/**
 * Choosing Studio cards for one explicit step (docs/direct-to-studio.md): the bar over the cards
 * while cards are chosen, and the "Combine into one video" dialog. Every step here says what it
 * touches before it runs; nothing paid starts from a selection: a style is saved on the chosen
 * cards, and each picture is then restyled on its own card, confirmed with its cost.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ArrowDown, ArrowUp, Clapperboard, Combine, Palette, Type, X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Orb } from "@/components/Orb";
import type { StyleItem } from "@shared/styles";
import { combineCards, type CombineAnswer } from "./mediaApi";
import { STILL_SECONDS, stillToClip } from "./stillClip";
import "./media-intake.css";

const nn = (n: number) => String(n).padStart(2, "0");

/** The bar over the cards while cards are chosen: the count and the scoped steps. */
export function SelectionBar({
  count,
  route,
  admin,
  textable,
  onStyle,
  onText,
  onCombine,
  onClear,
  onDone,
}: {
  count: number;
  /** The route the cards just came from, when they did: it decides which step comes first. */
  route: "images" | "video" | null;
  admin: boolean;
  /** How many chosen cards have words that can be set (the Text studio opens on those). */
  textable: number;
  onStyle: () => void;
  onText: () => void;
  onCombine: () => void;
  onClear: () => void;
  onDone: () => void;
}) {
  const combine = (
    <button type="button" className={`cta ${route === "video" ? "primary" : "secondary"} small`} disabled={count < 2 || !admin} onClick={onCombine} title={!admin ? "Admins only for now (the Video editor's rule)" : count < 2 ? "Choose at least two cards" : `Opens the Video editor with these ${count} cards in order, as one project; nothing is generated`}>
      <Combine size={14} /> Combine into one video
    </button>
  );
  return (
    <div className="studio-select-bar" role="region" aria-label="Chosen cards">
      <b>
        {count} card{count === 1 ? "" : "s"} chosen
      </b>
      <span className="flow-muted">{count ? "Each step below works on these cards only and asks before anything is paid." : "Tick the cards to work on together."}</span>
      {route === "video" && combine}
      <button type="button" className={`cta ${route === "video" ? "secondary" : "primary"} small`} disabled={!count} onClick={onStyle} title="Saves a gallery style on these cards; restyling each picture is a separate step you confirm on its card, with its cost">
        <Palette size={14} /> Apply a style to {count || "the"} chosen
      </button>
      <button type="button" className="cta secondary small" disabled={!textable} onClick={onText} title="Opens the Text studio on these cards one by one; no picture is made">
        <Type size={14} /> Open in Text studio{textable > 1 ? ` (1 of ${textable})` : ""}
      </button>
      {route !== "video" && combine}
      <button type="button" className="text-button" onClick={onClear} disabled={!count}>
        Clear
      </button>
      <button type="button" className="cta secondary small icon" aria-label="Stop choosing cards" title="Stop choosing cards" onClick={onDone}>
        <X size={14} />
      </button>
    </div>
  );
}

export interface CombineCard {
  index: number;
  title: string;
  /** The card's picture (thumbnail) and its full picture (rendered as a clip when the card has none). */
  thumb: string | null;
  picture: string | null;
  hasClip: boolean;
}

/**
 * The chosen cards in the order they play, the card the project goes on (a new card, or one of
 * them), then the Video editor opens on it with exactly those clips. A picture card joins as a
 * short clip drawn in this browser. Nothing is generated or paid.
 */
export function CombineDialog({ open, batchId, cards, onClose, onCombined }: { open: boolean; batchId: string; cards: CombineCard[]; onClose: () => void; onCombined: (a: CombineAnswer) => void | Promise<void> }) {
  const [order, setOrder] = useState<CombineCard[]>(cards);
  const [target, setTarget] = useState<"new" | number>("new");
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setOrder(cards);
    setTarget("new");
    setBusy(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  const move = (i: number, d: -1 | 1) =>
    setOrder((o) => {
      const j = i + d;
      if (j < 0 || j >= o.length) return o;
      const next = [...o];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const stills = order.filter((c) => !c.hasClip).length;
  async function go() {
    setBusy("Getting the clips ready…");
    try {
      const items: { post: number; still?: File }[] = [];
      for (const [i, c] of order.entries()) {
        if (c.hasClip) items.push({ post: c.index });
        else {
          if (!c.picture) throw new Error(`Post ${c.index} has no picture yet.`);
          setBusy(`Drawing post ${nn(c.index)}'s picture as a ${STILL_SECONDS}-second clip (${i + 1} of ${order.length})…`);
          items.push({ post: c.index, still: await stillToClip(c.picture, `post-${nn(c.index)}`) });
        }
      }
      setBusy("Saving the project…");
      const a = await combineCards(batchId, target, items);
      toast.success(`One video project with ${order.length} clips on ${a.created ? "a new card" : `post ${nn(a.target)}`}. Opening the Video editor.`);
      await onCombined(a);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="media-dialog combine-dialog">
        <DialogHeader>
          <DialogTitle className="media-title">
            <Clapperboard size={18} /> Combine into one video
          </DialogTitle>
          <DialogDescription>
            These {order.length} cards, in this order, become one project in the Video editor. {stills ? `${stills} picture${stills === 1 ? "" : "s"} join${stills === 1 ? "s" : ""} as ${STILL_SECONDS}-second clips drawn in this browser. ` : ""}No video is generated and nothing is paid; the cards themselves stay as they are.
          </DialogDescription>
        </DialogHeader>
        <ol className="combine-list">
          {order.map((c, i) => (
            <li key={c.index}>
              <span className="combine-n">{i + 1}</span>
              {c.thumb ? <img src={c.thumb} alt="" /> : <span />}
              <span>
                <b>
                  Post {nn(c.index)} · {c.title}
                </b>
                <br />
                <small className="flow-muted">{c.hasClip ? "Its clip" : `Its picture, as a ${STILL_SECONDS}-second clip`}</small>
              </span>
              <span className="combine-moves">
                <button type="button" className="cta secondary small icon" aria-label={`Move post ${c.index} up`} disabled={i === 0 || !!busy} onClick={() => move(i, -1)}>
                  <ArrowUp size={14} />
                </button>
                <button type="button" className="cta secondary small icon" aria-label={`Move post ${c.index} down`} disabled={i === order.length - 1 || !!busy} onClick={() => move(i, 1)}>
                  <ArrowDown size={14} />
                </button>
              </span>
            </li>
          ))}
        </ol>
        <label className="combine-target">
          <b>Save the project on</b>
          <select value={String(target)} onChange={(e) => setTarget(e.target.value === "new" ? "new" : Number(e.target.value))} disabled={!!busy}>
            <option value="new">A new card (its picture: the first card's)</option>
            {order.map((c) => (
              <option key={c.index} value={c.index}>
                Post {nn(c.index)} · {c.title}
              </option>
            ))}
          </select>
        </label>
        <footer className="media-foot">
          <small className="flow-muted">The export, music and cuts are done in the Video editor; Generate there stays a separate step with its cost.</small>
          <button type="button" className="cta secondary" onClick={onClose} disabled={!!busy}>
            Cancel
          </button>
          <button type="button" className="cta primary" onClick={() => void go()} disabled={!!busy || order.length < 2}>
            {busy ? <Orb size={15} /> : <Combine size={16} />} {busy ?? `Combine ${order.length} and open the editor`}
          </button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

/** The edit asked of the engine when a card's picture is restyled in a gallery style (one picture, confirmed on its card). */
export function restyleInstruction(style: Pick<StyleItem, "title" | "tags" | "prompt">): string {
  const look = (style.prompt ?? "").replace(/\s+/g, " ").trim().slice(0, 900);
  return `Restyle this picture in the look of the gallery style “${style.title}”${style.tags ? ` (${style.tags})` : ""}${look ? `: ${look}` : ""}. Change only the light, the colours, the mood and the finish. Keep the subject, the composition, every product, person, logo and word exactly as they are.`.slice(0, 2900);
}
