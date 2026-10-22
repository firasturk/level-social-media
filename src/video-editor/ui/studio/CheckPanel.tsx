/**
 * Check: Higgsfield's reading of the shown clip (the virality check, a longer video analysis),
 * run only on an admin's click with the cost said first (or "cost not known", confirmed), the
 * words kept on the version. "Not available on this plan" when the server lists no such tool.
 */
import { useEffect, useRef, useState } from "react";
import { Lock, RefreshCw, ScanSearch, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Orb } from "@/components/Orb";
import { ApiError } from "@/api";
import { askConfirm } from "@/lib/confirm";
import { versionLabel } from "@/studio/videoApi";
import { higgsfieldCheck, higgsfieldCheckStatus, higgsfieldTools, type ConfirmAsk, type HiggsfieldTools } from "../../studioApi";
import type { StudioShared } from "./types";

const when = (t: number) => new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default function CheckPanel({ s }: { s: StudioShared }) {
  const [tools, setTools] = useState<HiggsfieldTools | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  const polling = useRef<ReturnType<typeof setInterval> | null>(null);
  const shown = (s.shownId ? s.videos.find((v) => v.id === s.shownId) : null) ?? s.videos.find((v) => v.status === "done") ?? null;
  useEffect(() => {
    higgsfieldTools()
      .then(setTools)
      .catch((e: Error) => setError(e.message));
  }, []);
  // An analysis still running is asked about every few seconds.
  const running = shown?.analysis?.status === "running";
  useEffect(() => {
    if (!running || !s.post || !shown || !s.admin) return;
    const post = s.post;
    polling.current = setInterval(() => {
      void higgsfieldCheckStatus(post.batch, shown.id)
        .then(() => s.reloadVideos())
        .catch(() => undefined);
    }, 6000);
    return () => {
      if (polling.current) clearInterval(polling.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, shown?.id]);

  async function run(tool: string, label: string, confirm = false) {
    if (!s.post || !shown) return;
    setBusy(tool);
    setError("");
    try {
      await higgsfieldCheck({ batch: s.post.batch, videoId: shown.id, tool, confirm });
      await s.reloadVideos();
      toast.success(tool === "video_analysis_create" ? "The analysis has started; its answer lands here in a minute or two." : `${label} done.`);
    } catch (e) {
      const err = e as ApiError;
      const d = (err.data ?? {}) as ConfirmAsk;
      if (err.status === 409 && (d.needsConfirm || d.needsEstimate)) {
        const ok = await askConfirm(d.needsEstimate ? `${label} on ${versionLabel(shown)}: Higgsfield gives no cost for it. Run it at an unknown cost from the subscription credits?` : `${label} on ${versionLabel(shown)}: about ${d.credits} credits from the subscription balance.`, { ok: d.needsEstimate ? "Run it anyway" : `Run · ${d.credits} credits`, danger: false, cancel: "Not now" });
        if (ok) return run(tool, label, true);
      } else setError(err.message);
    } finally {
      setBusy(null);
    }
  }

  const locked = tools ? !tools.admin : !s.admin;
  return (
    <div className="vs-panel">
      <div className="ts-panel-head">
        <span>
          <ScanSearch size={13} /> Check
        </span>
        <small>{shown ? versionLabel(shown) : "no clip yet"}</small>
      </div>
      {locked && (
        <div className="vs-locked" role="note">
          <Lock size={14} />
          <div>
            <b>Admins only for now</b>
            <p>A check asks Higgsfield about the clip on the subscription credits; an admin runs it.</p>
          </div>
        </div>
      )}
      {tools && !tools.signedIn && <p className="ts-hint warn">{tools.reason}</p>}
      {tools && tools.signedIn && tools.billing !== "credits" && <p className="ts-hint warn">Videos are set to the Cloud API key: the checks run on the subscription credits. Switch the billing under Connection → Higgsfield.</p>}
      {!shown && <p className="ts-hint">Make or pick a finished clip first: the check reads one version.</p>}
      {!tools && !error && (
        <p className="ts-hint">
          <Orb size={14} /> Asking Higgsfield which checks this plan offers…
        </p>
      )}
      {tools?.checks.map((t) => (
        <div key={t.name} className={`vs-card ${t.available ? "" : "off"}`}>
          <span>
            <b>{t.label}</b>
            <small>{t.available ? t.hint : "Not available on this plan."}</small>
          </span>
          <button type="button" className="ts-mini primary" disabled={!t.available || locked || !shown || !!busy || !tools.signedIn || (t.name === "video_analysis_create" && running)} onClick={() => void run(t.name, t.label)}>
            {busy === t.name ? <Orb size={12} status={null} /> : null} Run
          </button>
        </div>
      ))}
      {error && (
        <p className="ts-hint warn">
          <TriangleAlert size={12} /> {error}
        </p>
      )}
      {shown?.check && (
        <>
          <span className="ts-group-title">
            {tools?.checks.find((c) => c.name === shown.check!.tool)?.label ?? shown.check.tool} · {when(shown.check.at)}
            {shown.check.credits !== null ? ` · ${shown.check.credits} credits` : ""}
          </span>
          <pre className="vs-words">{shown.check.text}</pre>
        </>
      )}
      {shown?.analysis && (
        <>
          <span className="ts-group-title">
            Video analysis · {shown.analysis.status === "running" ? "running" : shown.analysis.status === "failed" ? "failed" : "done"} · {when(shown.analysis.at)}
          </span>
          {shown.analysis.status === "running" ? (
            <p className="ts-hint">
              <Orb size={14} status={null} /> Higgsfield is reading the clip; the answer lands here when it is ready.{" "}
              {s.admin && (
                <button type="button" className="ts-link" onClick={() => s.post && void higgsfieldCheckStatus(s.post.batch, shown.id).then(() => s.reloadVideos())}>
                  <RefreshCw size={11} /> Ask now
                </button>
              )}
            </p>
          ) : (
            <pre className="vs-words">{shown.analysis.text}</pre>
          )}
        </>
      )}
      <p className="ts-hint">Nothing is made or changed by a check: it is Higgsfield's reading of the clip, kept with this version.</p>
    </div>
  );
}
