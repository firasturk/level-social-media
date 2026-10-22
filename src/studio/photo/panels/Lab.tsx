/**
 * Photo lab: Freepik's four real-photo tools as cards, the picture source (this post's picture, the
 * client's Drive photos, an earlier result), the estimate and the confirm, the result compared on
 * the canvas, "Use as the post's picture" / "Save as a product photo". The logic is `usePhotoLab`,
 * shared with the post editor's panel. Admins only for now: a member sees the note and no controls.
 */
import { useEffect } from "react";
import { Check, Download, ImagePlus, Lock, Play, Wand2 } from "lucide-react";
import { Orb } from "@/components/Orb";
import VoiceInput from "@/components/VoiceInput";
import { formatUsd } from "@shared/pricing";
import { drivePhotoUrl, PHOTO_LAB_OPS } from "../../photolab/usePhotoLab";
import type { StudioCtx } from "../types";

export default function LabPanel({ ctx }: { ctx: StudioCtx }) {
  const lab = ctx.lab;
  const { status, demo, access, locked, job } = lab;
  const { setView } = ctx;

  // A finished result goes on the canvas, before and after.
  useEffect(() => {
    if (job?.status === "done" && job.output) setView({ kind: "compare", before: job.input, after: job.output, beforeLabel: "Before", afterLabel: job.opLabel });
  }, [job, setView]);

  return (
    <div className="ps-panel">
      <div className="ts-panel-head">
        <span>Photo lab</span>
        {status === null ? <small>Checking…</small> : demo ? <small title={status.reason}>Demo · not connected</small> : <small className="ps-ok">Freepik connected</small>}
      </div>
      <p className="ts-hint ps-lab-note">
        Magnific's own tools, paid in credits, are under{" "}
        <button type="button" className="ts-link" onClick={() => ctx.openPanel("tools")}>
          AI tools
        </button>
        .
      </p>
      {locked && access && (
        <div className="ps-locked" role="note">
          <Lock size={14} />
          <div>
            <b>{access.admin ? "Switched off" : "Admins only for now"}</b>
            <p>{access.reason || "The Photo lab runs a paid provider; an admin opens it for the team once it is approved."}</p>
          </div>
        </div>
      )}
      {!locked && demo && status && <p className="ts-hint">{status.reason}</p>}

      {!locked && (
        <>
          <span className="ts-group-title">Picture</span>
          {lab.chainJob ? (
            <div className="ps-source-chain">
              <img src={lab.chainJob.output ?? lab.chainJob.input} alt="" />
              <span>
                The result of <b>{lab.chainJob.opLabel.toLowerCase()}</b> ({lab.chainJob.inputLabel}).
              </span>
              <button type="button" className="ts-link" onClick={() => lab.setChainJob(null)}>
                Pick another picture
              </button>
            </div>
          ) : (
            <>
              <div className="ps-seg" role="tablist" aria-label="Picture source">
                <button type="button" role="tab" aria-selected={lab.tab === "post"} className={lab.tab === "post" ? "on" : ""} onClick={() => lab.setTab("post")}>
                  This post's picture
                </button>
                <button type="button" role="tab" aria-selected={lab.tab === "drive"} className={lab.tab === "drive" ? "on" : ""} onClick={() => lab.setTab("drive")}>
                  Client's Drive photos
                </button>
              </div>
              {lab.tab === "post" && <p className="ts-hint">The picture as it is now, on the canvas.</p>}
              {lab.tab === "drive" &&
                (lab.driveError ? (
                  <p className="ts-hint warn">{lab.driveError}</p>
                ) : !lab.drive ? (
                  <p className="ts-hint">
                    <Orb size={14} /> Opening the Drive folders…
                  </p>
                ) : lab.drivePhotos.length === 0 ? (
                  <p className="ts-hint">No product photos in the client's Drive{lab.drive.demo ? " (demo listing)" : ""}.</p>
                ) : (
                  <div className="ps-thumbs">
                    {lab.drivePhotos.slice(0, 60).map((p) => (
                      <button key={p.id} type="button" className={`ps-thumb ${lab.driveId === p.id ? "on" : ""}`} onClick={() => lab.setDriveId(lab.driveId === p.id ? "" : p.id)} title={`${p.folder ? `${p.folder} / ` : ""}${p.file}`}>
                        <img src={drivePhotoUrl(p.id, 240)} alt={p.name} loading="lazy" />
                        <span>{p.name}</span>
                        {lab.driveId === p.id && <Check size={14} className="ps-thumb-check" />}
                      </button>
                    ))}
                  </div>
                ))}
            </>
          )}

          <span className="ts-group-title">Tool</span>
          <div className="ps-cards" role="radiogroup" aria-label="Tool">
            {PHOTO_LAB_OPS.map((o) => {
              const Icon = o.icon;
              const price = status?.prices?.[o.id];
              return (
                <button key={o.id} type="button" role="radio" aria-checked={lab.op === o.id} className={`ps-card ${lab.op === o.id ? "on" : ""}`} onClick={() => lab.setOp(o.id)}>
                  <Icon size={18} />
                  <span>
                    <b>{o.label}</b>
                    <small>{o.why}</small>
                  </span>
                  <em>{demo ? "demo · free" : price != null ? `about ${formatUsd(price)}` : ""}</em>
                </button>
              );
            })}
          </div>
          {lab.chosen.prompt && (
            <div className="ps-prompt">
              <textarea rows={2} value={lab.prompt} onChange={(e) => lab.setPrompt(e.target.value)} placeholder={lab.chosen.prompt} aria-label={lab.needsPrompt ? "The new background" : "The light wanted (optional)"} maxLength={1000} />
              <VoiceInput compact onText={(t) => lab.setPrompt(lab.prompt ? `${lab.prompt} ${t}` : t)} />
            </div>
          )}
          <button type="button" className="ts-btn primary ps-cta" disabled={!lab.source || lab.running || status === null} onClick={() => void lab.runTool()}>
            {lab.running ? <Orb size={15} /> : <Play size={15} />}
            {lab.running ? "Sending…" : demo ? `Run ${lab.chosen.label.toLowerCase()} (demo)` : `Run ${lab.chosen.label.toLowerCase()} · about ${formatUsd(lab.cost)}`}
          </button>
          {!lab.source && <p className="ts-hint">Pick a picture first.</p>}
          <p className="ts-hint">The estimate is written to the ledger first and you confirm it; the same request then runs. Nothing is sent before you confirm.</p>
        </>
      )}

      {job && (
        <div className="ps-result">
          <span className="ts-group-title">
            Result · {job.opLabel}
            {job.prompt ? `: ${job.prompt}` : ""}
            {job.demo ? " · demo" : ` · about ${formatUsd(job.cost)}`}
          </span>
          {job.status === "running" && (
            <p className="ts-hint">
              <Orb size={14} /> Freepik is working on {job.inputLabel.toLowerCase()}… a few seconds to a minute.
            </p>
          )}
          {job.status === "failed" && <p className="ts-hint warn">{job.error || "The tool failed."}</p>}
          {job.status === "done" && job.output && (
            <>
              <p className="ts-hint">Before and after are on the canvas: drag the slider.{job.demo ? " A demo result: the same picture, so the flow can be tried." : ""}</p>
              <div className="ps-row ps-wrap">
                {lab.canUseAsPicture && (
                  <button type="button" className="ts-btn primary" disabled={!!lab.using} onClick={() => void lab.applyResult("picture")}>
                    {lab.using === "picture" ? <Orb size={14} /> : <Check size={14} />} Use as the post's picture
                  </button>
                )}
                {lab.canSaveAsProduct && (
                  <button type="button" className="ts-btn" disabled={!!lab.using} onClick={() => void lab.applyResult("product")}>
                    {lab.using === "product" ? <Orb size={14} /> : <ImagePlus size={14} />} Save as a product photo
                  </button>
                )}
                <a className="ts-btn" href={job.output} download={`photo-lab-${job.op}.${job.output.includes("svg") ? "svg" : "png"}`}>
                  <Download size={14} /> Download
                </a>
                {!locked && (
                  <button type="button" className="ts-link" onClick={lab.chain}>
                    <Wand2 size={13} /> Run another tool on this result
                  </button>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {lab.history.length > 0 && (
        <details className="ps-details">
          <summary>Earlier results ({lab.history.length})</summary>
          <div className="ps-thumbs">
            {lab.history.map((h) => (
              <button key={h.id} type="button" className={`ps-thumb ${job?.id === h.id ? "on" : ""}`} onClick={() => lab.setJob(h)} title={`${h.opLabel} · ${h.inputLabel}${h.demo ? " · demo" : ""}`}>
                <img src={h.output ?? h.input} alt={h.opLabel} loading="lazy" />
                <span>
                  {h.opLabel}
                  {h.demo ? " · demo" : ""}
                </span>
              </button>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}
