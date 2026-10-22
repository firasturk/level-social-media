/**
 * Client feedback, read into changes the designer approves one at a time. A composer takes the
 * client's words (pasted, typed or dictated; the dictation lands in the field to be edited before
 * anything is read), then each change shows its original line, the interpreted change, its target
 * (post, slide, picture), its kind and cost, any question or conflict, and Approve / Reject /
 * Apply. Nothing is applied by itself, nothing in bulk; a picture edit confirms its cost first.
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, Play, Trash2, X } from "lucide-react";
import { ApiError, del, get, post, put } from "@/api";
import { askConfirm } from "@/lib/confirm";
import VoiceInput from "@/components/VoiceInput";
import { canApply, kindLabel, type FeedbackAction, type FeedbackItem, type FeedbackKind, type FeedbackSource, type WordsPatch } from "@shared/feedback";
import { formatUsd, rateFor } from "@shared/pricing";
import type { PostOverlayPatch } from "@shared/overlay";
import "./feedback.css";

export interface FeedbackPanelPost {
  index: number;
  title: string;
  headline?: string;
  caption?: string;
  hasPicture: boolean;
  slides?: number;
}

type Item = FeedbackItem & { interpreter?: "rules" | "model" | "demo"; actions: FeedbackAction[] };

const KINDS: FeedbackKind[] = ["layer", "words", "image", "idea", "unclear"];

export default function FeedbackPanel({
  batchId,
  post: postIndex,
  posts,
  onApplied,
  model,
  size,
}: {
  batchId: string;
  /** The post the panel is open on (post level); absent on the month. */
  post?: number;
  posts: FeedbackPanelPost[];
  /** Called after a change was applied, so the plan and the pictures are read again. */
  onApplied: () => Promise<void>;
  /** The month's engine model and size, when known: the panel says what a picture edit costs. */
  model?: string;
  size?: "1K" | "2K" | "4K";
}) {
  const [text, setText] = useState("");
  const [source, setSource] = useState<FeedbackSource>("typed");
  const [items, setItems] = useState<Item[]>([]);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await get<{ feedback: Item[] }>(`/api/studio/feedback?batch=${encodeURIComponent(batchId)}${postIndex ? `&post=${postIndex}` : ""}`);
      setItems(d.feedback);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, [batchId, postIndex]);

  useEffect(() => {
    void load();
  }, [load]);

  const read = async () => {
    if (!text.trim()) return;
    setReading(true);
    try {
      const d = await post<{ feedback: Item; actions: FeedbackAction[]; interpreter: Item["interpreter"] }>("/api/studio/feedback", { batch: batchId, post: postIndex, text: text.trim(), source });
      setItems((list) => [{ ...d.feedback, interpreter: d.interpreter, actions: d.actions }, ...list]);
      setText("");
      setSource("typed");
      const n = d.actions.length;
      toast.success(`${n} change${n === 1 ? "" : "s"} read${d.interpreter === "demo" ? " (demo fixture)" : d.interpreter === "rules" ? " by the rules" : ""}. Approve each one before it is applied.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setReading(false);
    }
  };

  const patchAction = (next: FeedbackAction) => setItems((list) => list.map((f) => (f.id === next.feedback ? { ...f, actions: f.actions.map((a) => (a.id === next.id ? next : a)) } : f)));

  const update = async (a: FeedbackAction, change: Record<string, unknown>) => {
    setBusy(a.id);
    try {
      const d = await put<{ action: FeedbackAction }>(`/api/studio/feedback/actions/${a.id}`, change);
      patchAction(d.action);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const apply = async (a: FeedbackAction, approve = false) => {
    setBusy(a.id);
    try {
      const d = await post<{ action: FeedbackAction; preview?: boolean; note?: string; request?: { body: { note: string } } }>(`/api/studio/feedback/actions/${a.id}/apply`, { approve, run: a.id });
      if (d.preview) {
        toast.message(d.note ?? "This is the preview: no picture is made here.", { description: d.request ? `It would send: "${d.request.body.note}"` : undefined });
        return;
      }
      patchAction(d.action);
      toast.success(d.action.applied?.result ?? "Applied.");
      await onApplied();
    } catch (e) {
      const err = e as ApiError;
      const ask = (err.data ?? {}) as { needsApproval?: boolean; estimate?: number; maximum?: number };
      if (err.status === 409 && ask.needsApproval && !approve) {
        const estimate = formatUsd(ask.estimate ?? 0);
        const most = ask.maximum && ask.maximum > (ask.estimate ?? 0) ? ` At most ${formatUsd(ask.maximum)} with an automatic retake.` : "";
        const ok = await askConfirm(`Edit the picture of post ${a.post}: about ${estimate} (list prices, an estimate).${most} Go ahead?`, { ok: `Go ahead · about ${estimate}`, danger: false, cancel: "Not now" });
        if (ok) await apply(a, true);
        return;
      }
      toast.error(err.message);
    } finally {
      setBusy(null);
    }
  };

  const remove = async (f: Item) => {
    if (!(await askConfirm("Take this feedback and its changes off the month? Nothing already applied is undone.", { ok: "Take it off" }))) return;
    try {
      await del(`/api/studio/feedback/${f.id}`);
      setItems((list) => list.filter((x) => x.id !== f.id));
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const rate = rateFor(model);
  const imageCost = rate ? formatUsd(rate[size ?? "2K"]) : null;

  return (
    <section className="fb" aria-label="Client feedback">
      <div className="fb-composer">
        <textarea
          value={text}
          dir="auto"
          placeholder={postIndex ? `Paste or type the client's feedback on post ${postIndex}…` : "Paste or type the client's feedback on the month: one request per line works best (\"Post 2: bigger logo\", \"remove the cup on post 5\")…"}
          onChange={(e) => {
            setText(e.target.value);
            if (!e.target.value.trim()) setSource("typed");
          }}
          onPaste={() => setSource("pasted")}
          disabled={reading}
        />
        <div className="fb-composer-row">
          <VoiceInput
            label="Dictate"
            disabled={reading}
            onText={(t) => {
              setSource("voice");
              setText((v) => (v.trim() ? `${v.trim()} ${t}` : t));
            }}
          />
          <span className="fb-grow" />
          <button type="button" className="cta primary small" disabled={reading || !text.trim()} onClick={() => void read()}>
            {reading ? "Reading…" : "Read the feedback"}
          </button>
        </div>
        <p className="fb-hint">The feedback is split into changes, each read as a layer edit (free), new words (free), a picture edit (paid, confirmed first) or a new idea. Nothing is applied until you approve and apply it, one at a time.</p>
      </div>

      {!items.length && <p className="fb-empty">No feedback on {postIndex ? `post ${postIndex}` : "this month"} yet.</p>}

      {items.map((f) => (
        <article key={f.id} className="fb-item">
          <div className="fb-item-head">
            <div>
              <p className="fb-original" dir="auto">
                {f.text}
              </p>
              <p className="fb-by">
                {f.by} · {new Date(f.created).toLocaleString()} · {f.source}
                {f.post ? ` · on post ${f.post}` : ""}
                {f.interpreter === "demo" ? " · read by the demo fixture" : f.interpreter === "rules" ? " · read by the rules (no text key)" : f.interpreter === "model" ? " · read by the model" : ""}
              </p>
            </div>
            <button type="button" className="fb-link" onClick={() => void remove(f)} title="Take this feedback off the month">
              <Trash2 size={12} />
            </button>
          </div>
          {!f.actions.length && <p className="fb-hint">No change could be read from this.</p>}
          {f.actions.map((a) => (
            <ActionCard key={a.id} action={a} posts={posts} busy={busy === a.id} imageCost={imageCost} onUpdate={(change) => update(a, change)} onApply={() => apply(a)} />
          ))}
        </article>
      ))}
    </section>
  );
}

function describePatch(a: FeedbackAction): string {
  if (!a.patch) return "";
  if (a.kind === "words") {
    const p = a.patch as WordsPatch;
    return [p.headline !== undefined ? `headline → "${p.headline}"` : "", p.subline !== undefined ? `second line → "${p.subline}"` : "", p.caption !== undefined ? `caption → "${p.caption}"` : ""].filter(Boolean).join(" · ");
  }
  const p = a.patch as PostOverlayPatch;
  return Object.entries(p)
    .map(([k, v]) => `${k}: ${typeof v === "number" ? v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "") : String(v)}`)
    .join(" · ");
}

function ActionCard({
  action: a,
  posts,
  busy,
  imageCost,
  onUpdate,
  onApply,
}: {
  action: FeedbackAction;
  posts: FeedbackPanelPost[];
  busy: boolean;
  imageCost: string | null;
  onUpdate: (change: Record<string, unknown>) => Promise<void>;
  onApply: () => Promise<void>;
}) {
  const target = posts.find((p) => p.index === a.post);
  const done = a.status === "applied" || a.status === "rejected";
  const [instruction, setInstruction] = useState(a.instruction ?? "");
  const [words, setWords] = useState<WordsPatch>(a.kind === "words" ? ((a.patch as WordsPatch) ?? {}) : {});
  const [version, setVersion] = useState(a.version ?? "");
  useEffect(() => {
    setInstruction(a.instruction ?? "");
    setWords(a.kind === "words" ? ((a.patch as WordsPatch) ?? {}) : {});
    setVersion(a.version ?? "");
  }, [a.id, a.instruction, a.patch, a.kind, a.version]);

  const saveWords = () => {
    const patch = Object.fromEntries(Object.entries(words).filter(([, v]) => typeof v === "string" && v.trim())) as WordsPatch;
    if (!Object.keys(patch).length) return;
    void onUpdate({ patch });
  };

  return (
    <div className={`fb-action ${a.status}`}>
      <div className="fb-action-head">
        {done ? (
          <span className={`fb-kind ${a.kind}`}>{kindLabel(a.kind)}</span>
        ) : (
          <select className={`fb-kind ${a.kind}`} value={a.kind} aria-label="Kind of change" disabled={busy} onChange={(e) => void onUpdate({ kind: e.target.value })}>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {kindLabel(k)}
              </option>
            ))}
          </select>
        )}
        <span className={`fb-status ${a.status}`}>{a.status === "applied" ? `Applied ${a.applied ? new Date(a.applied.at).toLocaleString() : ""}` : a.status}</span>
      </div>

      <p className="fb-change">{a.change}</p>

      {!done && (
        <div className="fb-targets">
          <label className="fb-field">
            <span>Post</span>
            <select value={a.post ?? ""} disabled={busy} onChange={(e) => void onUpdate({ post: e.target.value ? Number(e.target.value) : null })}>
              <option value="">{a.ambiguity ? "Pick the post…" : "No post"}</option>
              {posts.map((p) => (
                <option key={p.index} value={p.index}>
                  Post {p.index} · {p.title}
                  {p.hasPicture ? "" : " (no picture yet)"}
                </option>
              ))}
            </select>
          </label>
          <label className="fb-field">
            <span>Slide</span>
            <select value={a.slide ?? ""} disabled={busy || !target?.slides} onChange={(e) => void onUpdate({ slide: e.target.value ? Number(e.target.value) : null })}>
              <option value="">{target?.slides ? "Whole post" : "—"}</option>
              {Array.from({ length: target?.slides ?? 0 }, (_, i) => i + 1).map((s) => (
                <option key={s} value={s}>
                  Slide {s}
                </option>
              ))}
            </select>
          </label>
          <label className="fb-field">
            <span>Picture (version)</span>
            <input value={version} placeholder="current picture" disabled={busy} onChange={(e) => setVersion(e.target.value)} onBlur={() => version !== (a.version ?? "") && void onUpdate({ version: version.trim() || null })} />
          </label>
        </div>
      )}

      {a.kind === "image" && !done && (
        <label className="fb-field">
          <span>The edit the engine gets</span>
          <textarea value={instruction} disabled={busy} onChange={(e) => setInstruction(e.target.value)} onBlur={() => instruction.trim() !== (a.instruction ?? "") && void onUpdate({ instruction: instruction.trim() || null })} placeholder="One sentence: what changes in the picture" />
        </label>
      )}

      {a.kind === "words" && !done && (
        <div className="fb-targets">
          <label className="fb-field">
            <span>Headline</span>
            <input value={words.headline ?? ""} placeholder={target?.headline ?? ""} disabled={busy} onChange={(e) => setWords((w) => ({ ...w, headline: e.target.value }))} onBlur={saveWords} />
          </label>
          <label className="fb-field">
            <span>Second line</span>
            <input value={words.subline ?? ""} disabled={busy} onChange={(e) => setWords((w) => ({ ...w, subline: e.target.value }))} onBlur={saveWords} />
          </label>
          <label className="fb-field">
            <span>Caption</span>
            <input value={words.caption ?? ""} placeholder={target?.caption ?? ""} disabled={busy} onChange={(e) => setWords((w) => ({ ...w, caption: e.target.value }))} onBlur={saveWords} />
          </label>
        </div>
      )}

      {a.kind === "layer" && a.patch && <p className="fb-patch">{describePatch(a)}</p>}
      {a.kind === "words" && done && a.patch && <p className="fb-patch">{describePatch(a)}</p>}

      {a.ambiguity && !done && <p className="fb-note ambiguity">{a.ambiguity}</p>}
      {a.conflict && <p className="fb-note conflict">{a.conflict}</p>}
      {a.applied?.result && <p className="fb-note result">{a.applied.result}</p>}

      {!done && (
        <div className="fb-actions-row">
          {a.status !== "approved" ? (
            <button type="button" className="cta secondary small" disabled={busy} onClick={() => void onUpdate({ status: "approved" })}>
              <Check size={13} /> Approve
            </button>
          ) : (
            <button type="button" className="cta secondary small" disabled={busy} onClick={() => void onUpdate({ status: "proposed" })}>
              Un-approve
            </button>
          )}
          <button type="button" className="cta secondary small" disabled={busy} onClick={() => void onUpdate({ status: "rejected" })}>
            <X size={13} /> Reject
          </button>
          <button type="button" className="cta primary small" disabled={busy || !canApply(a)} title={canApply(a) ? "Apply this one change" : a.status !== "approved" ? "Approve the change first" : a.post === undefined ? "Pick the post first" : "Fill in the change first"} onClick={() => void onApply()}>
            <Play size={13} /> Apply
          </button>
          {a.kind === "image" && <span className="fb-cost">{imageCost ? `about ${imageCost} per picture, confirmed before spending` : "cost shown at Generate, confirmed before spending"}</span>}
        </div>
      )}
    </div>
  );
}
