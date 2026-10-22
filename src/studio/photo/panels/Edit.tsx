/**
 * Edit (AI): the instruction with dictation, the marked area, the reference picture, the presets,
 * the scope block, the cost and the confirm; the result is shown on the canvas as Compare, AI result
 * or Original. The same server call as the post editor's "Edit this picture": one paid picture.
 * "Make another version" stays here as the secondary action, with the same confirm.
 */
import { useRef } from "react";
import { RefreshCw, Sparkles } from "lucide-react";
import { Orb } from "@/components/Orb";
import VoiceInput, { appendDictation } from "@/components/VoiceInput";
import { formatUsd } from "@shared/pricing";
import { areaWords } from "@shared/photo-adjust";
import { EditReference, REVISION_PRESETS } from "../../editTools";
import type { StudioCtx } from "../types";

const when = (t: number) => new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default function EditPanel({ ctx }: { ctx: StudioCtx }) {
  const { editor, task, busy, inFlight, edit, setEdit, marking, setMarking, area, setArea, cost } = ctx;
  const ref = useRef<HTMLTextAreaElement>(null);
  const post = editor.post;
  const takes = editor.takes ?? [];
  const made = takes.filter((t) => t.status === "made");
  const cur = made.find((t) => t.current);
  const takeNo = cur ? made.length - made.indexOf(cur) : made.length;
  const canSend = !busy && !inFlight && !!(edit.trim() || post.reference);
  const views: { id: string; label: string; on: boolean; pick: () => void }[] = [
    { id: "compare", label: "Compare", on: ctx.view.kind === "compare" && ctx.view.before === ctx.originalUrl, pick: () => ctx.setView({ kind: "compare", before: ctx.originalUrl, after: ctx.resultUrl, beforeLabel: "Product photo", afterLabel: "AI result" }) },
    { id: "result", label: "AI result", on: ctx.view.kind === "picture" && ctx.view.src === ctx.resultUrl, pick: () => ctx.setView({ kind: "picture", src: ctx.resultUrl, label: "The AI result" }) },
    { id: "original", label: "Original", on: ctx.view.kind === "picture" && ctx.view.src === ctx.originalUrl, pick: () => ctx.setView({ kind: "picture", src: ctx.originalUrl, label: "The product photo" }) },
  ];

  return (
    <div className="ps-panel">
      <div className="ts-panel-head">
        <span>Edit with AI</span>
        {made.length > 0 && (
          <small className="ps-take-line">
            Take {takeNo} of {made.length}
            {cur?.cost ? ` · ${formatUsd(cur.cost)}` : ""}
          </small>
        )}
      </div>

      <div className="ps-seg" role="tablist" aria-label="What the canvas shows">
        {views.map((v) => (
          <button key={v.id} type="button" role="tab" aria-selected={v.on} className={v.on ? "on" : ""} onClick={v.pick}>
            {v.label}
          </button>
        ))}
      </div>

      {inFlight && (
        <p className="revision-progress ps-progress">
          <Orb size={15} />
          {task.status === "queued" ? "A new version of this picture is queued. " : "A new version of this picture is being made. "}
          The current one stays until it arrives.
        </p>
      )}

      <label className="field-label" htmlFor="ps-instruction">
        What should change?
      </label>
      <textarea
        id="ps-instruction"
        ref={ref}
        className="ps-instruction"
        rows={4}
        dir="auto"
        placeholder="e.g. Keep the product unchanged. A cleaner marble background and softer light from the left."
        value={edit}
        onChange={(e) => setEdit(e.target.value)}
        disabled={busy}
      />
      <div className="ps-row">
        <VoiceInput label="Dictate the change" onText={(t) => setEdit((e) => appendDictation(e, t))} disabled={busy} />
      </div>

      <div className="ps-row ps-mark-row">
        <button type="button" className={`ts-mini ${marking ? "primary" : ""}`} disabled={busy || !task.output} onClick={() => setMarking(!marking)} title="Drag a box on the picture: it goes into the instruction in words (where and how big). It guides the engine; it is not a mask, and the whole picture is redrawn.">
          {marking ? "Stop marking" : "Mark an area"}
        </button>
        {area && area.w > 0.01 && (
          <>
            <button type="button" className="ts-mini" onClick={() => setEdit((e) => (e.trim() ? `${e.trim()} ${areaWords(area)}` : areaWords(area)))}>
              Put the marked area in the instruction
            </button>
            <button type="button" className="ts-link" onClick={() => setArea(null)}>
              Clear
            </button>
          </>
        )}
      </div>
      <p className="ts-hint">The engine redraws the whole picture from this one: a marked area guides the instruction, it is not a hard mask. The product is kept by instruction, not pixel-locked.</p>

      <span className="ts-group-title">Quick instructions</span>
      <div className="preset-chips ps-chips">
        {REVISION_PRESETS.map((p) => (
          <button key={p.label} type="button" disabled={busy} onClick={() => setEdit((e) => (e ? `${e} ${p.text}` : p.text))} title={p.text}>
            {p.label}
          </button>
        ))}
      </div>

      {editor.batchId && <EditReference batchId={editor.batchId} post={post} note={edit} disabled={busy || inFlight} onChanged={() => editor.onMonthChanged?.()} />}

      <div className="edit-scope ps-scope">
        {task.output && <img className="edit-scope-thumb" src={ctx.resultUrl} alt="The picture this edit starts from" />}
        <p>
          <b>Scope:</b> post {post.index}
          {post.group ? `, ${post.group.kind} slide ${post.group.slide} of ${post.group.of}` : ""} only. <b>Source:</b> the current picture
          {task.updated ? ` (${when(task.updated)})` : ""}
          {editor.lineage === "older" ? ", made for an earlier idea" : editor.lineage === "unknown" ? ", lineage unknown" : ""}
          {post.reference ? ", with the attached reference" : ""}. <b>What changes:</b> what the instruction says; the rest is kept by instruction. The picture it replaces stays under Versions; the words and layers are redrawn over the new picture.
        </p>
      </div>

      <button type="button" className="ts-btn primary ps-cta" disabled={!canSend} onClick={() => void ctx.revise(edit.trim() || (post.reference ? "Use the attached reference for this picture." : ""))} title="The current picture is changed as the instruction says: one paid picture">
        {busy ? <Orb size={15} /> : <RefreshCw size={15} />}
        {inFlight ? "Edit in progress…" : `Edit this picture${cost}`}
      </button>
      <p className="ts-hint">Each edit is one more paid picture{cost}. Only this post changes.</p>

      {ctx.remake && (
        <div className="ps-secondary">
          <span className="ts-group-title">Or start over</span>
          <button type="button" className="ts-btn ps-cta" disabled={busy || inFlight} onClick={() => void ctx.remake!()} title="A fresh picture of the same idea, from the idea and shot rather than this picture; you are asked first">
            <Sparkles size={14} /> Make another version{cost}
          </button>
          <p className="ts-hint">A fresh picture of the saved idea, not an edit of this one. The current picture stays under Versions.</p>
        </div>
      )}
    </div>
  );
}
