/**
 * The templates gallery (phase 3), at the top of the Media tab: the six original templates
 * (shared/video-templates.ts), each with a schematic thumbnail drawn from its own definition (the
 * shots as a strip, the text and logo places in the frame), its shots, pace, look and music hint.
 * "Use this template" fills the cut with the footage at hand, the template's texts (English,
 * Arabic or both), its preset and the client's logo; everything stays editable and undo brings the
 * previous cut back. Nothing is generated and nothing is charged.
 */
import { useState } from "react";
import { ChevronDown, ChevronUp, LayoutTemplate } from "lucide-react";
import { toast } from "sonner";
import { askConfirm } from "@/lib/confirm";
import { lookOf } from "@shared/video-project";
import { applyTemplate, templateLength, TEMPLATES, type TemplateLanguage, type TemplateMedia, type VideoTemplate } from "@shared/video-templates";
import { MUSIC_MOODS } from "@shared/music";
import { sourceKey } from "../engine/media";
import type { PanelCtx } from "./Panels";
import "./video-looks.css";

const SLOT_COLOURS = ["#5b6cff", "#f59e0b", "#10b981", "#ef4444", "#8b5cf6", "#0ea5e9", "#f97316", "#14b8a6"];

/** The template as a picture: a 9:16 frame with its text and logo places, and its shots as a strip below. */
export function TemplateSchematic({ t }: { t: VideoTemplate }) {
  const W = 90;
  const H = 160;
  const total = t.slots.reduce((s, x) => s + x.duration, 0);
  let x = 4;
  return (
    <svg viewBox={`0 0 ${W} ${H + 16}`} role="img" aria-label={`${t.name}: ${t.slots.length} shots`}>
      <rect x="0" y="0" width={W} height={H} rx="6" fill={t.background === "#ffffff" || t.background === "#f4f1ec" ? "#d9d4cc" : "#26262b"} />
      <rect x="6" y="40" width={W - 12} height={H - 80} rx="4" fill="rgba(255,255,255,0.08)" />
      {t.texts.map((tx, i) => {
        const w = Math.min(W - 16, Math.max(20, tx.en.length * tx.size * 22));
        return <rect key={i} x={tx.x * W - w / 2} y={tx.y * H - tx.size * H * 0.45} width={w} height={Math.max(3, tx.size * H * 0.9)} rx="1.5" fill={tx.box ?? "#ffffff"} opacity={tx.box ? 0.95 : 0.85} />;
      })}
      <circle cx={t.logo.x * W} cy={t.logo.y * H} r={Math.max(3, t.logo.width * W * 0.22)} fill="none" stroke="#ffffff" strokeDasharray="2 1.5" strokeWidth="1" />
      {t.slots.map((s, i) => {
        const w = Math.max(2, ((W - 8) * s.duration) / total);
        const r = <rect key={i} x={x} y={H + 5} width={w - 1} height="7" rx="1.5" fill={SLOT_COLOURS[i % SLOT_COLOURS.length]} opacity={s.transition === "crossfade" ? 0.7 : 1} />;
        x += w;
        return r;
      })}
    </svg>
  );
}

const PACE: Record<VideoTemplate["pace"], string> = { calm: "Calm", steady: "Steady", fast: "Fast, on the beat" };

export default function TemplatesGallery({ ctx }: { ctx: PanelCtx }) {
  const [open, setOpen] = useState(!ctx.project.clips.length);
  const [pick, setPick] = useState<string | null>(ctx.project.template?.id ?? null);
  const [language, setLanguage] = useState<TemplateLanguage>("both");
  const t = TEMPLATES.find((x) => x.id === pick) ?? null;

  const use = async (tpl: VideoTemplate) => {
    if (ctx.project.clips.length || ctx.project.overlays.length) {
      const ok = await askConfirm(`Start this cut again from “${tpl.name}”? The timeline, texts and logo are replaced (undo brings them back).`, { ok: "Use the template", cancel: "Keep my cut", danger: false });
      if (!ok) return;
    }
    // The footage on the timeline first (in order), then the post's other footage.
    const seen = new Set<string>();
    const media: TemplateMedia[] = [];
    const add = (m: { key: string; source: TemplateMedia["source"]; duration: number }) => {
      if (seen.has(m.key)) return;
      seen.add(m.key);
      media.push({ source: m.source, duration: m.duration });
    };
    for (const c of ctx.project.clips) {
      const m = ctx.sources.find((s) => s.key === sourceKey(c.source));
      if (m) add(m);
    }
    for (const m of ctx.sources) add(m);
    const brand = ctx.layers.logoUrl && ctx.layers.logoUrl.startsWith("/") ? { src: ctx.layers.logoUrl, name: "Client logo" } : null;
    ctx.commit((q) => applyTemplate(tpl, q, media, { language, logo: brand }));
    const moods = tpl.music.moods.map((id) => MUSIC_MOODS.find((m) => m.id === id)?.label ?? id).join(", ");
    toast.success(`${tpl.name}: ${tpl.slots.length} shots${media.length ? "" : " (add footage to fill them)"}. Suggested music: ${moods}${tpl.music.bpm ? `, ${tpl.music.bpm[0]}–${tpl.music.bpm[1]} BPM` : ""}.`);
  };

  return (
    <div className="ve-fields">
      <button type="button" className="ts-group-title ve-panel-head" onClick={() => setOpen((o) => !o)} aria-expanded={open} style={{ width: "100%", textAlign: "left" }}>
        <span>
          <LayoutTemplate size={13} /> Start from a template
        </span>
        {open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
      </button>
      {open && (
        <>
          <div className="vl-templates" role="list">
            {TEMPLATES.map((x) => (
              <button key={x.id} type="button" role="listitem" className={`vl-template ${pick === x.id ? "on" : ""}`} onClick={() => setPick(x.id)} aria-pressed={pick === x.id} data-template={x.id}>
                <TemplateSchematic t={x} />
                <span>{x.name}</span>
              </button>
            ))}
          </div>
          {t && (
            <div className="ve-fields">
              <p className="ts-hint">{t.description}</p>
              <p className="ts-hint">
                {t.slots.length} shots · about {templateLength(t).toFixed(1)} s · {PACE[t.pace]} · colour: {lookOf(t.look.id).name} {Math.round(t.look.amount * 100)}%{t.protectSkin ? " · skin protected" : ""}
              </p>
              <ol className="vl-slots">
                {t.slots.map((s, i) => (
                  <li key={i}>
                    <b>{s.label}</b> · {s.duration}s{s.framing.zoom > 1 ? ` · zoom ${s.framing.zoom}×` : ""}
                    {s.framing.fit === "fit" ? " · Fit" : ""}
                    {i > 0 && s.transition === "crossfade" ? " · crossfade" : ""}
                    <br />
                    <small>{s.hint}</small>
                  </li>
                ))}
              </ol>
              <p className="ts-hint">
                Music: {t.music.moods.map((id) => MUSIC_MOODS.find((m) => m.id === id)?.label ?? id).join(", ")}
                {t.music.bpm ? ` · ${t.music.bpm[0]}–${t.music.bpm[1]} BPM` : ""}. {t.music.note}
              </p>
              <div className="vl-seg" role="group" aria-label="Text language">
                {(["both", "en", "ar"] as const).map((l) => (
                  <button key={l} type="button" className={language === l ? "on" : ""} aria-pressed={language === l} onClick={() => setLanguage(l)}>
                    {l === "both" ? "Arabic + English" : l === "en" ? "English" : "Arabic"}
                  </button>
                ))}
              </div>
              <button type="button" className="ts-btn primary" disabled={ctx.readOnly} onClick={() => void use(t)} title={ctx.readOnly ? ctx.reason : "Fill the cut with this template; everything stays editable"}>
                <LayoutTemplate size={14} /> Use this template
              </button>
              <p className="ts-hint">Fills the cut with the footage above (reused when there are fewer clips than shots), placeholder words to replace, the preset and {ctx.layers.logoUrl ? "the client's logo" : "a place for the logo (add it under Logo)"}. Nothing is generated or charged.</p>
            </div>
          )}
        </>
      )}
    </div>
  );
}
