/**
 * The Photo lab's logic, shared by the post editor's panel and the Photo studio's Lab panel: the
 * connection status and access, the picture source (this post's picture, one of the client's Drive
 * photos, an earlier result), the four tools and their prices, the propose → confirm → run flow
 * (the server writes the estimate to the ledger first; the admin confirms; the same request goes
 * again with {opId, confirm}), the polling of a running job, the earlier results, and "use as the
 * post's picture" / "save as a product photo". With no Freepik key everything is a demo and
 * nothing leaves the server. Members see the entry and "Admins only for now": `locked` is true
 * and no run is possible.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Eraser, ImagePlus, Sun, ZoomIn } from "lucide-react";
import { toast } from "sonner";
import { askConfirm } from "@/lib/confirm";
import { get, post } from "@/api";
import { formatUsd, type PhotoLabOp } from "@shared/pricing";
import type { DriveListing, DrivePhoto } from "@shared/drive";
import type { PhotoLabStatus } from "../FreepikConnection";

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

export type PhotoLabSource = { kind: "task"; batch: string; id: string } | { kind: "drive"; id: string } | { kind: "job"; id: string };

export const PHOTO_LAB_OPS: { id: PhotoLabOp; label: string; why: string; icon: typeof Eraser; prompt?: string }[] = [
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

export const drivePhotoUrl = (id: string, size: number) => `/api/studio/drive/photo/${encodeURIComponent(id)}?size=${size}`;

export interface PhotoLabOptions {
  clientId: string;
  /** The month, for "Use as the post's picture" and "Save as a product photo". */
  batchId?: string | null;
  /** The post whose picture is edited, with its current picture, when the lab is in the editor. */
  post?: number;
  task?: { id: string; imageUrl: string } | null;
  /** Opened on a Drive photo (from the Drive picker). */
  initialDrive?: { id: string; name: string } | null;
  /** The month changed (a picture replaced, a product added). */
  onChanged?: () => void | Promise<void>;
}

export function usePhotoLab({ clientId, batchId, post: postIndex, task, initialDrive, onChanged }: PhotoLabOptions) {
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
  const access = status?.access;
  const locked = !!status && !!access && (!access.admin || !access.enabled);
  const source: PhotoLabSource | null = chainJob
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
  const chosen = PHOTO_LAB_OPS.find((o) => o.id === op)!;
  const cost = status?.prices?.[op] ?? 0;
  const needsPrompt = op === "background";

  async function runTool() {
    if (!source) return;
    if (needsPrompt && !prompt.trim()) {
      toast.error("Describe the new background first.");
      return;
    }
    setRunning(true);
    try {
      const payload = { client: clientId, source, op, prompt: prompt.trim() || undefined };
      // First the proposal: nothing is sent; the server answers with the estimate it put on the ledger.
      const proposal = await post<{ opId: string; estimate: number | null; needsConfirmation: true }>("/api/studio/photolab/run", payload);
      const estimate = proposal.estimate;
      const ok = await askConfirm(
        estimate == null
          ? `${chosen.label} on ${sourceLabel}: the cost is not known, so the server will refuse it until an admin clarifies the price.`
          : demo
            ? `${chosen.label} on ${sourceLabel} as a demo: nothing is sent to Freepik and nothing is charged. Run it?`
            : `${chosen.label} on ${sourceLabel} costs about ${formatUsd(estimate)} on Freepik (approximate: Freepik bills credits per call). Run it?`,
        { ok: estimate == null ? "Try anyway" : demo ? "Run (demo)" : `Run · about ${formatUsd(estimate)}`, danger: false, cancel: "Not now" },
      );
      if (!ok) return;
      const r = await post<{ job: PhotoLabJob }>("/api/studio/photolab/run", { ...payload, opId: proposal.opId, confirm: true });
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

  /** The result becomes the input of the next tool. */
  function chain() {
    if (!job?.output) return;
    setChainJob(job);
    setJob(null);
    setPrompt("");
  }

  return {
    status,
    demo,
    access,
    locked,
    tab,
    setTab,
    driveId,
    setDriveId,
    drive,
    driveError,
    drivePhotos,
    chainJob,
    setChainJob,
    op,
    setOp,
    prompt,
    setPrompt,
    job,
    setJob,
    history,
    running,
    using,
    source,
    sourceLabel,
    chosen,
    cost,
    needsPrompt,
    runTool,
    applyResult,
    chain,
    /** "Use as the post's picture" makes sense only in a month, on a post with a picture. */
    canUseAsPicture: !locked && !!batchId && postIndex != null && !!task,
    canSaveAsProduct: !locked && !!batchId,
  };
}

export type PhotoLab = ReturnType<typeof usePhotoLab>;
