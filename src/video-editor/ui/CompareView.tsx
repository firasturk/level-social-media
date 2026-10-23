/**
 * "Comparing the two videos": the reference and the cut side by side, played together (the cut's
 * clock leads; the reference follows within a tenth of a second), with a scrubber and a
 * shot-by-shot timing table (where each shot starts and how long it lasts in both, the difference in
 * frames at 30 fps). The cut is drawn by the editor's own compositor (a Player on its own canvas),
 * so it looks exactly as it will render; the editor's preview is held meanwhile because both draw
 * from the same hidden footage. The reference is shown only here, never put into the video.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pause, Play, Volume2, X } from "lucide-react";
import { compareTimings, type ReferenceAnalysis } from "@shared/reference-template";
import { totalLength } from "@shared/video-project";
import { formatTimecode } from "@shared/video-timeline";
import { Player } from "../engine/preview";
import type { PanelCtx } from "./Panels";

export default function CompareView({ ctx, analysis, file, onClose, onPick }: { ctx: PanelCtx; analysis: ReferenceAnalysis; file: { url: string } | null; onClose: () => void; onPick: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const playerRef = useRef<Player | null>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [sound, setSound] = useState<"cut" | "reference">("cut");
  const [refError, setRefError] = useState("");
  const project = ctx.project;
  const length = Math.max(totalLength(project), analysis.duration);
  const rows = useMemo(() => compareTimings(analysis, project.clips, ctx.labelOf), [analysis, project.clips, ctx.labelOf]);
  const hold = ctx.auto.reference.holdMain;

  useEffect(() => {
    hold(true);
    const p = new Player(canvasRef.current!, ctx.auto.reference.media, project);
    playerRef.current = p;
    p.onTime = (time, on) => {
      setT(time);
      setPlaying(on);
      const v = videoRef.current;
      if (!v || !Number.isFinite(v.duration)) return;
      const target = Math.min(time, v.duration);
      const drift = v.currentTime - target;
      // The drift measured at the same instant on both clocks (read by the automated check).
      if (v.parentElement) v.parentElement.dataset.drift = drift.toFixed(3);
      if (on && time < v.duration) {
        // Far off: jump. Near: nudge the reference's speed so it converges without stutter.
        if (Math.abs(drift) > 0.25) v.currentTime = target;
        v.playbackRate = Math.abs(drift) < 0.02 ? 1 : drift > 0 ? 0.92 : 1.08;
        if (v.paused) void v.play().catch(() => undefined);
      } else {
        v.playbackRate = 1;
        if (!v.paused) v.pause();
        if (Math.abs(v.currentTime - target) > 0.04) v.currentTime = target;
      }
    };
    p.seek(0);
    return () => {
      p.dispose();
      playerRef.current = null;
      hold(false);
    };
    // The comparison opens on the cut as it is; a change made while it is open shows on the next opening.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    playerRef.current?.setMuted(sound !== "cut");
    if (videoRef.current) videoRef.current.muted = sound !== "reference";
  }, [sound]);
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);

  const toggle = () => {
    const p = playerRef.current;
    if (!p) return;
    if (p.playing) p.pause();
    else p.play();
  };
  const seek = (time: number) => playerRef.current?.seek(time);
  const current = rows.findIndex((r) => r.ours && t >= r.ours.start - 1e-6 && t < r.ours.start + r.ours.length - 1e-6);
  const fmt = (s: number) => s.toFixed(2);

  return createPortal(
    <div className="vr-compare" role="dialog" aria-label="Compare the reference and your cut">
      <header>
        <b>Reference vs your cut</b>
        <span className="ts-hint">The reference is shown here only to compare; it is never part of your video.</span>
        <button type="button" className="ts-icon" onClick={onClose} aria-label="Close" title="Close (Esc)">
          <X size={16} />
        </button>
      </header>
      <div className="vr-panes">
        <figure>
          <figcaption>Reference · {analysis.source.name}</figcaption>
          {file ? (
            <video ref={videoRef} src={file.url} muted playsInline preload="auto" crossOrigin="use-credentials" onError={() => setRefError("The reference could not be played here (its copy may have expired).")} />
          ) : (
            <div className="vr-missing">
              <p>The reference file is not loaded in this tab.</p>
              <button type="button" className="ts-mini" onClick={() => { onPick(); onClose(); }}>
                {analysis.source.kind === "upload" ? "Pick it again" : "Fetch it again"}
              </button>
            </div>
          )}
          {refError && <p className="vr-error">{refError}</p>}
        </figure>
        <figure>
          <figcaption>Your cut · {project.clips.length} shots</figcaption>
          <canvas ref={canvasRef} />
        </figure>
      </div>
      <div className="vr-transport">
        <button type="button" className="ts-icon" onClick={toggle} aria-label={playing ? "Pause" : "Play both"}>
          {playing ? <Pause size={16} /> : <Play size={16} />}
        </button>
        <span className="vr-time" data-time={t.toFixed(3)}>
          {formatTimecode(t)}
        </span>
        <input type="range" min={0} max={length} step={1 / 30} value={Math.min(t, length)} onChange={(e) => seek(Number(e.target.value))} aria-label="Time" />
        <div className="vl-seg" role="group" aria-label="Sound">
          <button type="button" className={sound === "cut" ? "on" : ""} onClick={() => setSound("cut")}>
            <Volume2 size={12} /> Cut
          </button>
          <button type="button" className={sound === "reference" ? "on" : ""} onClick={() => setSound("reference")}>
            <Volume2 size={12} /> Reference
          </button>
        </div>
      </div>
      <div className="vr-table-wrap">
        <table className="vr-table" data-testid="timing-table">
          <thead>
            <tr>
              <th>#</th>
              <th>Reference starts</th>
              <th>lasts</th>
              <th>Your cut starts</th>
              <th>lasts</th>
              <th>Off by</th>
              <th>Footage</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.index} className={i === current ? "on" : ""} onClick={() => seek(r.ours?.start ?? r.ref?.start ?? 0)}>
                <td>{r.index}</td>
                <td>{r.ref ? fmt(r.ref.start) : "–"}</td>
                <td>{r.ref ? fmt(r.ref.length) : "–"}</td>
                <td>{r.ours ? fmt(r.ours.start) : "–"}</td>
                <td>{r.ours ? fmt(r.ours.length) : "–"}</td>
                <td className={r.deltaFrames === null ? "" : Math.abs(r.deltaFrames) <= 1 ? "ok" : "off"}>{r.deltaFrames === null ? "–" : `${r.deltaFrames > 0 ? "+" : ""}${r.deltaFrames} fr`}</td>
                <td>{r.ours?.label ?? "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>,
    document.body,
  );
}
