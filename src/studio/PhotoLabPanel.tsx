import { useEffect, useState } from "react";
import { Check, Download, FlaskConical, ImagePlus, Play, Wand2 } from "lucide-react";
import { Orb } from "@/components/Orb";
import VoiceInput from "@/components/VoiceInput";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import CompareSlider from "./CompareSlider";
import { formatUsd } from "@shared/pricing";
import { drivePhotoUrl, PHOTO_LAB_OPS, usePhotoLab, type PhotoLabOptions } from "./photolab/usePhotoLab";

export type { PhotoLabJob } from "./photolab/usePhotoLab";

/**
 * Photo lab: Freepik's real-photo tools on the post's current picture or on one of the client's
 * approved Drive photos. Pick the source, the tool (with what it is good for and about what it
 * costs), a prompt for the two that take one, run (the cost is confirmed first), watch it, compare
 * before and after, then use the result as the post's picture, save it as a product photo of the
 * month or download it. With no Freepik key the panel says "Demo · Not connected" and the demo
 * result is the input itself. The logic lives in `usePhotoLab`, shared with the Photo studio.
 *
 * Admins only for now: a member sees the entry point and the note, no controls.
 */

export type PhotoLabPanelProps = PhotoLabOptions;

export default function PhotoLabPanel(props: PhotoLabPanelProps) {
  const { task, post: postIndex } = props;
  const lab = usePhotoLab(props);
  const { status, demo, access, locked, tab, setTab, driveId, setDriveId, drive, driveError, drivePhotos, chainJob, setChainJob, op, setOp, prompt, setPrompt, job, setJob, history, running, using, source, chosen, cost, needsPrompt } = lab;

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
      {locked && access && (
        <p className="quality-note photolab-locked">
          <b>{access.admin ? "Switched off" : "Admins only for now"}.</b> {access.reason}
        </p>
      )}
      {!locked && demo && status && <p className="field-hint">{status.reason}</p>}

      {!locked && (
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
                      <img src={drivePhotoUrl(p.id, 240)} alt={p.name} loading="lazy" />
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
      )}

      {!locked && (
      <div className="photolab-section">
        <span className="field-label">Tool</span>
        <div className="photolab-ops" role="radiogroup">
          {PHOTO_LAB_OPS.map((o) => {
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
          <button type="button" className="primary" disabled={!source || running || status === null} onClick={() => void lab.runTool()}>
            {running ? <Orb size={16} /> : <Play size={16} />}
            {running ? "Sending…" : demo ? `Run ${chosen.label.toLowerCase()} (demo)` : `Run ${chosen.label.toLowerCase()} · about ${formatUsd(cost)}`}
          </button>
          {!source && <span className="field-hint">Pick a picture first.</span>}
        </div>
      </div>
      )}

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
                {lab.canUseAsPicture && (
                  <button type="button" className="primary" disabled={!!using} onClick={() => void lab.applyResult("picture")}>
                    {using === "picture" ? <Orb size={16} /> : <Check size={16} />} Use as the post's picture
                  </button>
                )}
                {lab.canSaveAsProduct && (
                  <button type="button" className="secondary" disabled={!!using} onClick={() => void lab.applyResult("product")}>
                    {using === "product" ? <Orb size={16} /> : <ImagePlus size={16} />} Save as a product photo
                  </button>
                )}
                <a className="secondary button-link" href={job.output} download={`photo-lab-${job.op}.${job.output.includes("svg") ? "svg" : "png"}`}>
                  <Download size={16} /> Download
                </a>
                {!locked && (
                  <button type="button" className="text-button" onClick={lab.chain}>
                    <Wand2 size={14} /> Run another tool on this result
                  </button>
                )}
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
