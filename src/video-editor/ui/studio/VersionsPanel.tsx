/**
 * Versions: every clip of this post, newest first (a small muted preview of each that plays by
 * itself while on screen), with who made it (the provider's label), its
 * frame, its cost, its state, the one the client sees (the first finished clip by itself, or the
 * one the team selected), the client's answers on each version, Compare (two versions side by side
 * on the stage), "Select for client review" and "Show the picture instead".
 */
import { useState } from "react";
import { Check, Columns2, Download, History, Scissors, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Orb } from "@/components/Orb";
import { AutoplayVideo } from "@/components/AutoplayVideo";
import { videoModel } from "@shared/video-models";
import { audioLine, costLabel, engineLabel, frameLine, inFlight, inputLine, selectForClient, STATUS_TEXT, versionLabel, type VideoItem } from "@/studio/videoApi";
import type { StudioShared } from "./types";

const when = (t: number) => new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default function VersionsPanel({ s }: { s: StudioShared }) {
  const [busy, setBusy] = useState(false);
  const client = s.videos.find((v) => v.forClient) ?? null;
  const answers = s.approval?.answers ?? [];
  const answersOn = (v: VideoItem) => answers.filter((a) => a.version?.kind === "video" && a.version.id === v.id);
  const answersOnPicture = answers.filter((a) => !a.version || a.version.kind === "image");
  async function select(id: string | null) {
    if (!s.post) return;
    setBusy(true);
    try {
      await selectForClient(s.post.batch, s.post.index, id);
      await s.reloadVideos();
      s.onChanged?.();
      toast.success(id ? "The client sees this video on the review link." : "The client sees the picture.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const pick = (id: string) => {
    if (s.shownId === id) s.setCompareId(null);
    else if (s.compareId === id) s.setCompareId(null);
    else if (s.shownId) s.setCompareId(id);
    else s.setShownId(id);
  };
  return (
    <div className="vs-panel">
      <div className="ts-panel-head">
        <span>
          <History size={13} /> Versions
        </span>
        <small>{s.videos.length} clip{s.videos.length === 1 ? "" : "s"}</small>
      </div>
      <p className="ts-hint">
        The client sees <b>{client ? versionLabel(client) : "the picture"}</b> on the review link: the first finished clip goes there by itself; pick another with “Select for client review”, or “Show the picture instead”. Every clip stays here; pick one to show it on the stage, a second one to compare.
      </p>
      {s.compareId && (
        <p className="ts-hint vs-compare-note">
          <Columns2 size={13} /> Comparing two versions on the stage.{" "}
          <button type="button" className="ts-link" onClick={() => s.setCompareId(null)}>
            Stop comparing
          </button>
        </p>
      )}
      <ul className="vs-list">
        <li className={`${client ? "" : "current"} ${s.shownId === null ? "shown" : ""}`}>
          {s.pictureUrl ? <img src={s.pictureUrl} alt="" loading="lazy" /> : <span className="vs-blank" aria-hidden />}
          <span className="vs-list-text">
            <b>The picture{client ? "" : " · the client sees this"}</b>
            <small>The post's current picture, words drawn by the page.</small>
            {answersOnPicture.map((a) => (
              <small key={a.rid} className={`vs-answer ${a.status}`}>
                Client: {a.status === "approved" ? "approved" : "asked for changes"}
                {a.by ? ` · ${a.by}` : ""} · {when(a.at)}
                {a.note ? ` · “${a.note}”` : ""}
              </small>
            ))}
          </span>
          <span className="vs-list-actions">
            <button type="button" className={`ts-mini ${s.shownId === null ? "primary" : ""}`} onClick={() => s.setShownId(null)}>
              Show
            </button>
            {client && (
              <button type="button" className="ts-mini" disabled={busy || !s.admin} onClick={() => void select(null)} title="The review link shows the picture, no clip">
                Show the picture instead
              </button>
            )}
          </span>
        </li>
        {s.videos.map((v) => {
          const picked = s.shownId === v.id || s.compareId === v.id;
          return (
            <li key={v.id} className={`${v.status} ${v.forClient ? "current" : ""} ${picked ? "shown" : ""}`}>
              {v.status === "done" && v.url ? (
                <AutoplayVideo className="apv-mini vs-clip" src={v.preview ?? v.url} fallbackSrc={v.preview ? v.url : null} poster={v.poster} mode="preview" bare label={versionLabel(v)} />
              ) : v.poster ? (
                <img src={v.poster} alt="" loading="lazy" />
              ) : (
                <span className="vs-blank" aria-hidden />
              )}
              <span className="vs-list-text">
                <b>
                  {versionLabel(v)}
                  {v.forClient ? " · the client sees this" : ""}
                </b>
                <small>
                  {engineLabel(v, (slug) => videoModel(slug)?.name)}
                  {v.duration ? ` · ${v.duration}s` : ""}
                  {frameLine(v) ? ` · ${frameLine(v)}` : ""}
                  {inputLine(v) ? ` · ${inputLine(v)}` : ""}
                  {costLabel(v) ? ` · ${costLabel(v)}` : v.status === "done" && (v.provider === "upload" || v.provider === "editor") ? " · free" : ""}
                  {audioLine(v) ? ` · ${audioLine(v)}` : ""}
                </small>
                <small>
                  {when(v.created)} · {STATUS_TEXT[v.status]}
                  {v.prompt && v.source !== "upload" && v.source !== "editor" ? ` · “${v.prompt.slice(0, 90)}${v.prompt.length > 90 ? "…" : ""}”` : ""}
                </small>
                {inFlight(v) && (
                  <small>
                    <Orb size={12} status={null} /> {STATUS_TEXT[v.status]}…
                  </small>
                )}
                {v.status === "failed" && v.error && (
                  <small className="warn">
                    <TriangleAlert size={12} /> {v.error}
                  </small>
                )}
                {answersOn(v).map((a) => (
                  <small key={a.rid} className={`vs-answer ${a.status}`}>
                    Client: {a.status === "approved" ? "approved" : "asked for changes"}
                    {a.by ? ` · ${a.by}` : ""} · {when(a.at)}
                    {a.note ? ` · “${a.note}”` : ""}
                  </small>
                ))}
              </span>
              {v.status === "done" && v.url && (
                <span className="vs-list-actions">
                  <button type="button" className={`ts-mini ${picked ? "primary" : ""}`} onClick={() => pick(v.id)} title={s.shownId && s.shownId !== v.id ? "Put this version beside the shown one" : "Show this version on the stage"}>
                    {s.shownId && s.shownId !== v.id ? <Columns2 size={12} /> : null} {s.shownId === v.id ? "Shown" : s.compareId === v.id ? "Comparing" : s.shownId ? "Compare" : "Show"}
                  </button>
                  {v.forClient ? (
                    <>
                      <span className="ts-mini on" title="The review link plays this clip">
                        <Check size={12} /> The client sees this
                      </span>
                      <button type="button" className="ts-mini" disabled={busy || !s.admin} onClick={() => void select(null)} title={s.admin ? "The review link shows the picture, no clip" : "Admins only for now"}>
                        Show the picture instead
                      </button>
                    </>
                  ) : (
                    <button type="button" className="ts-mini" disabled={busy || !s.admin} onClick={() => void select(v.id)} title={s.admin ? "The client sees this clip on the review link" : "Admins only for now"}>
                      Select for client review
                    </button>
                  )}
                  <button
                    type="button"
                    className="ts-mini"
                    onClick={() => {
                      s.setShownId(v.id);
                      s.openPanel("edit");
                    }}
                    title="Trim, colour, music; the export becomes a new version"
                  >
                    <Scissors size={12} /> Edit
                  </button>
                  <a className="ts-mini" href={v.url} download={`${s.fileBase}_video${v.version}.mp4`} title="Download this clip">
                    <Download size={12} />
                  </a>
                </span>
              )}
            </li>
          );
        })}
      </ul>
      {s.videos.length === 0 && <p className="ts-hint">No clip yet. Pick a preset or make one in Generate.</p>}
    </div>
  );
}
