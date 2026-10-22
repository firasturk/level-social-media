import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Download, Eraser, FlaskConical, ImagePlus, Play, Sun, Wand2, ZoomIn } from "lucide-react";
import { toast } from "sonner";
import { Orb } from "@/components/Orb";
import VoiceInput from "@/components/VoiceInput";
import { askConfirm } from "@/lib/confirm";
import { get, post } from "@/api";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import CompareSlider from "./CompareSlider";
import { formatUsd, type PhotoLabOp } from "@shared/pricing";
import type { DriveListing, DrivePhoto } from "@shared/drive";
import type { PhotoLabStatus } from "./FreepikConnection";

/**
 * Photo lab: Freepik's real-photo tools on the post's current picture or on one of the client's
 * approved Drive photos. Pick the source, the tool (with what it is good for and about what it
 * costs), a prompt for the two that take one, run (the cost is confirmed first), watch it, compare
 * before and after, then use the result as the post's picture, save it as a product photo of the
 * month or download it. With no Freepik key the panel says "Demo · Not connected" and the demo
 * result is the input itself.
 */

export interface PhotoLabJob {
  id: string;
  client: string;
  batch: string | null;
  post: number | null;
  op: PhotoLabOp;
  opLabel: string;
  prompt: string;
  inputLabel: string;
  status: "queued" | "running" | "done" | "failed";
  provider: "freepik" | "demo";
  demo: boolean;
  cost: number;
  error: string | null;
  input: string;
  output: string | null;
  created: number;
  updated: number;
}

type Source = { kind: "task"; batch: string; id: string } | { kind: "drive"; id: string } | { kind: "job"; id: string };

const OPS: { id: PhotoLabOp; label: string; why: string; icon: typeof Eraser; prompt?: string }[] = [
  { id: "remove-bg", label: "Remove background", why: "A clean cut-out of the product on transparency, for packshots and collages.", icon: Eraser },
  {
    id: "background",
    label: "Replace background",
    why: "The real product kept as it is, set into a new scene you describe; the light is matched.",
    icon: ImagePlus,
    prompt: "Describe the new scene: a marble counter in soft morning light, a wooden table by a window…",
  },
  { id: "relight", label: "Relight", why: "Fix flat or mixed light on a real photo without changing the product.", icon: Sun, prompt: "Describe the light: warm evening light from the left, soft studio light…" },
  { id: "upscale", label: "Upscale", why: "A small or soft photo made sharp at twice the size, for print and large posts.", icon: ZoomIn },
];

const photoUrl = (id: string, size: number) => `/api/studio/drive/photo/${encodeURIComponent(id)}?size=${size}`;

export interface PhotoLabPanelProps {
  clientId: string;
  /** The month, for "Use as the post's picture" and "Save as a product photo". */
  batchId?: string | null;
  /** The post whose picture is edited, with its current picture, when the panel is in the editor. */
  post?: number;
  task?: { id: string; imageUrl: string } | null;
  /** Opened on a Drive photo (from the Drive picker). */
  initialDrive?: { id: string; name: string } | null;
  /** The month changed (a picture replaced, a product added). */
  onChanged?: () => void | Promise<void>;
}

export default function PhotoLabPanel({ clientId, batchId, post: postIndex, task, initialDrive, onChanged }: PhotoLabPanelProps) {
  const [status, setStatus] = useState<PhotoLabStatus | null>(null);
  const [tab, setTab] = useState<"post" | "drive">(task && !initialDrive ? "post" : "drive");
  const [driveId, setDriveId] = useState(initialDrive?.id ?? "");
  const [drive, setDrive] = useState<DriveListing | null>(null);
  const [driveError, setDriveError] = useState("");
  const [chainJob, setChainJob] = useState<PhotoLabJob | null>(null);
  const [op, setOp] = useState<PhotoLabOp>("remove-bg");
  const [prompt, setPrompt] = useState("");
  const [job, setJob] = useState<PhotoLabJob | null>(null);
  const [history, setHistory] = useState<PhotoLabJob[]>([]);
  const [running, setRunning] = useState(false);
  const [using, setUsing] = useState<"picture" | "product" | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let alive = true;
    get<PhotoLabStatus>("/api/studio/photolab/status")
      .then((s) => alive && setStatus(s))
      .catch(() => alive && setStatus(null));
    return () => {
      alive = false;
    };
  }, []);

  const loadHistory = useCallback(() => {
    get<{ jobs: PhotoLabJob[] }>(`/api/studio/photolab/jobs?client=${encodeURIComponent(clientId)}`)
      .then((r) => setHistory(r.jobs.filter((j) => j.status === "done").slice(0, 12)))
      .catch(() => undefined);
  }, [clientId]);
  useEffect(loadHistory, [loadHistory]);

  // The Drive product photos, read once the Drive tab is open.
  useEffect(() => {
    if (tab !== "drive" || drive) return;
    get<DriveListing>(`/api/studio/drive/${encodeURIComponent(clientId)}`)
      .then((r) => setDrive(r))
      .catch((e) => setDriveError((e as Error).message));
  }, [tab, drive, clientId]);
  const drivePhotos: DrivePhoto[] = useMemo(() => (drive?.groups?.product ?? []).filter((p) => !p.missing && !p.video), [drive]);

  // A running job is asked about every few seconds until it lands.
  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    if (!job || job.status !== "running") return;
    timer.current = window.setTimeout(() => {
      get<{ job: PhotoLabJob }>(`/api/studio/photolab/jobs/${job.id}`)
        .then((r) => {
          setJob(r.job);
          if (r.job.status === "done") {
            toast.success(`${r.job.opLabel} done.`);
            loadHistory();
          } else if (r.job.status === "failed") toast.error(r.job.error || `${r.job.opLabel} failed.`);
        })
        .catch((e) => toast.error((e as Error).message));
    }, 2500);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [job, loadHistory]);

  const demo = !status?.connected;
  const source: Source | null = chainJob
    ? { kind: "job", id: chainJob.id }
    : tab === "post"
      ? task && batchId
        ? { kind: "task", batch: batchId, id: task.id }
        : null
      : driveId
        ? { kind: "drive", id: driveId }
        : null;
  const sourceLabel = chainJob
    ? `the result of ${chainJob.opLabel.toLowerCase()}`
    : tab === "post"
      ? postIndex != null
        ? `post ${postIndex}'s picture`
        : "the picture"
      : drivePhotos.find((p) => p.id === driveId)?.name || initialDrive?.name || "the Drive photo";
  const chosen = OPS.find((o) => o.id === op)!;
  const cost = status?.prices?.[op] ?? 0;
  const needsPrompt = op === "background";

  async function runTool() {
    if (!source) return;
    if (needsPrompt && !prompt.trim()) {
      toast.error("Describe the new background first.");
      return;
    }
    if (!demo) {
      const ok = await askConfirm(
        `${chosen.label} on ${sourceLabel} costs about ${formatUsd(cost)} on Freepik (approximate: Freepik bills credits per call). Run it?`,
        { ok: `Run · about ${formatUsd(cost)}`, danger: false, cancel: "Not now" },
      );
      if (!ok) return;
    }
    setRunning(true);
    try {
      const r = await post<{ job: PhotoLabJob }>("/api/studio/photolab/run", { client: clientId, source, op, prompt: prompt.trim() || undefined });
      setJob(r.job);
      if (r.job.status === "done") {
        toast.success(`${r.job.opLabel} done${r.job.demo ? " (demo)" : ""}.`);
        loadHistory();
      } else if (r.job.status === "failed") toast.error(r.job.error || `${r.job.opLabel} failed.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRunning(false);
    }
  }

  async function applyResult(as: "picture" | "product") {
    if (!job || !batchId) return;
    setUsing(as);
    try {
      if (as === "picture") {
        await post(`/api/studio/photolab/jobs/${job.id}/use`, { as, batch: batchId, post: postIndex });
        toast.success(`Post ${postIndex}'s picture replaced. The previous one is under Versions.`);
      } else {
        const r = await post<{ source: { name: string } }>(`/api/studio/photolab/jobs/${job.id}/use`, { as, batch: batchId });
        toast.success(`Saved as a product photo of the month: ${r.source.name}.`);
      }
      await onChanged?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUsing(null);
    }
  }

  function chain() {
    if (!job?.output) return;
    setChainJob(job);
    setJob(null);
    setPrompt("");
  }

  return (
    <div className="photolab-panel">
      <div className="photolab-head">
        <strong>
          <FlaskConical size={15} /> Photo lab
        </strong>
        {status === null ? (
          <span className="photolab-chip">Checking the connection…</span>
        ) : demo ? (
          <span className="photolab-chip off" title={status.reason}>
            Demo · Not connected
          </span>
        ) : (
          <span className="photolab-chip on">Freepik connected</span>
        )}
      </div>
      {demo && status && <p className="field-hint">{status.reason}</p>}

      <div className="photolab-section">
        <span className="field-label">Picture</span>
        {chainJob ? (
          <div className="photolab-chain">
            <img src={chainJob.output ?? chainJob.input} alt="" />
            <span>
              Working on the result of <b>{chainJob.opLabel.toLowerCase()}</b> ({chainJob.inputLabel}).
            </span>
            <button type="button" className="text-button" onClick={() => setChainJob(null)}>
              Pick another picture
            </button>
          </div>
        ) : (
          <>
            <div className="photolab-tabs" role="tablist">
              {task && (
                <button type="button" role="tab" aria-selected={tab === "post"} className={tab === "post" ? "on" : ""} onClick={() => setTab("post")}>
                  This post's picture
                </button>
              )}
              <button type="button" role="tab" aria-selected={tab === "drive"} className={tab === "drive" ? "on" : ""} onClick={() => setTab("drive")}>
                Client's Drive photos
              </button>
            </div>
            {tab === "post" && task && (
              <div className="photolab-current">
                <img src={task.imageUrl} alt={`Post ${postIndex} picture`} />
                <span>The picture as it is now.</span>
              </div>
            )}
            {tab === "drive" &&
              (driveError ? (
                <p className="image-error">{driveError}</p>
              ) : !drive ? (
                <div className="journey-reading">
                  <Orb size={16} /> Opening the Drive folders…
                </div>
              ) : drivePhotos.length === 0 ? (
                <p className="field-hint">No product photos in the client's Drive{drive.demo ? " (demo listing)" : ""}.</p>
              ) : (
                <div className="photolab-thumbs">
                  {drivePhotos.slice(0, 60).map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={`journey-thumb pick ${driveId === p.id ? "on" : ""}`}
                      onClick={() => setDriveId(driveId === p.id ? "" : p.id)}
                      title={`${p.folder ? `${p.folder} / ` : ""}${p.file}`}
                    >
                      <img src={photoUrl(p.id, 240)} alt={p.name} loading="lazy" />
                      <figcaption>{p.name}</figcaption>
                      {driveId === p.id && (
                        <span className="journey-thumb-check">
                          <Check size={14} />
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              ))}
          </>
        )}
      </div>

      <div className="photolab-section">
        <span className="field-label">Tool</span>
        <div className="photolab-ops" role="radiogroup">
          {OPS.map((o) => {
            const Icon = o.icon;
            const price = status?.prices?.[o.id];
            return (
              <button key={o.id} type="button" role="radio" aria-checked={op === o.id} className={`photolab-op ${op === o.id ? "on" : ""}`} onClick={() => setOp(o.id)}>
                <Icon size={16} />
                <span>
                  <b>{o.label}</b>
                  <small>{o.why}</small>
                </span>
                <em>{demo ? "demo · free" : price != null ? `about ${formatUsd(price)}` : ""}</em>
              </button>
            );
          })}
        </div>
        {chosen.prompt && (
          <div className="photolab-prompt">
            <textarea
              rows={2}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={chosen.prompt}
              aria-label={needsPrompt ? "The new background" : "The light wanted (optional)"}
              maxLength={1000}
            />
            <VoiceInput compact onText={(t) => setPrompt((p) => (p ? `${p} ${t}` : t))} />
          </div>
        )}
        <div className="photolab-actions">
          <button type="button" className="primary" disabled={!source || running || status === null} onClick={() => void runTool()}>
            {running ? <Orb size={16} /> : <Play size={16} />}
            {running ? "Sending…" : demo ? `Run ${chosen.label.toLowerCase()} (demo)` : `Run ${chosen.label.toLowerCase()} · about ${formatUsd(cost)}`}
          </button>
          {!source && <span className="field-hint">Pick a picture first.</span>}
        </div>
      </div>

      {job && (
        <div className="photolab-section photolab-result">
          <div className="photolab-head">
            <strong>
              {job.opLabel}
              {job.prompt ? `: ${job.prompt}` : ""}
            </strong>
            {job.demo ? <span className="photolab-chip off">Demo · Not connected</span> : <span className="photolab-chip">about {formatUsd(job.cost)}</span>}
          </div>
          {job.status === "running" && (
            <p className="revision-progress">
              <Orb size={14} /> Freepik is working on {job.inputLabel.toLowerCase()}… this takes a few seconds to a minute.
            </p>
          )}
          {job.status === "failed" && <p className="image-error">{job.error || "The tool failed."}</p>}
          {job.status === "done" && job.output && (
            <>
              <CompareSlider before={job.input} after={job.output} alt={`${job.opLabel} result`} />
              {job.demo && <p className="field-hint">A demo result: the same picture, so the flow can be tried. Connect Freepik to get the real tool.</p>}
              <div className="photolab-actions">
                {batchId && postIndex != null && task && (
                  <button type="button" className="primary" disabled={!!using} onClick={() => void applyResult("picture")}>
                    {using === "picture" ? <Orb size={16} /> : <Check size={16} />} Use as the post's picture
                  </button>
                )}
                {batchId && (
                  <button type="button" className="secondary" disabled={!!using} onClick={() => void applyResult("product")}>
                    {using === "product" ? <Orb size={16} /> : <ImagePlus size={16} />} Save as a product photo
                  </button>
                )}
                <a className="secondary button-link" href={job.output} download={`photo-lab-${job.op}.${job.output.includes("svg") ? "svg" : "png"}`}>
                  <Download size={16} /> Download
                </a>
                <button type="button" className="text-button" onClick={chain}>
                  <Wand2 size={14} /> Run another tool on this result
                </button>
              </div>
            </>
          )}
        </div>
      )}

      {history.length > 0 && (
        <details className="photolab-history">
          <summary>Earlier results ({history.length})</summary>
          <div className="photolab-thumbs">
            {history.map((h) => (
              <button key={h.id} type="button" className={`journey-thumb pick ${job?.id === h.id ? "on" : ""}`} onClick={() => setJob(h)} title={`${h.opLabel} · ${h.inputLabel}${h.demo ? " · demo" : ""}`}>
                <img src={h.output ?? h.input} alt={h.opLabel} loading="lazy" />
                <figcaption>
                  {h.opLabel}
                  {h.demo ? " · demo" : ""}
                </figcaption>
              </button>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/* ───────────── Opening the lab on a Drive photo, from anywhere ───────────── */

export interface PhotoLabOpen {
  client: string;
  photoId: string;
  name: string;
  batch?: string | null;
}
const EVENT = "photolab:open";

/** Asks the mounted PhotoLabDialog to open on this Drive photo. */
export function openPhotoLab(detail: PhotoLabOpen): void {
  window.dispatchEvent(new CustomEvent<PhotoLabOpen>(EVENT, { detail }));
}

/** Mounted once in the studio: shows the Photo lab on the Drive photo `openPhotoLab` named. */
export function PhotoLabDialog({ onChanged }: { onChanged?: () => void | Promise<void> }) {
  const [open, setOpen] = useState<PhotoLabOpen | null>(null);
  useEffect(() => {
    const on = (e: Event) => setOpen((e as CustomEvent<PhotoLabOpen>).detail);
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return (
    <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
      <DialogContent className="photolab-dialog">
        <DialogHeader>
          <DialogTitle>Photo lab</DialogTitle>
          <DialogDescription>Freepik's real-photo tools on {open?.name ?? "the photo"}: remove or replace the background, relight, upscale.</DialogDescription>
        </DialogHeader>
        {open && <PhotoLabPanel key={open.photoId} clientId={open.client} batchId={open.batch ?? null} initialDrive={{ id: open.photoId, name: open.name }} onChanged={onChanged} />}
      </DialogContent>
    </Dialog>
  );
}
