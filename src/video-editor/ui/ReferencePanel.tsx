/**
 * "Edit like this video" (docs/video-editor.md → Edit quality), in the Auto edit tab: the person
 * gives a video whose editing they like (a Pinterest pin's video, a clip in the client's Drive, or a
 * file from this computer). It is read in this tab (engine/analyse.ts): its shots and their lengths,
 * movement and camera moves, pace, colour, beat and a rough text guess. "Apply to my footage" turns
 * that into a template (shared/reference-template.ts) filled with the person's best shots ranked by
 * movement (shared/edit-plan.ts fillSlots), optionally matching its colour. "Compare" plays the
 * reference and the cut side by side with a shot-by-shot timing table.
 *
 * The reference is never rendered into the output, and only its analysis is stored with the draft
 * (`project.reference`); its file is kept 7 days by the studio (Pinterest, Drive) or stays in this
 * tab (Upload). Fetching is admins only; members see the stored analysis and the comparison.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Columns2, Download, Film, Link2, Upload, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { get } from "@/api";
import { Orb } from "@/components/Orb";
import type { DriveListing, DrivePhoto } from "@shared/drive";
import { fitTransfer, type LabStats } from "@shared/colour-match";
import { averageShot, cameraLabel, templateFromReference, type ReferenceAnalysis } from "@shared/reference-template";
import { fillSlots, type PlanSource } from "@shared/edit-plan";
import { applyTemplate, type TemplateLanguage } from "@shared/video-templates";
import { analyseReferenceFile } from "../engine/analyse";
import { clipStats } from "../engine/looks";
import { sourceKey, type MediaStore } from "../engine/media";
import { fetchReference, referenceFileUrl } from "../api";
import type { PanelCtx } from "./Panels";
import CompareView from "./CompareView";
import "./reference.css";

/** What the panel needs from the editor besides PanelCtx. */
export interface ReferenceCtx {
  /** The footage read for the planners (the same reading as the auto edit's). */
  sources: () => Promise<PlanSource[]>;
  /** The month, for the studio's copy of a fetched reference. */
  batch: string | null;
  media: MediaStore;
  /** The editor's own preview stops while the comparison drives the same footage, and starts again after. */
  holdMain: (on: boolean) => void;
}

type From = "pinterest" | "drive" | "upload";

/** The reference file playable in this tab: a blob of an upload, or the studio's copy. */
interface RefFile {
  url: string;
  source: ReferenceAnalysis["source"];
}

export default function ReferencePanel({ ctx }: { ctx: PanelCtx }) {
  const stored = ctx.project.reference ?? null;
  const analysis = stored?.analysis ?? null;
  const [from, setFrom] = useState<From>("pinterest");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [file, setFile] = useState<RefFile | null>(null);
  const [language, setLanguage] = useState<TemplateLanguage>("both");
  const [matchColour, setMatchColour] = useState(stored?.matchColour ?? false);
  const [compare, setCompare] = useState(false);
  const [drive, setDrive] = useState<{ videos: DrivePhoto[]; error?: string } | null>(null);
  /** Whether Pinterest's API is connected (Connection → Pinterest); null until known. */
  const [pinterest, setPinterest] = useState<"connected" | "not_connected" | "expired" | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const blobRef = useRef<string | null>(null);
  const client = ctx.looks.client;

  useEffect(() => () => {
    if (blobRef.current) URL.revokeObjectURL(blobRef.current);
  }, []);
  // A reopened draft: its reference plays again from the studio's copy while it is kept.
  useEffect(() => {
    if (!file && analysis?.source.copy) setFile({ url: referenceFileUrl(analysis.source.copy), source: analysis.source });
  }, [analysis, file]);
  useEffect(() => {
    if (from !== "pinterest" || pinterest) return;
    let alive = true;
    get<{ state: "connected" | "not_connected" | "expired" }>("/api/studio/pinterest/status")
      .then((r) => {
        if (alive) setPinterest(r.state);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [from, pinterest]);
  useEffect(() => {
    if (from !== "drive" || !client || drive) return;
    let alive = true;
    get<DriveListing & { error?: string }>(`/api/studio/drive/${encodeURIComponent(client.id)}`)
      .then((r) => {
        if (!alive) return;
        const all = Object.values(r.groups ?? {}).flat() as DrivePhoto[];
        setDrive({ videos: all.filter((x) => x.video && !x.duplicateOf).slice(0, 60), error: r.error });
      })
      .catch((e) => alive && setDrive({ videos: [], error: (e as Error).message }));
    return () => {
      alive = false;
    };
  }, [from, client, drive]);

  const analyse = async (f: RefFile) => {
    setError("");
    setFile(f);
    try {
      setBusy("Reading the reference…");
      const r = await fetch(f.url, { credentials: "same-origin" });
      if (!r.ok) throw new Error(r.status === 410 || r.status === 404 ? "The studio's copy of the reference has expired: fetch or pick it again." : `The reference could not be read (${r.status}).`);
      const bytes = await r.arrayBuffer();
      const a = await analyseReferenceFile(bytes, f.source, (label, p) => setBusy(`${label}… ${Math.round(p * 100)}%`));
      ctx.commit((q) => ({ ...q, reference: { analysis: a, appliedAt: null, matchColour: false } }));
      toast.success(`Read ${a.shots.length} shots from the reference.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const fetchPin = async () => {
    setError("");
    try {
      setBusy("Asking Pinterest for the pin's video…");
      const r = await fetchReference({ from: "pinterest", url: link.trim(), ...(ctx.auto.reference.batch ? { batch: ctx.auto.reference.batch } : {}) });
      await analyse({ url: r.url, source: { kind: "pinterest", id: r.sourceId, name: r.name, url: link.trim(), copy: r.id } });
    } catch (e) {
      setError((e as Error).message);
      setBusy("");
    }
  };

  const fetchDrive = async (v: DrivePhoto) => {
    if (!client) return;
    setError("");
    try {
      setBusy(`Copying ${v.file || v.name} from the Drive…`);
      const r = await fetchReference({ from: "drive", client: client.id, fileId: v.id, ...(ctx.auto.reference.batch ? { batch: ctx.auto.reference.batch } : {}) });
      await analyse({ url: r.url, source: { kind: "drive", id: v.id, name: r.name, copy: r.id } });
    } catch (e) {
      setError((e as Error).message);
      setBusy("");
    }
  };

  const pickFile = (f: File) => {
    if (!/\.mp4$|\.m4v$|\.mov$/i.test(f.name) && f.type !== "video/mp4") return toast.error("Pick an MP4 video.");
    if (blobRef.current) URL.revokeObjectURL(blobRef.current);
    const url = URL.createObjectURL(f);
    blobRef.current = url;
    void analyse({ url, source: { kind: "upload", id: f.name.slice(0, 200), name: f.name.slice(0, 200) } });
  };

  const apply = async () => {
    if (!analysis) return;
    setError("");
    try {
      setBusy("Reading your footage…");
      const sources = await ctx.auto.reference.sources();
      if (!sources.length) throw new Error("Add footage under Media first.");
      const { template, notes } = templateFromReference(analysis);
      const p0 = ctx.project;
      const output = analysis.height > analysis.width ? { width: 1080, height: 1920 } : p0.output;
      const fills = fillSlots(sources, template.slots.map((s) => ({ duration: s.duration, action: s.action ?? 0.5 })), output);
      const logo = ctx.layers.logoUrl && ctx.layers.logoUrl.startsWith("/") ? { src: ctx.layers.logoUrl, name: "Client logo" } : null;
      let next = applyTemplate(template, p0, [], { windows: fills, keepLook: true, language, logo, words: ctx.words, frame: analysis.height > analysis.width ? "reel" : "keep" });
      if (matchColour && analysis.colour) {
        setBusy("Matching the reference's colour…");
        const ref: LabStats = { n: 1, mean: analysis.colour.mean, std: analysis.colour.std, sum: analysis.colour.mean, sumSq: [0, 0, 0] };
        const clips = [];
        for (const c of next.clips) {
          const m = ctx.sources.find((s) => s.key === sourceKey(c.source));
          if (!m) {
            clips.push(c);
            continue;
          }
          const { stats, frames } = await clipStats(m.url, c, 5);
          const t = fitTransfer(stats, ref);
          clips.push({ ...c, match: { ref: { kind: "video" as const, id: analysis.source.id.slice(0, 200), name: analysis.source.name.slice(0, 200) }, scale: t.scale, offset: t.offset, amount: 0.8, frames, at: Date.now() } });
        }
        next = { ...next, clips };
      }
      const gaps = fills.filter((x) => !x).length;
      ctx.commit(() => ({ ...next, reference: { analysis, appliedAt: Date.now(), matchColour }, edit: { purpose: "reference", pace: template.pace, summary: [`Cut like ${analysis.source.name}: ${template.slots.length} shots on its timings, your footage ranked by movement onto its shots.`, ...notes, ...(gaps ? [`${gaps} shot${gaps === 1 ? "" : "s"} had no footage long enough: left as gaps.`] : [])], at: Date.now() } }));
      ctx.seek(0);
      toast.success(`Your footage on the reference's ${template.slots.length} shots.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  const stats = useMemo(() => {
    if (!analysis) return null;
    const lens = analysis.shots.map((s) => s.end - s.start);
    const moves = new Map<string, number>();
    for (const s of analysis.shots) if (s.camera !== "still") moves.set(cameraLabel(s.camera), (moves.get(cameraLabel(s.camera)) ?? 0) + 1);
    const texts = analysis.shots.filter((s) => s.textY !== null).length;
    return { lens, moves: [...moves.entries()].map(([k, n]) => `${n} × ${k}`).join(", "), texts };
  }, [analysis]);

  const readOnly = ctx.readOnly;
  return (
    <div className="ve-fields vr-panel">
      <span className="ts-group-title">
        <Film size={13} /> Edit like this video
      </span>
      <p className="ts-hint">Give a video whose editing you like. It is read here for its rhythm: its shots and their lengths, movement, colour and beat, then your footage is cut the same way. The reference is only analysed and compared; it is never put into your video, and only its analysis is kept with the draft.</p>
      <fieldset className="ve-fields" disabled={readOnly || !!busy}>
        <div className="vl-seg" role="tablist" aria-label="Where the reference comes from">
          {(["pinterest", "drive", "upload"] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={from === k} className={from === k ? "on" : ""} onClick={() => setFrom(k)} disabled={k === "drive" && !client}>
              {k === "pinterest" ? "Pinterest" : k === "drive" ? "Drive" : "Upload"}
            </button>
          ))}
        </div>
        {from === "pinterest" && (
          <div className="vr-row">
            <input type="url" inputMode="url" placeholder="https://pinterest.com/pin/…" value={link} onChange={(e) => setLink(e.target.value)} aria-label="Pinterest pin link" />
            <button type="button" className="ts-btn" disabled={!/pinterest\.|pin\.it/i.test(link)} onClick={() => void fetchPin()}>
              <Link2 size={14} /> Fetch
            </button>
          </div>
        )}
        {from === "pinterest" && (
          <p className="ts-hint">
            {pinterest === "connected"
              ? "The studio asks Pinterest's API for the pin's video and keeps a copy for 7 days. The pin must be on one of the connected account's boards (save it there first)."
              : "The studio asks Pinterest for the pin's video and keeps a copy for 7 days. Pinterest sometimes refuses; then save the video and use Upload, or pick it from the Drive."}
            {pinterest === "not_connected" && <b> Connect Pinterest in Connection for reliable links.</b>}
            {pinterest === "expired" && <b> The Pinterest connection has expired: renew it in Connection.</b>}
          </p>
        )}
        {from === "drive" &&
          (!client ? (
            <p className="ts-hint">Open a client's post to pick from its Drive.</p>
          ) : !drive ? (
            <p className="ts-hint">
              <Orb size={12} status={null} /> Reading the client's Drive…
            </p>
          ) : drive.videos.length ? (
            <ul className="vr-drive">
              {drive.videos.map((v) => (
                <li key={v.id}>
                  <button type="button" className="ts-mini" onClick={() => void fetchDrive(v)} title={v.file}>
                    <Download size={12} /> {v.file || v.name}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="ts-hint">{drive.error ? `The Drive could not be read: ${drive.error}` : "No videos in the client's approved Drive folders."}</p>
          ))}
        {from === "upload" && (
          <>
            <input ref={fileRef} type="file" accept="video/mp4,video/quicktime,.mp4,.m4v,.mov" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) pickFile(f); e.target.value = ""; }} />
            <button type="button" className="ts-btn" onClick={() => fileRef.current?.click()}>
              <Upload size={14} /> Pick a video from this computer
            </button>
            <p className="ts-hint">The video stays in this tab (nothing is uploaded); after a reload pick it again to play it beside the cut.</p>
          </>
        )}
      </fieldset>
      {busy && (
        <p className="ts-hint" role="status">
          <Orb size={12} status={null} /> {busy}
        </p>
      )}
      {error && (
        <p className="vr-error" role="alert">
          {error}
        </p>
      )}
      {analysis && stats && (
        <div className="vr-result" data-testid="reference-analysis">
          <p className="vr-title">
            <b>{analysis.source.name}</b> · {analysis.duration.toFixed(1)} s · {analysis.width}×{analysis.height}
          </p>
          <div className="vr-strip" aria-label="The reference's shots">
            {analysis.shots.map((s, i) => (
              <span key={i} style={{ flexGrow: s.end - s.start }} className={s.action > 0.66 ? "hi" : s.action > 0.33 ? "mid" : "lo"} title={`Shot ${i + 1}: ${(s.end - s.start).toFixed(2)} s, ${cameraLabel(s.camera)}`} />
            ))}
          </div>
          <ul className="vr-facts">
            <li>
              {analysis.shots.length} shots, average {averageShot(analysis).toFixed(2)} s ({Math.min(...stats.lens).toFixed(2)}–{Math.max(...stats.lens).toFixed(2)} s)
            </li>
            <li>Pace: {analysis.pace.map((p) => p.toFixed(1)).join(" · ")} cuts per second, every 2 s</li>
            <li>Camera: {stats.moves || "mostly still"}</li>
            <li>Music: {analysis.music ? `a steady beat at about ${Math.round(analysis.music.bpm)} BPM` : "no steady beat heard"}</li>
            <li>On-screen text: {analysis.text === "found" ? `seen on ${stats.texts} shot${stats.texts === 1 ? "" : "s"} (a rough guess; the post's headline goes there, or a placeholder)` : "not detected (a rough guess: small or thin text is missed)"}</li>
          </ul>
          <fieldset className="ve-fields" disabled={readOnly || !!busy}>
            <div className="vl-seg" role="group" aria-label="Text language">
              {(["both", "en", "ar"] as const).map((l) => (
                <button key={l} type="button" className={language === l ? "on" : ""} aria-pressed={language === l} onClick={() => setLanguage(l)}>
                  {l === "both" ? "Arabic + English" : l === "en" ? "English" : "Arabic"}
                </button>
              ))}
            </div>
            <label className="ve-check">
              <input type="checkbox" checked={matchColour} disabled={!analysis.colour} onChange={(e) => setMatchColour(e.target.checked)} /> Match its colour (a Lab match at 80 %, adjustable under Colour)
            </label>
            <button type="button" className="ts-btn primary" onClick={() => void apply()}>
              <Wand2 size={14} /> Apply to my footage
            </button>
          </fieldset>
          <button type="button" className="ts-btn" onClick={() => setCompare(true)} disabled={!ctx.project.clips.length}>
            <Columns2 size={14} /> Compare the two videos
          </button>
          {stored?.appliedAt ? <p className="ts-hint">Applied {new Date(stored.appliedAt).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}{stored.matchColour ? " with its colour" : ""}. Everything stays editable; undo brings the previous cut back.</p> : null}
        </div>
      )}
      {compare && analysis && <CompareView ctx={ctx} analysis={analysis} file={file} onClose={() => setCompare(false)} onPick={() => setFrom(analysis.source.kind === "upload" ? "upload" : analysis.source.kind)} />}
    </div>
  );
}
