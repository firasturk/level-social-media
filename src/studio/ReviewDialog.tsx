import { useEffect, useRef, useState } from "react";
import {
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Download,
  FolderDown,
  LoaderCircle,
  RefreshCw,
  ScanLine,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { QA, Source, Task } from "@shared/types";
import Zoomable from "./Zoomable";
import CompareSlider from "./CompareSlider";

/** One-click revision instructions; each appends to the edit box. */
const REVISION_PRESETS: { label: string; text: string }[] = [
  {
    label: "Blend with scene",
    text: "Light the product with the scene's own light: same direction, hardness and colour as the surroundings, real highlights and reflections on its materials, one shadow matching the scene's shadows plus a soft contact shadow at its base, the same grain and colour grade as the background, no cutout edges. Keep the product, the composition and the framing exactly.",
  },
  {
    label: "More brand colour",
    text: "Push the props, surfaces and light toward the brand palette; the product keeps its own exact colours.",
  },
  {
    label: "Cleaner background",
    text: "Simplify the background: fewer objects, no readable text, softer depth of field; keep the place and the light.",
  },
  {
    label: "Leave headline space",
    text: "Re-compose so roughly a third of the frame is a calm, low-detail, low-contrast area where a headline can sit; the product and the subject stay unchanged.",
  },
  {
    label: "Match product",
    text: "Match the product's shape, colours, label and packaging exactly to image 1; no restyling.",
  },
  {
    label: "Remove text",
    text: "Remove every letter, number, logo, sticker or watermark drawn in the image; keep the product's own printed packaging as in image 1.",
  },
  {
    label: "Brighter",
    text: "Make the scene brighter with soft natural light; keep the product colours accurate.",
  },
  {
    label: "Closer",
    text: "Move the camera closer so the product fills more of the frame; keep the scene and the light.",
  },
];

interface StoredBrief {
  scene?: string;
  pose?: string;
  light?: string;
  faceMode?: string;
  subject?: string;
}

interface StoredPlan {
  np: true;
  framing?: string;
  handsInPockets?: boolean;
  backView?: boolean;
  scene?: string;
  poseNotes?: string;
}

/** The task's stored brief: a skill brief, a No prompt plan, or nothing when absent or unreadable. */
function parseBrief(raw: string | null | undefined): StoredBrief | StoredPlan | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as unknown;
    if (!d || typeof d !== "object") return null;
    return d as StoredBrief | StoredPlan;
  } catch {
    return null;
  }
}

export default function ReviewDialog({
  task,
  source,
  busy,
  originalUrl,
  resultUrl,
  position,
  onClose,
  onRevise,
  onDownload,
  onDownloadSet,
  onSaveLook,
  onPrev,
  onNext,
}: {
  task: Task | null;
  source: Source | null;
  busy: boolean;
  originalUrl: string;
  resultUrl: string;
  position?: { index: number; total: number };
  onClose: () => void;
  onRevise: (edit: string) => Promise<void>;
  /** Save this one result to the computer; absent while there is no result yet. */
  onDownload?: () => void;
  /** Save every generated image of this product set as one ZIP; absent when the image is not in a set. */
  onDownloadSet?: () => void;
  /** Save this image's skill prompt as a reusable look; absent outside skill campaigns. */
  onSaveLook?: () => void;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const [view, setView] = useState<"compare" | "result" | "original">("compare");
  const [edit, setEdit] = useState("");
  const editRef = useRef<HTMLTextAreaElement>(null);
  const qa = task?.qa ? (JSON.parse(task.qa) as QA) : null;
  // The stored brief is a written skill brief in the skill approaches, or the No prompt plan
  // (background, pose, framing). Anything unreadable is simply not shown.
  const stored = parseBrief(task?.brief);
  const brief = stored && !("np" in stored) ? stored : null;
  const plan = stored && "np" in stored ? stored : null;
  const fabric = task?.card === 6;
  const inFlight = !!task && (task.status === "processing" || task.status === "queued");

  // Keyboard: R revise, arrows navigate, 1/2/3 switch views. Ignored while typing.
  useEffect(() => {
    if (!task) return;
    const onKey = (e: KeyboardEvent) => {
      const typing =
        (e.target as HTMLElement)?.tagName === "TEXTAREA" ||
        (e.target as HTMLElement)?.tagName === "INPUT";
      if (typing) return;
      if (e.key === "ArrowLeft" && onPrev) onPrev();
      else if (e.key === "ArrowRight" && onNext) onNext();
      else if (e.key === "r" || e.key === "R") editRef.current?.focus();
      else if (e.key === "1") setView("compare");
      else if (e.key === "2") setView("result");
      else if (e.key === "3") setView("original");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [task, onPrev, onNext, busy]);

  useEffect(() => setEdit(""), [task?.id]);

  return (
    <Dialog
      open={!!task}
      onOpenChange={(open) => {
        if (!open) {
          setEdit("");
          onClose();
        }
      }}
    >
      <DialogContent className="review-dialog">
        <DialogHeader>
          <DialogTitle>
            {source?.name}
            {position && (
              <span className="review-position">
                {position.index + 1} / {position.total}
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            Drag the slider to compare. Keys: ← → next image · R revise · 1/2/3 views.
          </DialogDescription>
        </DialogHeader>
        <div className="review-layout">
          <div>
            <div className="comparison-bar">
              <button
                className={view === "compare" ? "chosen" : ""}
                onClick={() => setView("compare")}
              >
                Compare
              </button>
              <button
                className={view === "result" ? "chosen" : ""}
                onClick={() => setView("result")}
              >
                AI result
              </button>
              <button
                className={view === "original" ? "chosen" : ""}
                onClick={() => setView("original")}
              >
                Original
              </button>
              <span className="nav-arrows">
                <button onClick={onPrev} disabled={!onPrev} aria-label="Previous image">
                  <ChevronLeft size={16} />
                </button>
                <button onClick={onNext} disabled={!onNext} aria-label="Next image">
                  <ChevronRight size={16} />
                </button>
              </span>
            </div>
            <div className="review-photo">
              {task && view === "compare" && (
                <CompareSlider
                  before={originalUrl}
                  after={resultUrl}
                  alt="Generated product photo"
                />
              )}
              {task && view !== "compare" && (
                <Zoomable
                  src={view === "original" ? originalUrl : resultUrl}
                  alt={view === "original" ? "Original product photo" : "Generated product photo"}
                  overlay={<div className="center-line" />}
                />
              )}
            </div>
          </div>
          <div className="revision-panel">
            <div className="qa-heading">
              <ScanLine size={18} />
              <strong>Image review</strong>
            </div>
            {qa && (
              <div className="qa-strip">
                <span className={`qa-chip ${fabric ? "" : qa.centered ? "pass" : "warn"}`}>
                  Alignment:{" "}
                  {fabric
                    ? "n/a"
                    : !qa.automated
                      ? "manual"
                      : qa.found
                        ? `${Number(qa.offset).toFixed(1)}% off`
                        : "check"}
                </span>
                <span className={`qa-chip ${qa.productConcern ? "warn" : "pass"}`}>
                  Fidelity:{" "}
                  {!qa.automated ? "manual" : qa.productConcern ? "check differences" : "ok"}
                </span>
                {qa.automated &&
                  qa.sameFace !== undefined &&
                  task &&
                  task.card > 1 &&
                  task.card < 6 && (
                    <span className={`qa-chip ${qa.sameFace ? "pass" : "warn"}`}>
                      Face: {qa.sameFace ? "same" : "different"}
                    </span>
                  )}
                {task && task.cost > 0 && (
                  <span className="qa-chip">≈ ${task.cost.toFixed(2)}</span>
                )}
                {qa.notes && <span className="qa-notes-inline">{qa.notes}</span>}
              </div>
            )}
            {plan && (
              <div className="brief-box">
                <strong>No prompt plan</strong>
                <span>
                  Framing: {(plan.framing ?? "full body").replace("_", " ").toLowerCase()}
                  {plan.backView ? " · back view" : ""}
                  {plan.handsInPockets ? " · hands in pockets" : ""}
                </span>
                {plan.scene && <span>Scene: {plan.scene}</span>}
                {plan.poseNotes && <span>Pose: {plan.poseNotes}</span>}
              </div>
            )}
            {brief && (
              <div className="brief-box">
                <strong>Skill brief</strong>
                <span>
                  {brief.subject}
                  {brief.faceMode ? ` · ${brief.faceMode.replace("_", " ").toLowerCase()}` : ""}
                </span>
                <span>Scene: {brief.scene}</span>
                <span>Pose: {brief.pose}</span>
                <span>Light: {brief.light}</span>
              </div>
            )}
            {task?.prompt && (
              <details className="prompt-details">
                <summary>Prompt used</summary>
                <pre>{task.prompt}</pre>
              </details>
            )}
            {task?.error && <p className="image-error">{task.error}</p>}

            {inFlight && (
              <p className="revision-progress">
                <LoaderCircle className="spinning" size={15} />
                {task?.status === "queued"
                  ? "A new version of this image is queued. "
                  : "A new version of this image is being generated. "}
                The current result stays until it arrives; with Economy mode this can take a while.
              </p>
            )}
            <label className="field-label" htmlFor="revision">
              Edit this result
            </label>
            <div className="preset-chips">
              {REVISION_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  disabled={busy}
                  onClick={() => setEdit((e) => (e ? `${e} ${p.text}` : p.text))}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <textarea
              id="revision"
              ref={editRef}
              rows={4}
              placeholder="e.g. Keep the outfit unchanged. Move the model to the exact centre and use a brighter urban background."
              value={edit}
              onChange={(e) => setEdit(e.target.value)}
              disabled={busy}
            />
            <button
              className="primary"
              onClick={() => onRevise(edit).then(() => setEdit(""))}
              disabled={busy || !edit.trim() || inFlight}
            >
              {busy ? <LoaderCircle className="spinning" size={17} /> : <RefreshCw size={17} />}
              {inFlight ? "Revision in progress…" : "Generate revision"}
            </button>
            <button
              className="secondary"
              onClick={onDownload}
              disabled={!onDownload}
              title="Save this AI result to your computer"
            >
              <Download size={17} />
              Download this image
            </button>
            {onDownloadSet && (
              <button className="secondary" onClick={onDownloadSet} disabled={busy}>
                <FolderDown size={17} />
                Download the set
              </button>
            )}
            {onSaveLook && (
              <button
                className="secondary"
                onClick={onSaveLook}
                disabled={busy}
                title="Keep this prompt to reuse the same scene, pose and light on other photos"
              >
                <Bookmark size={17} />
                Save prompt as a look
              </button>
            )}
            <span className="revision-note">
              Each revision is one more paid generation. Your original stays untouched.
            </span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
