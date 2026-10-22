import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, FolderUp } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { get, post } from "@/api";
import { canvasBlob, facesOf, loadImage, renderOverlay } from "@/lib/overlay";
import type { OverlaySpec } from "@shared/overlay";
import type { Approval } from "@shared/config";
import { monthLabel, type Post } from "@shared/posts";
import type { Task } from "@shared/types";

/** How many composed pictures go in one request (each is a 1080 px JPEG as a data URL). */
const CHUNK = 4;
const WIDTH = 1080;
const QUALITY = 0.9;

interface Status {
  ok: true;
  email: string | null;
  folder: { id: string; name: string; link: string } | null;
  writable: boolean;
  reason: string | null;
}

interface Delivered {
  post: number | null;
  kind: "picture" | "captions";
  name: string;
  webViewLink: string;
  updated: boolean;
}

interface DeliverAnswer {
  folder: { id: string; name: string; webViewLink: string; created: boolean };
  files: Delivered[];
}

type Step =
  | { state: "waiting" }
  | { state: "composing" }
  | { state: "uploading" }
  | { state: "done"; name: string; link: string; updated: boolean }
  | { state: "failed"; error: string };

const STEP_LABEL: Record<Step["state"], string> = {
  waiting: "Waiting",
  composing: "Composing the artwork",
  uploading: "Uploading to Drive",
  done: "In Drive",
  failed: "Failed",
};

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((ok, no) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => no(new Error("The picture could not be read."));
    r.readAsDataURL(blob);
  });
}

/**
 * "Deliver to the client's Drive": the month's final posts, composed in the browser like the export
 * (words and logo over the picture), written into the client's Outputs folder with a captions.txt.
 */
export default function DeliverDialog({
  open,
  onClose,
  clientId,
  batchId,
  month,
  plan,
  tasks,
  approvals,
  overlay,
  logoSrc,
  outputUrl,
}: {
  open: boolean;
  onClose: () => void;
  clientId: string;
  batchId: string;
  month: string;
  plan: Post[];
  tasks: Task[];
  approvals: Record<string, Approval> | undefined;
  overlay: OverlaySpec;
  logoSrc: string | null;
  outputUrl: (t: Task) => string;
}) {
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState("");
  const [earlier, setEarlier] = useState<{
    folder: { webViewLink: string } | null;
    files: Delivered[];
  } | null>(null);
  const [scope, setScope] = useState<"approved" | "all">("all");
  const [captions, setCaptions] = useState(true);
  const [running, setRunning] = useState(false);
  const [steps, setSteps] = useState<Record<number, Step>>({});
  const [captionsStep, setCaptionsStep] = useState<Step | null>(null);
  const [folderLink, setFolderLink] = useState("");
  const [failure, setFailure] = useState("");

  const approvedCount = plan.filter(
    (p) => approvals?.[String(p.index)]?.status === "approved",
  ).length;
  const anyApproval = Object.keys(approvals ?? {}).length > 0;

  // Only posts of the current plan that have a picture: a plan cut from 12 to 6 leaves the old images behind.
  const made = plan
    .filter((p) => tasks.some((t) => t.post === p.index && !!t.output))
    .sort((a, b) => a.index - b.index);
  const approvedMade = made.filter((p) => approvals?.[String(p.index)]?.status === "approved");
  const chosen = scope === "approved" ? approvedMade : made;

  useEffect(() => {
    if (!open) return;
    setStatus(null);
    setStatusError("");
    setSteps({});
    setCaptionsStep(null);
    setFolderLink("");
    setFailure("");
    setScope(anyApproval ? "approved" : "all");
    get<Status>(`/api/studio/drive/delivery/${clientId}/status`)
      .then(setStatus)
      .catch((e: Error) => setStatusError(e.message));
    get<{ folder: { webViewLink: string } | null; files: Delivered[] }>(
      `/api/studio/drive/delivery/${clientId}/deliveries?batch=${encodeURIComponent(batchId)}`,
    )
      .then(setEarlier)
      .catch(() => setEarlier(null));
  }, [open, clientId, batchId, anyApproval]);

  /** The final artwork of a post, exactly as the export composes it, as a 1080 px JPEG data URL. */
  async function compose(p: Post, t: Task): Promise<string> {
    const withText =
      overlay.template !== "none" && p.overlay !== false && !!(p.headline || p.subline || logoSrc);
    let canvas: HTMLCanvasElement;
    if (withText)
      canvas = await renderOverlay(
        outputUrl(t),
        overlay,
        { headline: p.headline, subline: p.subline },
        logoSrc,
        WIDTH,
        {
          patch: p.ov,
          faces: facesOf(t.qa),
        },
      );
    else {
      const img = await loadImage(outputUrl(t));
      canvas = document.createElement("canvas");
      canvas.width = WIDTH;
      canvas.height = Math.round((WIDTH * img.naturalHeight) / img.naturalWidth);
      canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    }
    return blobToDataUrl(await canvasBlob(canvas, QUALITY));
  }

  async function deliver() {
    if (running || !chosen.length) return;
    setRunning(true);
    setFailure("");
    setFolderLink("");
    setCaptionsStep(null);
    const mark = (index: number, step: Step) => setSteps((s) => ({ ...s, [index]: step }));
    setSteps(Object.fromEntries(chosen.map((p) => [p.index, { state: "waiting" }])));
    let delivered = 0;
    let updated = 0;
    try {
      for (let i = 0; i < chosen.length; i += CHUNK) {
        const chunk = chosen.slice(i, i + CHUNK);
        const last = i + CHUNK >= chosen.length;
        const posts: { index: number; image: string }[] = [];
        for (const p of chunk) {
          mark(p.index, { state: "composing" });
          const t = tasks.find((x) => x.post === p.index && !!x.output)!;
          posts.push({ index: p.index, image: await compose(p, t) });
        }
        for (const p of chunk) mark(p.index, { state: "uploading" });
        if (last && captions) setCaptionsStep({ state: "uploading" });
        const answer = await post<DeliverAnswer>(`/api/studio/drive/delivery/${clientId}/deliver`, {
          batch: batchId,
          posts,
          captions: last && captions,
        });
        setFolderLink(answer.folder.webViewLink);
        for (const f of answer.files) {
          const step: Step = {
            state: "done",
            name: f.name,
            link: f.webViewLink,
            updated: f.updated,
          };
          if (f.kind === "captions") setCaptionsStep(step);
          else if (f.post !== null) {
            mark(f.post, step);
            delivered += 1;
            if (f.updated) updated += 1;
          }
        }
      }
      toast.success(
        updated
          ? `${delivered} posts delivered to Drive (${updated} updated in place).`
          : `${delivered} posts delivered to Drive.`,
      );
    } catch (e) {
      const message = (e as Error).message;
      setFailure(message);
      setSteps((s) => {
        const out = { ...s };
        for (const [k, v] of Object.entries(out))
          if (v.state === "composing" || v.state === "uploading" || v.state === "waiting")
            out[Number(k)] = { state: "failed", error: message };
        return out;
      });
      setCaptionsStep((c) => (c && c.state !== "done" ? { state: "failed", error: message } : c));
    } finally {
      setRunning(false);
    }
  }

  const copyEmail = () => {
    if (!status?.email) return;
    void navigator.clipboard.writeText(status.email).then(() => toast.success("Copied."));
  };

  const canDeliver = !!status?.writable && chosen.length > 0 && !running;
  const started = Object.keys(steps).length > 0;

  return (
    <Dialog open={open} onOpenChange={(o) => !o && !running && onClose()}>
      <DialogContent className="deliver-dialog">
        <DialogHeader>
          <DialogTitle>
            <FolderUp size={18} /> Deliver {monthLabel(month)} to the client&apos;s Drive
          </DialogTitle>
          <DialogDescription>
            The final artwork of each post (words and logo on the picture, 1080 px JPEG) goes into a
            month folder inside the client&apos;s Outputs folder, with a captions.txt. Delivering
            again updates the same files.
          </DialogDescription>
        </DialogHeader>

        <section className="deliver-folder">
          <span className="deliver-label">Outputs folder</span>
          {!status && !statusError && <p className="deliver-muted">Checking the Outputs folder…</p>}
          {statusError && <p className="deliver-problem">{statusError}</p>}
          {status && !status.folder && (
            <div className="deliver-problem">
              <p>No Outputs folder is approved for this client.</p>
              <p>{status.reason}</p>
              <p className="deliver-muted">
                Open the Drive picker (the Drive step of the month), add the folder the client wants
                deliveries in, give it the role Outputs and approve it. Then come back here.
              </p>
            </div>
          )}
          {status?.folder && (
            <div className="deliver-folder-row">
              <a
                href={status.folder.link}
                target="_blank"
                rel="noreferrer"
                className="deliver-link"
              >
                {status.folder.name || status.folder.id} <ExternalLink size={13} />
              </a>
              {status.writable ? (
                <span className="deliver-ok">
                  <Check size={13} /> The studio can write here
                </span>
              ) : (
                <span className="deliver-bad">Not writable</span>
              )}
            </div>
          )}
          {status?.folder && !status.writable && (
            <div className="deliver-problem">
              <p>{status.reason}</p>
              {status.email && (
                <p className="deliver-email">
                  <code>{status.email}</code>
                  <button type="button" className="text-button" onClick={copyEmail}>
                    <Copy size={13} /> Copy
                  </button>
                </p>
              )}
            </div>
          )}
          {earlier?.files.length ? (
            <p className="deliver-muted">
              Delivered before: {earlier.files.filter((f) => f.kind === "picture").length} pictures
              {earlier.files.some((f) => f.kind === "captions") ? " and captions.txt" : ""}.
              {earlier.folder && (
                <>
                  {" "}
                  <a href={earlier.folder.webViewLink} target="_blank" rel="noreferrer">
                    Open the month folder
                  </a>
                </>
              )}
            </p>
          ) : null}
        </section>

        <section className="deliver-choices">
          <span className="deliver-label">What to deliver</span>
          <label className="deliver-choice">
            <input
              type="radio"
              name="deliver-scope"
              checked={scope === "approved"}
              disabled={running}
              onChange={() => setScope("approved")}
            />
            Approved posts only ({approvedMade.length}
            {approvedCount > approvedMade.length
              ? ` of ${approvedCount} approved have a picture`
              : ""}
            )
          </label>
          <label className="deliver-choice">
            <input
              type="radio"
              name="deliver-scope"
              checked={scope === "all"}
              disabled={running}
              onChange={() => setScope("all")}
            />
            All made posts ({made.length})
          </label>
          <label className="deliver-choice">
            <input
              type="checkbox"
              checked={captions}
              disabled={running}
              onChange={(e) => setCaptions(e.target.checked)}
            />
            Include captions.txt (number, title, date, caption and hashtags of every delivered post)
          </label>
          {!made.length && (
            <p className="deliver-muted">No post of this month has a picture yet.</p>
          )}
          {made.length > 0 && !chosen.length && (
            <p className="deliver-muted">
              No approved post has a picture yet. Choose "All made posts" to deliver everything
              made.
            </p>
          )}
        </section>

        {started && (
          <section className="deliver-progress">
            <span className="deliver-label">Progress</span>
            <ul>
              {chosen.map((p) => {
                const s = steps[p.index] ?? { state: "waiting" };
                return (
                  <li key={p.index} className={`deliver-step deliver-step-${s.state}`}>
                    <span className="deliver-step-post">
                      {String(p.index).padStart(2, "0")} {p.title}
                    </span>
                    {s.state === "done" ? (
                      <a href={s.link} target="_blank" rel="noreferrer" className="deliver-link">
                        {s.name} {s.updated ? "(updated)" : ""} <ExternalLink size={12} />
                      </a>
                    ) : s.state === "failed" ? (
                      <span className="deliver-bad" title={s.error}>
                        {STEP_LABEL.failed}
                      </span>
                    ) : (
                      <span className="deliver-muted">{STEP_LABEL[s.state]}…</span>
                    )}
                  </li>
                );
              })}
              {captionsStep && (
                <li className={`deliver-step deliver-step-${captionsStep.state}`}>
                  <span className="deliver-step-post">captions.txt</span>
                  {captionsStep.state === "done" ? (
                    <a
                      href={captionsStep.link}
                      target="_blank"
                      rel="noreferrer"
                      className="deliver-link"
                    >
                      {captionsStep.name} {captionsStep.updated ? "(updated)" : ""}{" "}
                      <ExternalLink size={12} />
                    </a>
                  ) : captionsStep.state === "failed" ? (
                    <span className="deliver-bad">{STEP_LABEL.failed}</span>
                  ) : (
                    <span className="deliver-muted">{STEP_LABEL[captionsStep.state]}…</span>
                  )}
                </li>
              )}
            </ul>
            {failure && <p className="deliver-problem">{failure}</p>}
            {folderLink && (
              <a
                href={folderLink}
                target="_blank"
                rel="noreferrer"
                className="deliver-link deliver-folder-link"
              >
                Open the month folder in Drive <ExternalLink size={13} />
              </a>
            )}
          </section>
        )}

        <div className="deliver-actions">
          <button type="button" className="secondary" onClick={onClose} disabled={running}>
            {started && !running ? "Done" : "Cancel"}
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => void deliver()}
            disabled={!canDeliver}
          >
            <FolderUp size={15} />{" "}
            {running
              ? "Delivering…"
              : chosen.length
                ? `Deliver ${chosen.length} ${chosen.length === 1 ? "post" : "posts"}`
                : "Deliver"}
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
