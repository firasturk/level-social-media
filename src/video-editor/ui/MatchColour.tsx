/**
 * "Match colour to a reference" (phase 3): the reference is a picture already saved in the studio
 * (this post's pinned reference, the theme's Pinterest pins and uploads), a photo from the
 * client's Drive (read through the studio's read-only photo route; the Drive file is never
 * changed), or a picture from this computer (kept in the tab; only an 8 KB thumbnail goes into the
 * project). Each clip in the scope is measured on five frames spread over it, a Lab transfer is
 * fitted once (shared/colour-match.ts) and stored on the clip with the reference's id and source;
 * the preview and the render apply that fixed transfer to every frame, so nothing flickers.
 * Measuring happens in this browser; nothing is uploaded, generated or paid for.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Image as ImageIcon, Pipette, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import { get } from "@/api";
import { Orb } from "@/components/Orb";
import { fitTransfer, statsDistance, type ColourMatch, type LabStats, type MatchRefKind } from "@shared/colour-match";
import type { DriveListing, DrivePhoto } from "@shared/drive";
import type { Clip } from "@shared/video-project";
import { setMatch } from "@shared/video-looks";
import { sourceKey } from "../engine/media";
import { clipStats, measurePicture } from "../engine/looks";
import type { PanelCtx } from "./Panels";
import { drivePhotoUrl, postRefUrl, studioRefUrl } from "./looks-ctx";

interface ChosenRef {
  kind: MatchRefKind;
  id: string;
  name: string;
  url: string;
}

type Tab = "studio" | "drive" | "upload";

/** Where a stored match's reference can be shown from (an uploaded picture only by its thumbnail). */
export function refPictureUrl(ref: ColourMatch["ref"]): string | null {
  if (ref.thumb) return ref.thumb;
  if (ref.kind === "studio") return studioRefUrl(ref.id);
  if (ref.kind === "drive") return drivePhotoUrl(ref.id, 240);
  if (ref.kind === "post") {
    const [batch, index] = ref.id.split(":");
    return batch && index ? postRefUrl(batch, Number(index), 0) : null;
  }
  return null;
}

const KIND_LABEL: Record<MatchRefKind, string> = { studio: "studio reference", post: "this post's reference", drive: "Drive photo", upload: "picture from this computer", video: "reference video" };

/** The statistics after a Lab transfer (exact for the linear map, before clamping). */
function after(s: LabStats, m: Pick<ColourMatch, "scale" | "offset">): LabStats {
  const mean = s.mean.map((v, c) => v * m.scale[c] + m.offset[c]) as LabStats["mean"];
  const std = s.std.map((v, c) => v * m.scale[c]) as LabStats["std"];
  return { ...s, mean, std };
}

export default function MatchColour({ ctx, targets, scopeLabel }: { ctx: PanelCtx; targets: Clip[]; scopeLabel: string }) {
  const refs = ctx.looks.references;
  const client = ctx.looks.client;
  const [tab, setTab] = useState<Tab>(refs.length ? "studio" : client ? "drive" : "upload");
  const [chosen, setChosen] = useState<ChosenRef | null>(null);
  const [busy, setBusy] = useState("");
  const [report, setReport] = useState<string>("");
  const [drive, setDrive] = useState<{ photos: DrivePhoto[]; error?: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const blobRef = useRef<string | null>(null);

  useEffect(() => () => {
    if (blobRef.current) URL.revokeObjectURL(blobRef.current);
  }, []);
  useEffect(() => {
    if (tab !== "drive" || !client || drive) return;
    let alive = true;
    get<DriveListing & { error?: string }>(`/api/studio/drive/${encodeURIComponent(client.id)}`)
      .then((r) => {
        if (!alive) return;
        const pics = [...(r.groups?.reference ?? []), ...(r.groups?.product ?? []), ...(r.groups?.brand ?? [])].filter((x) => !x.video && !x.duplicateOf);
        setDrive({ photos: pics.slice(0, 60), error: r.error });
      })
      .catch((e) => alive && setDrive({ photos: [], error: (e as Error).message }));
    return () => {
      alive = false;
    };
  }, [tab, client, drive]);

  const matched = targets.filter((c) => c.match);
  const amount = matched[0]?.match?.amount ?? 1;
  const shownRef = matched[0]?.match?.ref ?? null;
  const shownUrl = useMemo(() => (shownRef ? refPictureUrl(shownRef) : null), [shownRef]);

  const pickFile = (file: File) => {
    if (!file.type.startsWith("image/")) return toast.error("Pick a picture (JPEG, PNG or WebP).");
    if (blobRef.current) URL.revokeObjectURL(blobRef.current);
    const url = URL.createObjectURL(file);
    blobRef.current = url;
    setChosen({ kind: "upload", id: file.name.slice(0, 200), name: file.name.slice(0, 200), url });
  };

  const run = async () => {
    if (!chosen || !targets.length) return;
    setReport("");
    try {
      setBusy("Reading the reference…");
      const ref = await measurePicture(chosen.url);
      const fits = new Map<string, ColourMatch>();
      const lines: string[] = [];
      for (const [i, c] of targets.entries()) {
        const m = ctx.sources.find((s) => s.key === sourceKey(c.source));
        if (!m) {
          lines.push(`${ctx.labelOf(c)}: its footage is not loaded here, skipped.`);
          continue;
        }
        setBusy(`Measuring ${ctx.labelOf(c)} (${i + 1}/${targets.length})…`);
        const { stats, frames } = await clipStats(m.url, c, 5);
        const t = fitTransfer(stats, ref.stats);
        fits.set(c.id, { ref: { kind: chosen.kind, id: chosen.id, name: chosen.name, ...(chosen.kind === "upload" && ref.thumb ? { thumb: ref.thumb } : {}) }, scale: t.scale, offset: t.offset, amount, frames, at: Date.now() });
        const before = statsDistance(stats, ref.stats);
        const now = statsDistance(after(stats, t), ref.stats);
        lines.push(`${ctx.labelOf(c)}: ${frames} frames, distance to the reference ${before.toFixed(0)} → ${now.toFixed(0)}`);
      }
      if (!fits.size) throw new Error("No clip in the scope has its footage loaded here.");
      ctx.commit((q) => ({ ...q, clips: q.clips.map((c) => (fits.has(c.id) ? { ...c, match: fits.get(c.id)! } : c)) }));
      setReport(lines.join("\n"));
      toast.success(`Colour matched on ${fits.size} clip${fits.size === 1 ? "" : "s"}.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  };

  return (
    <fieldset className="ve-fields" disabled={ctx.readOnly}>
      <span className="ts-group-title">Match colour to a reference</span>
      <p className="ts-hint">Moves the brightness, contrast and colour cast of {scopeLabel} toward a picture: measured on five frames of each clip, fitted once, the same on every frame. A statistical match (Lab mean and spread), not a scene understanding.</p>
      {shownRef && (
        <div className="vl-chosen">
          {shownUrl ? <img src={shownUrl} alt="" /> : <ImageIcon size={18} />}
          <span>
            Matched to <b>{shownRef.name || "a reference"}</b> ({KIND_LABEL[shownRef.kind]}) · {matched.length} of {targets.length} clip{targets.length === 1 ? "" : "s"}
          </span>
        </div>
      )}
      {matched.length > 0 && (
        <>
          <label className="ts-slider">
            <span>
              Match strength <em>{Math.round(amount * 100)}%</em>
            </span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={amount}
              aria-label="Match strength"
              onPointerDown={ctx.mark}
              onChange={(e) => {
                const v = Number(e.target.value);
                const ids = new Set(matched.map((c) => c.id));
                ctx.patch((q) => ({ ...q, clips: q.clips.map((c) => (ids.has(c.id) && c.match ? { ...c, match: { ...c.match, amount: v } } : c)) }));
              }}
              onPointerUp={() => ctx.commit((q) => q)}
            />
          </label>
          <button type="button" className="ts-mini danger" onClick={() => ctx.commit((q) => setMatch(q, matched.map((c) => c.id), null))}>
            <Trash2 size={12} /> Remove the match
          </button>
        </>
      )}
      <div className="vl-seg" role="tablist" aria-label="Where the reference comes from">
        <button type="button" role="tab" aria-selected={tab === "studio"} className={tab === "studio" ? "on" : ""} onClick={() => setTab("studio")}>
          Studio
        </button>
        <button type="button" role="tab" aria-selected={tab === "drive"} className={tab === "drive" ? "on" : ""} onClick={() => setTab("drive")} disabled={!client}>
          Drive
        </button>
        <button type="button" role="tab" aria-selected={tab === "upload"} className={tab === "upload" ? "on" : ""} onClick={() => setTab("upload")}>
          Upload
        </button>
      </div>
      {tab === "studio" &&
        (refs.length ? (
          <div className="vl-refs">
            {refs.map((r) => (
              <button key={`${r.kind}:${r.id}`} type="button" className={`vl-ref ${chosen?.kind === r.kind && chosen.id === r.id ? "on" : ""}`} onClick={() => setChosen({ kind: r.kind, id: r.id, name: r.name, url: r.url })} title={r.name}>
                <img src={r.url} alt={r.name} loading="lazy" />
              </button>
            ))}
          </div>
        ) : (
          <p className="ts-hint">No reference saved for this post or its theme. Pin one in the post editor, add Pinterest pins to the theme, or use Drive or Upload.</p>
        ))}
      {tab === "drive" &&
        (!drive ? (
          <p className="ts-hint">
            <Orb size={12} status={null} /> Reading the client's Drive…
          </p>
        ) : drive.photos.length ? (
          <div className="vl-refs">
            {drive.photos.map((ph) => (
              <button key={ph.id} type="button" className={`vl-ref ${chosen?.kind === "drive" && chosen.id === ph.id ? "on" : ""}`} onClick={() => setChosen({ kind: "drive", id: ph.id, name: ph.name || ph.file, url: drivePhotoUrl(ph.id, 512) })} title={ph.file}>
                <img src={drivePhotoUrl(ph.id, 240)} alt={ph.name} loading="lazy" />
              </button>
            ))}
          </div>
        ) : (
          <p className="ts-hint">{drive.error ? `The Drive could not be read: ${drive.error}` : "No photos in the client's approved Drive folders."}</p>
        ))}
      {tab === "upload" && (
        <>
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) pickFile(f); e.target.value = ""; }} />
          <button type="button" className="ts-btn" onClick={() => fileRef.current?.click()}>
            <Upload size={14} /> Pick a picture from this computer
          </button>
          <p className="ts-hint">The picture stays in this tab; the draft keeps only its name and a tiny thumbnail.</p>
        </>
      )}
      {chosen && (
        <div className="vl-chosen">
          <img src={chosen.url} alt="" />
          <span>
            Reference: <b>{chosen.name}</b> ({KIND_LABEL[chosen.kind]})
          </span>
        </div>
      )}
      <button type="button" className="ts-btn primary" disabled={!chosen || !targets.length || !!busy} onClick={() => void run()}>
        {busy ? <Orb size={14} status={null} /> : <Pipette size={14} />} {busy || `Match ${targets.length === 1 ? "this clip" : `${targets.length} clips`}`}
      </button>
      {report && <pre className="ts-hint" style={{ whiteSpace: "pre-wrap", margin: 0 }}>{report}</pre>}
    </fieldset>
  );
}
