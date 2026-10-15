import { useState } from "react";
import { FolderOpen, LoaderCircle, Trash2 } from "lucide-react";
import type { Batch, Client, SkillInfo } from "@shared/types";
import { isSkillCampaign, type Config } from "@shared/config";

import { MODES, type ModeInfo } from "./constants";
import { monthLabel } from "@shared/posts";

const STATE_LABEL: Record<string, string> = {
  idle: "Idle",
  running: "Generating",
  paused: "Paused",
};

function ago(ts: number): string {
  const m = Math.round((Date.now() - ts) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(ts).toLocaleDateString("en-GB");
}

export default function BatchesView({
  batches,
  busyId,
  onOpen,
  onDelete,
  skills = [],
  clients = [],
  modes = MODES,
}: {
  batches: Batch[];
  skills?: SkillInfo[];
  /** Every client, archived ones included, so old batches still show a name. */
  clients?: Client[];
  modes?: ModeInfo[];
  busyId: string | null;
  onOpen: (id: string) => void;
  onDelete: (b: Batch) => void;
}) {
  const [clientFilter, setClientFilter] = useState("");
  const clientName = (id: string | null | undefined) =>
    id ? (clients.find((c) => c.id === id)?.name ?? "Unknown client") : "";
  const shown = clientFilter ? batches.filter((b) => b.client === clientFilter) : batches;
  const filter = clients.length > 0 && (
    <div className="batches-filter">
      <label htmlFor="batches-client">Client</label>
      <select
        id="batches-client"
        value={clientFilter}
        onChange={(e) => setClientFilter(e.target.value)}
      >
        <option value="">All clients</option>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>
            {c.name}
            {c.status === "archived" ? " (archived)" : ""}
          </option>
        ))}
      </select>
      <span className="batches-count">
        {shown.length} {shown.length === 1 ? "month" : "months"}
      </span>
    </div>
  );
  if (!batches.length) {
    return (
      <div className="empty-results">
        <div className="empty-grid-icon">
          <FolderOpen size={36} />
        </div>
        <h3>No months yet.</h3>
        <p>Pick a client, upload products or generate ideas: the month appears here with its progress.</p>
      </div>
    );
  }
  return (
    <>
      {filter}
      <div className="batches-table" role="table" aria-label="Saved batches">
      <div className="batches-head" role="row">
        <span>Month</span>
        <span>Client</span>
        <span>Progress</span>
        <span>Spent</span>
        <span>Status</span>
        <span />
      </div>
      {shown.map((b) => {
        const cfg = JSON.parse(b.config) as Config;
        const who = clientName(b.client);
        const mode = modes.find((m) => m.id === cfg.mode);
        const total = b.total ?? 0;
        const done = b.completed ?? 0;
        const pct = total ? Math.round((done / total) * 100) : 0;
        const tone =
          b.state === "running"
            ? "running"
            : b.state === "paused" || b.failed
              ? "warn"
              : b.review
                ? "review"
                : total && done === total
                  ? "done"
                  : "idle";
        const status =
          b.state === "running"
            ? "Generating"
            : b.state === "paused"
              ? `Paused${b.last_error ? " · " + b.last_error : ""}`
              : b.failed
                ? `${b.failed} failed`
                : b.review
                  ? `${b.review} to review`
                  : total && done === total
                    ? "Complete"
                    : STATE_LABEL[b.state];
        return (
          <div className="batches-row" role="row" key={b.id} onDoubleClick={() => onOpen(b.id)}>
            <span className="batches-name">
              <span className="batch-thumbs" aria-hidden="true">
                {(b.thumbs ?? []).map((t) => (
                  <img
                    key={t}
                    src={`/api/studio/file?batch=${b.id}&id=${t}&kind=result`}
                    alt=""
                    loading="lazy"
                  />
                ))}
                {!(b.thumbs ?? []).length && <span className="batch-thumb-empty" />}
              </span>
              <span>
                <strong>{b.name}</strong>
                <small>
                  {new Date(b.created).toLocaleDateString("en-GB")} · updated {ago(b.updated)}
                </small>
              </span>
            </span>
            <span>
              {who && <strong className="batches-client">{who}</strong>}
              <small>
                {cfg.mode === "post"
                  ? monthLabel(b.month ?? cfg.month ?? "")
                  : isSkillCampaign(cfg.mode)
                    ? `Skill · ${skills.find((s) => s.id === cfg.skill)?.title ?? cfg.skill}${cfg.mode === "8" ? " · new model" : ""}`
                    : (mode?.title ?? cfg.mode)}
              </small>
            </span>
            <span className="batches-progress">
              <span className="bar">
                <span style={{ width: `${pct}%` }} />
              </span>
              <small>
                {done}/{total}
              </small>
            </span>
            <span>{b.spent ? `≈ $${b.spent.toFixed(2)}` : "–"}</span>
            <span className={`batches-status ${tone}`}>
              <i className="status-dot" />
              {status}
            </span>
            <span className="footer-actions row-actions">
              <button className="secondary" onClick={() => onOpen(b.id)} disabled={busyId === b.id}>
                {busyId === b.id ? (
                  <LoaderCircle className="spinning" size={15} />
                ) : (
                  <FolderOpen size={15} />
                )}{" "}
                Open
              </button>
              <button
                className="secondary danger"
                onClick={() => onDelete(b)}
                disabled={b.state === "running"}
                aria-label={`Delete ${b.name}`}
              >
                <Trash2 size={15} />
              </button>
            </span>
          </div>
        );
      })}
      </div>
    </>
  );
}
