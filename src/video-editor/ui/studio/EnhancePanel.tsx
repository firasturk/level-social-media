/**
 * Enhance: the providers' tools on the shown version. Magnific: upscale (three modes), colour grade
 * (a LUT with an intensity, or sliders), music, sound effects, relight, HDR. Higgsfield: upscale,
 * reframe (9:16, 1:1, 4:5), remove the background. Each says its cost first (simulated, asked, or
 * "cost not known"), is confirmed, runs once, and its result becomes a new version of the same post
 * with the provider's label. Admins only for now; members see the cards and the note.
 */
import { useEffect, useState } from "react";
import { Lock, Wand2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Orb } from "@/components/Orb";
import { ApiError } from "@/api";
import { askConfirm } from "@/lib/confirm";
import { versionLabel } from "@/studio/videoApi";
import { higgsfieldTool, higgsfieldTools, magnificEnhance, magnificLuts, magnificStatus, type ConfirmAsk, type HiggsfieldTools, type MagnificStatus } from "../../studioApi";
import type { StudioShared } from "./types";

type Tool = { provider: "magnific" | "higgsfield"; name: string; label: string; hint: string; available: boolean };
const ADJUSTMENTS = ["brightness", "contrast", "exposure", "hue", "saturation", "temperature", "tint"] as const;

export default function EnhancePanel({ s }: { s: StudioShared }) {
  const [mg, setMg] = useState<MagnificStatus | null>(null);
  const [hf, setHf] = useState<HiggsfieldTools | null>(null);
  const [luts, setLuts] = useState<{ id: string; name: string }[]>([]);
  const [tool, setTool] = useState<Tool | null>(null);
  const [args, setArgs] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const shown = (s.shownId ? s.videos.find((v) => v.id === s.shownId) : null) ?? s.videos.find((v) => v.status === "done") ?? null;
  useEffect(() => {
    magnificStatus()
      .then((st) => {
        setMg(st);
        if (st.connected && st.admin && st.access.enabled) magnificLuts().then((r) => setLuts(r.luts)).catch(() => undefined);
      })
      .catch((e: Error) => setError(e.message));
    higgsfieldTools()
      .then(setHf)
      .catch((e: Error) => setError(e.message));
  }, []);
  const tools: Tool[] = [
    ...(mg?.tools ?? []).map((t) => ({ provider: "magnific" as const, ...t, available: !!mg?.connected && !!mg.access.enabled })),
    ...(hf?.tools ?? []).map((t) => ({ provider: "higgsfield" as const, ...t, available: t.available && !!hf?.signedIn && !!hf.access.enabled && hf.billing === "credits" })),
  ];
  const pick = (t: Tool) => {
    setTool(t);
    setError("");
    setArgs(t.name === "video_upscale" ? { mode: "magnific" } : t.name === "video_music" ? { mixMode: "lower" } : t.name === "reframe" ? { aspect_ratio: "9:16" } : t.name === "video_color_grade" ? { intensity: 1 } : {});
  };
  async function run(confirm = false) {
    if (!s.post || !shown || !tool) return;
    setBusy(true);
    setError("");
    try {
      const body = { batch: s.post.batch, videoId: shown.id, tool: tool.name, arguments: args, confirm };
      const r = tool.provider === "magnific" ? await magnificEnhance(body) : await higgsfieldTool(body);
      await s.reloadVideos();
      s.setShownId(r.video.id);
      s.onChanged?.();
      toast.success(r.video.status === "done" ? `${tool.label} done: a new version.` : `${tool.label} started; the new version lands in a minute or two.`);
    } catch (e) {
      const err = e as ApiError;
      const d = (err.data ?? {}) as ConfirmAsk;
      if (err.status === 409 && (d.needsConfirm || d.needsEstimate)) {
        const n = d.credits ?? d.estimate;
        const ok = await askConfirm(d.needsEstimate ? `${tool.label} on ${versionLabel(shown)}: ${tool.provider === "higgsfield" ? "Higgsfield" : "Magnific"} gives no cost for it. Run it at an unknown cost? The result becomes a new version of this post.` : `${tool.label} on ${versionLabel(shown)}: about ${n} credits from the ${tool.provider === "higgsfield" ? "subscription" : "Magnific"} balance${d.balance != null ? ` (${d.balance} available)` : ""}. The result becomes a new version of this post.`, { ok: d.needsEstimate ? "Run it anyway, cost unknown" : `Run · ${n} credits`, danger: false, cancel: "Not now" });
        if (ok) return run(true);
      } else setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  const set = (k: string, v: unknown) => setArgs((a) => ({ ...a, [k]: v }));
  const adjustments = (args.adjustments as Record<string, number> | undefined) ?? {};
  const locked = !s.admin;
  return (
    <div className="vs-panel">
      <div className="ts-panel-head">
        <span>
          <Wand2 size={13} /> Enhance
        </span>
        <small>{shown ? versionLabel(shown) : "no clip yet"}</small>
      </div>
      {locked && (
        <div className="vs-locked" role="note">
          <Lock size={14} />
          <div>
            <b>Admins only for now</b>
            <p>Every tool here runs a paid provider; an admin opens it for the team once it is approved.</p>
          </div>
        </div>
      )}
      {!shown && <p className="ts-hint">Make or pick a finished clip first: a tool works on one version and its result becomes a new one.</p>}
      {!mg && !hf && !error && (
        <p className="ts-hint">
          <Orb size={14} /> Asking the providers which tools they offer…
        </p>
      )}
      <span className="ts-group-title">Magnific</span>
      {mg && !mg.connected && <p className="ts-hint warn">{mg.reason}</p>}
      {mg && mg.connected && !mg.access.enabled && <p className="ts-hint warn">{mg.access.reason}</p>}
      <div className="vs-cards">
        {tools
          .filter((t) => t.provider === "magnific")
          .map((t) => (
            <button key={t.name} type="button" className={`vs-card ${tool?.name === t.name ? "on" : ""} ${t.available ? "" : "off"}`} disabled={!t.available} onClick={() => pick(t)}>
              <span>
                <b>{t.label}</b>
                <small>{t.hint}</small>
              </span>
              <em>credits</em>
            </button>
          ))}
      </div>
      <span className="ts-group-title">Higgsfield</span>
      {hf && !hf.signedIn && <p className="ts-hint warn">{hf.reason}</p>}
      {hf && hf.signedIn && hf.billing !== "credits" && <p className="ts-hint warn">Videos are set to the Cloud API key; these tools run on the subscription credits. Switch the billing under Connection → Higgsfield.</p>}
      <div className="vs-cards">
        {tools
          .filter((t) => t.provider === "higgsfield")
          .map((t) => (
            <button key={t.name} type="button" className={`vs-card ${tool?.name === t.name ? "on" : ""} ${t.available ? "" : "off"}`} disabled={!t.available} onClick={() => pick(t)} title={hf && !hf.available[t.name] ? "Not available on this plan" : undefined}>
              <span>
                <b>{t.label}</b>
                <small>{hf && hf.signedIn && !hf.available[t.name] ? "Not available on this plan." : t.hint}</small>
              </span>
              <em>credits</em>
            </button>
          ))}
      </div>

      {tool && (
        <fieldset className="vs-fields" disabled={busy || locked || !shown}>
          <span className="ts-group-title">
            {tool.label} · {tool.provider === "magnific" ? "Magnific" : "Higgsfield"}
          </span>
          {tool.name === "video_upscale" && (
            <div className="vs-seg" role="radiogroup" aria-label="Upscale mode">
              {(["topaz", "magnific", "magnific_precision"] as const).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={args.mode === m} className={args.mode === m ? "on" : ""} onClick={() => set("mode", m)}>
                  {m === "topaz" ? "Topaz" : m === "magnific" ? "Magnific" : "Precision"}
                </button>
              ))}
            </div>
          )}
          {tool.name === "reframe" && (
            <div className="vs-seg" role="radiogroup" aria-label="Frame">
              {["9:16", "1:1", "4:5"].map((a) => (
                <button key={a} type="button" role="radio" aria-checked={args.aspect_ratio === a} className={args.aspect_ratio === a ? "on" : ""} onClick={() => set("aspect_ratio", a)}>
                  {a}
                </button>
              ))}
            </div>
          )}
          {tool.name === "video_color_grade" && (
            <>
              <label className="vs-field">
                <span>LUT</span>
                <select value={(args.lutId as string) ?? ""} onChange={(e) => set("lutId", e.target.value || undefined)}>
                  <option value="">None: sliders only</option>
                  {luts.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="ts-slider">
                <span>
                  Intensity <em>{Math.round(((args.intensity as number) ?? 1) * 100)}%</em>
                </span>
                <input type="range" min={0} max={1} step={0.05} value={(args.intensity as number) ?? 1} onChange={(e) => set("intensity", Number(e.target.value))} />
              </label>
              {ADJUSTMENTS.map((k) => (
                <label key={k} className="ts-slider">
                  <span>
                    {k[0].toUpperCase() + k.slice(1)} <em>{(adjustments[k] ?? 0) > 0 ? "+" : ""}{(adjustments[k] ?? 0).toFixed(2)}</em>
                  </span>
                  <input type="range" min={-1} max={1} step={0.05} value={adjustments[k] ?? 0} onChange={(e) => set("adjustments", { ...adjustments, [k]: Number(e.target.value) })} onDoubleClick={() => set("adjustments", { ...adjustments, [k]: 0 })} />
                </label>
              ))}
            </>
          )}
          {(tool.name === "video_music" || tool.name === "video_soundfx" || tool.name === "video_relight") && (
            <label className="vs-field">
              <span>{tool.name === "video_music" ? "The music, in a few words (optional)" : tool.name === "video_soundfx" ? "The sounds, in a few words (optional)" : "The light, in a few words"}</span>
              <textarea rows={2} value={(args.prompt as string) ?? ""} onChange={(e) => set("prompt", e.target.value || undefined)} />
            </label>
          )}
          {tool.name === "video_music" && (
            <div className="vs-seg" role="radiogroup" aria-label="The clip's own sound">
              {(["none", "lower", "remove"] as const).map((m) => (
                <button key={m} type="button" role="radio" aria-checked={args.mixMode === m} className={args.mixMode === m ? "on" : ""} onClick={() => set("mixMode", m)} title={m === "none" ? "Keep the clip's sound as it is under the music" : m === "lower" ? "Lower the clip's sound under the music" : "Remove the clip's sound"}>
                  {m === "none" ? "Keep its sound" : m === "lower" ? "Lower its sound" : "Music only"}
                </button>
              ))}
            </div>
          )}
          {tool.name === "video_hdr" && <p className="ts-hint">No settings: the clip is re-rendered with more range in its lights and darks.</p>}
          {tool.name === "upscale_video" && <p className="ts-hint">No settings: Higgsfield picks the size.</p>}
          {tool.name === "remove_background" && <p className="ts-hint">The subject is kept, the background taken out.</p>}
          <button type="button" className="ts-btn primary vs-cta" disabled={!shown || busy || locked} onClick={() => void run()}>
            {busy ? <Orb size={14} status={null} /> : <Wand2 size={14} />} {tool.label} · cost said before the run
          </button>
          <p className="ts-hint">The result becomes a new version of this post; {shown ? versionLabel(shown) : "the version"} stays as it is.</p>
        </fieldset>
      )}
      {error && (
        <p className="ts-hint warn">
          <TriangleAlert size={12} /> {error}
        </p>
      )}
    </div>
  );
}
