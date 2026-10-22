/**
 * The campaign's size on the Start board: three numbers that are always told apart (posts,
 * designs, images still to generate), the shape behind them (single pictures, carousels of N
 * slides, separators), and the format. Editable; on a month that already has posts the saved plan
 * is what the numbers show, and a bigger size only ever adds posts after an explicit confirm.
 * Nothing here removes or rewrites a post.
 */
import { useEffect, useState } from "react";
import { Check, ImagePlus, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { askConfirm } from "@/lib/confirm";
import { Orb } from "@/components/Orb";
import { FORMAT_INFO, FORMATS, MAX_POST_COUNT, type Format, type Post } from "@shared/posts";
import { MAX_SLIDES, monthNumbers, normalizeSize, sizeChange, sizeCounts, sizeLine, sizeOfPlan, type CampaignSize } from "@shared/campaign-size";

export interface CampaignSizeCardProps {
  plan: Post[];
  /** Posts whose picture exists already (by post index). */
  made: number[];
  size: CampaignSize;
  format: Format;
  /** Saves the size and format on the month (or keeps them for the month created next). */
  onSave: (size: CampaignSize, format: Format) => Promise<void>;
  /** N more posts written in the month's world; the current posts untouched. */
  onAddPosts: (n: number) => Promise<void>;
  onOpenPlan: () => void;
  /** The way picked on Start follows a grid: its tile count sets the posts, said here. */
  gridPosts?: number | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export default function CampaignSizeCard(p: CampaignSizeCardProps) {
  const saved = p.plan.length ? sizeOfPlan(p.plan) : p.size;
  const numbers = monthNumbers(p.plan, p.size, p.made);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<CampaignSize>(saved);
  const [format, setFormat] = useState<Format>(p.format);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!editing) {
      setDraft(saved);
      setFormat(p.format);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, p.format, JSON.stringify(saved)]);
  const counts = sizeCounts(draft);
  const change = sizeChange(p.plan, draft);
  const set = (patch: Partial<CampaignSize>) => setDraft((d) => normalizeSize({ ...d, ...patch }));
  const field = (label: string, key: keyof CampaignSize, min: number, max: number, hint?: string) => (
    <label className="size-field">
      <span>{label}</span>
      <input type="number" min={min} max={max} value={draft[key]} onChange={(e) => set({ [key]: Number(e.target.value) })} aria-label={label} />
      {hint ? <small className="flow-muted">{hint}</small> : null}
    </label>
  );

  async function save() {
    setBusy(true);
    try {
      if (!p.plan.length) {
        await p.onSave(normalizeSize(draft), format);
        toast.success(`Size set: ${sizeLine(draft, format)}. The plan is written to it.`);
        setEditing(false);
        return;
      }
      if (change?.kind === "fewer") {
        toast.message(change.text, { duration: 9000 });
        return;
      }
      // The saved posts keep their shape; the size applies to the posts added and to the next request.
      // On a planned month the month's count is its designs (what the planner wrote), as the rest of the studio keeps it.
      const shape = normalizeSize({ ...draft, posts: p.plan.length });
      await p.onSave(shape, format);
      if (change?.kind === "add") {
        const ok = await askConfirm(`${change.text} Each new post is written as an idea in the month's world; its picture is made from the Plan, where the cost is shown first.`, { ok: `Add ${plural(change.count, "post")}`, danger: false, cancel: "Keep the month as it is" });
        if (!ok) return;
        await p.onAddPosts(change.count);
      } else toast.success(`Saved: the next posts follow ${sizeLine(shape, format)}; the ${plural(numbers.posts, "saved post")} stay as they are.`);
      setEditing(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="journey-box flow-box size-card" aria-label="Campaign size">
      <div className="flow-row-head">
        <span className="flow-eyebrow">{numbers.from === "plan" ? "Saved plan" : "Campaign size"}</span>
        {!editing && (
          <button type="button" className="text-button" onClick={() => setEditing(true)}>
            <Settings2 size={13} /> {numbers.from === "plan" ? "Change the size" : "Edit size"}
          </button>
        )}
      </div>
      <div className="flow-big size-numbers">
        <span>
          <b>{numbers.posts}</b> post{numbers.posts === 1 ? "" : "s"}
        </span>
        <span>
          <b>{numbers.designs}</b> design{numbers.designs === 1 ? "" : "s"}
        </span>
        <span>
          <b>{numbers.images}</b> image{numbers.images === 1 ? "" : "s"} still to generate
        </span>
      </div>
      <small className="flow-muted">
        {numbers.from === "plan"
          ? `${sizeLine(saved, p.format)}${numbers.tiles ? ` · ${plural(numbers.tiles, "text tile")} drawn here, free` : ""}${numbers.made ? ` · ${plural(numbers.made, "picture")} made already` : ""}. `
          : `${sizeLine(p.size, p.format)}. ${p.gridPosts ? `The grid you picked has ${plural(p.gridPosts, "tile")}: it sets the posts when applied.` : "Nothing is planned yet: the plan is written to this size on the next screens."} `}
        {numbers.from === "plan" && (
          <button type="button" className="text-button" onClick={p.onOpenPlan}>
            Open the plan
          </button>
        )}
      </small>
      {editing && (
        <div className="size-edit">
          <div className="size-fields">
            {field("Posts", "posts", 1, MAX_POST_COUNT, "A carousel or a separator counts once")}
            {field("Carousels", "carousels", 0, draft.posts, `of the ${draft.posts}`)}
            {field("Slides per carousel", "slidesPerCarousel", 2, MAX_SLIDES)}
            {field("Separators", "separators", 0, draft.posts - draft.carousels, "calm posts between the others")}
            {field("Designs per separator", "slidesPerSeparator", 1, MAX_SLIDES, "1 = one post; more = a series")}
            <label className="size-field">
              <span>Format</span>
              <select value={format} onChange={(e) => setFormat(e.target.value as Format)} aria-label="Format">
                {FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {FORMAT_INFO[f].label} · {f} · {FORMAT_INFO[f].pixels}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="flow-note">
            <b>
              {counts.posts} post{counts.posts === 1 ? "" : "s"} · {counts.designs} design{counts.designs === 1 ? "" : "s"} · {p.plan.length ? Math.max(0, counts.designs - numbers.made) : counts.designs} image{counts.designs === 1 ? "" : "s"} to generate
            </b>{" "}
            · {counts.singles} single, {counts.carousels} carousel{counts.carousels === 1 ? "" : "s"} × {draft.slidesPerCarousel}, {counts.separators} separator{counts.separators === 1 ? "" : "s"}
            {draft.slidesPerSeparator > 1 ? ` × ${draft.slidesPerSeparator}` : ""} · {format}
          </p>
          {p.plan.length > 0 && (
            <p className="flow-muted">
              {change?.kind === "add" ? change.text : change?.kind === "fewer" ? change.text : `The ${plural(numbers.posts, "saved post")} keep their shape and pictures; the size applies to posts you add and to a new request. The format applies to pictures made from now on.`}
            </p>
          )}
          <div className="flow-pick-row">
            <button type="button" className="cta primary small" disabled={busy || change?.kind === "fewer"} onClick={() => void save()}>
              {busy ? <Orb size={13} /> : change?.kind === "add" ? <ImagePlus size={14} /> : <Check size={14} />} {change?.kind === "add" ? `Save and add ${plural(change.count, "post")}` : "Save size"}
            </button>
            <button type="button" className="text-button" disabled={busy} onClick={() => setEditing(false)}>
              Keep as it is
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
