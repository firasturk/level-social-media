/**
 * The month's occasions in the Studio's side panel: the days the brand greets (national, religious,
 * its own), each one a greeting post on its day, and the official portrait a royal day frames.
 * The planner, the Plan's "Occasions" line and the checks read what is ticked here
 * (config.occasions). Moved here from the retired journey's "Posts" screen, unchanged.
 */
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, ImagePlus, Plus } from "lucide-react";
import { Orb } from "@/components/Orb";
import { post, postForm } from "@/api";
import type { Config } from "@shared/config";
import { occasionsOf, pickedOccasions, shortDate, spreadDates, type MonthOccasions as Selection } from "@shared/occasions";
import type { Post } from "@shared/posts";
import { Section } from "./BrandPanel";

export default function MonthOccasions({
  month,
  plan,
  count,
  config,
  batchId,
  onOccasions,
  refresh,
}: {
  month: string;
  plan: Post[];
  count: number;
  config: Config | null;
  batchId: string;
  onOccasions: (o: { picked: string[]; custom: NonNullable<Selection["custom"]> }) => void;
  refresh: () => Promise<unknown>;
}) {
  const [y, m] = month.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const offset = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 1) % 7; // weeks start on Saturday
  // Ticks show at once; the saved month catches up a moment later.
  const saved = config?.occasions;
  const savedKey = JSON.stringify([saved?.picked ?? [], saved?.custom ?? [], saved?.photos ?? {}]);
  const [sel, setSel] = useState<Selection | undefined>(saved);
  useEffect(() => setSel(saved), [savedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const picked = new Set(sel?.picked ?? []);
  const custom = (sel?.custom ?? []).filter((c) => c.date.startsWith(`${month}-`));
  const calendar = occasionsOf(month);
  const all = [
    ...calendar,
    ...custom.map((c) => ({ id: c.id, date: c.date, name: c.name, ar: "", category: "commercial" as const, elements: c.elements ?? "", portrait: false, major: false })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  const chosen = all.filter((o) => picked.has(o.id) || o.id.startsWith("c-"));
  const planned = plan.length && plan.every((x) => x.date) ? plan.map((x) => x.date!) : spreadDates(month, count);
  const postsOn = (d: string) => planned.filter((x) => x === d).length;
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ date: `${month}-01`, name: "" });
  const [uploading, setUploading] = useState("");
  const photoInput = useRef<HTMLInputElement>(null);
  const photoFor = useRef("");
  // An occasion ticked after the ideas were written has no greeting post yet: one button writes only that post.
  const missing = plan.length ? pickedOccasions(month, saved).filter((o) => !plan.some((x) => x.type === "greeting" && x.occasion === o.id)) : [];
  const [writing, setWriting] = useState(false);

  const change = (next: { picked?: string[]; custom?: Selection["custom"] }) => {
    setSel((s0) => ({ ...(s0 ?? {}), ...next }));
    onOccasions({ picked: next.picked ?? sel?.picked ?? [], custom: next.custom ?? sel?.custom ?? [] });
  };
  const toggle = (id: string) => change({ picked: picked.has(id) ? [...picked].filter((x) => x !== id) : [...picked, id] });
  const addCustom = () => {
    if (!draft.name.trim() || !draft.date.startsWith(`${month}-`)) return;
    const id = `c-${Date.now().toString(36)}`;
    change({ custom: [...(sel?.custom ?? []), { id, date: draft.date, name: draft.name.trim() }] });
    setDraft({ date: draft.date, name: "" });
    setAdding(false);
  };
  const removeCustom = (id: string) => change({ custom: (sel?.custom ?? []).filter((c) => c.id !== id) });
  async function uploadPortrait(file: File | undefined) {
    const id = photoFor.current;
    if (!file || !id) return;
    setUploading(id);
    try {
      const form = new FormData();
      form.append("file", file);
      await postForm(`/api/studio/posts/occasion-photo?batch=${encodeURIComponent(batchId)}&occasion=${encodeURIComponent(id)}`, form);
      await refresh();
      toast.success("Official portrait added. It is framed on the greeting post exactly as uploaded.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading("");
      if (photoInput.current) photoInput.current.value = "";
    }
  }
  async function addGreetings() {
    setWriting(true);
    try {
      const r = await post<{ added: string[] }>("/api/studio/posts/occasion-posts", { batch: batchId });
      await refresh();
      if (r.added.length) toast.success(`Greeting post added for ${r.added.join(", ")}.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setWriting(false);
    }
  }

  return (
    <Section
      title="Occasions"
      subtitle={chosen.length ? `${chosen.length} this month: ${chosen.map((o) => o.name).join(", ")}` : "None ticked this month"}
      defaultOpen={false}
      actions={
        <button type="button" className="text-button occ-add-button" onClick={() => setAdding((v) => !v)}>
          <Plus size={13} /> Add occasion
        </button>
      }
    >
      <div className="journey-cal compact">
        {["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"].map((d) => (
          <small key={d}>{d}</small>
        ))}
        {Array.from({ length: offset }, (_, i) => (
          <span key={`e${i}`} />
        ))}
        {Array.from({ length: days }, (_, i) => {
          const date = `${month}-${String(i + 1).padStart(2, "0")}`;
          const occ = chosen.filter((o) => o.date === date);
          const n = postsOn(date);
          return (
            <span key={date} style={{ "--i": i } as React.CSSProperties} className={`cal-day ${n ? "post" : ""} ${occ.length ? "occasion" : ""}`} title={occ.map((o) => o.name).join("\n")}>
              {i + 1}
              {n > 0 && <i />}
            </span>
          );
        })}
      </div>
      {adding && (
        <div className="occ-add">
          <input type="date" value={draft.date} min={`${month}-01`} max={`${month}-${String(days).padStart(2, "0")}`} onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))} />
          <input dir="auto" value={draft.name} placeholder="Occasion (a branch opening, the brand's anniversary…)" onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} onKeyDown={(e) => e.key === "Enter" && addCustom()} />
          <button type="button" className="secondary" onClick={addCustom} disabled={!draft.name.trim()}>
            Add
          </button>
        </div>
      )}
      <p className="field-hint">Occasions are optional: tick the ones the brand greets this month. Each one becomes a greeting post on its day when the plan is written.</p>
      {missing.length > 0 && (
        <p className="field-hint">
          No greeting post yet for {missing.map((o) => o.name).join(", ")}.{" "}
          <button type="button" className="text-button" disabled={writing} onClick={() => void addGreetings()} title="Writes only the missing greeting posts; the rest of the month stays as it is">
            {writing ? <Orb size={12} /> : <Plus size={12} />} Add the greeting post
          </button>
        </p>
      )}
      <ul className="occ-list">
        {all.map((o) => {
          const on = picked.has(o.id) || o.id.startsWith("c-");
          const hasPhoto = !!sel?.photos?.[o.id];
          return (
            <li key={o.id} className={`occ ${on ? "on" : ""} ${o.major && !on ? "warn" : ""}`}>
              <label>
                <input type="checkbox" checked={on} onChange={() => (o.id.startsWith("c-") ? removeCustom(o.id) : toggle(o.id))} />
                <span className="occ-date">{shortDate(o.date)}</span>
                <span className="occ-name">
                  {o.name}
                  {o.ar && <small dir="rtl">{o.ar}</small>}
                </span>
                <span className={`journey-tag occ-${o.category}`}>{o.id.startsWith("c-") ? "yours" : o.category}</span>
              </label>
              {o.major && !on && <em className="occ-warning">Big day without a post</em>}
              {on && o.portrait && (
                <button
                  type="button"
                  className={`text-button occ-photo ${hasPhoto ? "done" : ""}`}
                  disabled={!!uploading}
                  onClick={() => {
                    photoFor.current = o.id;
                    photoInput.current?.click();
                  }}
                  title="Upload the official portrait: it is framed on the post exactly as it is, never redrawn"
                >
                  {uploading === o.id ? <Orb size={12} /> : hasPhoto ? <Check size={12} /> : <ImagePlus size={12} />}
                  {hasPhoto ? "Portrait added" : "Official portrait"}
                </button>
              )}
            </li>
          );
        })}
        {!all.length && <li className="field-hint">No occasions this month. Add your own with "Add occasion".</li>}
      </ul>
      <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => void uploadPortrait(e.target.files?.[0])} />
    </Section>
  );
}
