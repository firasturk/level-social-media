import { useRef, useState } from "react";
import { askConfirm, askInput } from "@/lib/confirm";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Archive,
  ArchiveRestore,
  ChevronLeft,
  ChevronRight,
  ImagePlus,
  Pencil,
  Plus,
  Users,
} from "lucide-react";
import { toast } from "sonner";
import { del, post, postForm, put } from "@/api";
import { initials } from "@shared/clients";
import type { Client } from "@shared/types";

type Reply = { clients: Client[]; id?: string };

/** Clients as cards: pick the brand a batch is produced for. Replaces the production-approach cards. */
export default function ClientCards({
  clients,
  value,
  disabled,
  canEdit = false,
  layout = "cards",
  onChange,
  onClientsChanged,
}: {
  clients: Client[];
  value: string;
  disabled: boolean;
  /** Admins may rename, re-order, change the logo and archive. Anyone may add. */
  canEdit?: boolean;
  /** "cards" is the studio grid; "list" is the compact rail in the sidebar. */
  layout?: "cards" | "list";
  onChange: (id: string) => void;
  onClientsChanged: (clients: Client[]) => void;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const [busy, setBusy] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const logoTarget = useRef<string | null>(null);
  const active = clients.filter((c) => c.status === "active");
  const archived = clients.filter((c) => c.status === "archived");
  const shown = showArchived ? clients : active;

  async function call(fn: () => Promise<Reply>, picked?: (r: Reply) => string | undefined) {
    setBusy(true);
    try {
      const r = await fn();
      onClientsChanged(r.clients);
      const id = picked?.(r);
      if (id) onChange(id);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function add() {
    const name = await askInput("Client name", "", { ok: "Add client" });
    if (!name || !name.trim()) return;
    void call(
      () => post<Reply>("/api/studio/clients", { name: name.trim() }),
      (r) => r.id,
    );
  }

  async function rename(c: Client) {
    const name = await askInput("Client name", c.name, { ok: "Rename" });
    if (name === null || !name.trim() || name.trim() === c.name) return;
    void call(() => put<Reply>(`/api/studio/clients/${c.id}`, { name: name.trim() }));
  }

  function move(c: Client, dir: -1 | 1) {
    const ids = active.map((x) => x.id);
    const i = ids.indexOf(c.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void call(() => post<Reply>("/api/studio/clients/order", { ids }));
  }

  async function archive(c: Client) {
    const msg = c.batches
      ? `Archive "${c.name}"? Its ${c.batches} months stay in history.`
      : `Remove "${c.name}"? It has no months, so it will be deleted.`;
    if (!(await askConfirm(msg, { ok: c.batches ? "Archive" : "Remove" }))) return;
    void call(
      () => del<Reply>(`/api/studio/clients/${c.id}`),
      (r) => (value === c.id ? r.clients.find((x) => x.status === "active")?.id : undefined),
    );
  }

  function restore(c: Client) {
    void call(() => post<Reply>(`/api/studio/clients/${c.id}/restore`), () => c.id);
  }

  function pickLogo(c: Client) {
    logoTarget.current = c.id;
    fileInput.current?.click();
  }

  async function uploadLogo(file: File | undefined) {
    const id = logoTarget.current;
    logoTarget.current = null;
    if (fileInput.current) fileInput.current.value = "";
    if (!id || !file) return;
    const form = new FormData();
    form.append("file", file);
    await call(() => postForm<Reply>(`/api/studio/clients/${id}/logo`, form));
  }

  const tools = (c: Client, i: number) => {
    const isArchived = c.status === "archived";
    if (!canEdit) return null;
    if (isArchived)
      return (
        <Tool label="Restore client" onClick={() => restore(c)}>
          <ArchiveRestore size={13} />
        </Tool>
      );
    return (
      <>
        <Tool label="Move up" onClick={() => move(c, -1)} disabled={i === 0}>
          <ChevronLeft size={13} />
        </Tool>
        <Tool label="Move down" onClick={() => move(c, 1)} disabled={i === active.length - 1}>
          <ChevronRight size={13} />
        </Tool>
        <Tool label="Rename client" onClick={() => void rename(c)}>
          <Pencil size={13} />
        </Tool>
        <Tool label="Change logo" onClick={() => pickLogo(c)}>
          <ImagePlus size={13} />
        </Tool>
        <Tool label="Archive client" onClick={() => void archive(c)}>
          <Archive size={13} />
        </Tool>
      </>
    );
  };

  const logoInput = (
    <input
      ref={fileInput}
      type="file"
      accept="image/png,image/jpeg,image/webp,image/svg+xml"
      hidden
      onChange={(e) => void uploadLogo(e.target.files?.[0])}
    />
  );

  if (layout === "list")
    return (
      <div className="client-list">
        <div className="client-list-head">
          <span>Clients</span>
          <button type="button" className="icon-button" onClick={() => void add()} disabled={busy} aria-label="Add client" title="Add client">
            <Plus size={15} />
          </button>
        </div>
        {logoInput}
        {shown.map((c, i) => {
          const isArchived = c.status === "archived";
          return (
            <div
              key={c.id}
              role="button"
              tabIndex={disabled || isArchived ? -1 : 0}
              aria-pressed={value === c.id}
              aria-disabled={disabled || isArchived}
              className={`client-row ${value === c.id ? "active" : ""} ${isArchived ? "archived" : ""}`}
              onClick={() => !disabled && !isArchived && onChange(c.id)}
              onKeyDown={(e) => e.key === "Enter" && !disabled && !isArchived && onChange(c.id)}
            >
              {c.logo ? (
                <img className="client-row-logo" src={`/api/studio/clients/${c.id}/logo?v=${c.updated}`} alt="" />
              ) : (
                <span className="client-row-initials" aria-hidden="true">
                  {initials(c.name)}
                </span>
              )}
              <span className="client-row-name">
                {c.name}
                <small>
                  {isArchived ? "Archived" : c.batches ? `${c.batches} ${c.batches === 1 ? "month" : "months"}` : "No months"}
                </small>
              </span>
              <span className="mode-tools client-row-tools">{tools(c, i)}</span>
            </div>
          );
        })}
        {!shown.length && <p className="client-list-empty">No clients yet.</p>}
        {archived.length > 0 && (
          <button type="button" className="text-button client-list-toggle" onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? "Hide archived" : `Show ${archived.length} archived`}
          </button>
        )}
      </div>
    );

  return (
    <>
      <div className="workflow-label">
        <span className="step">01</span>
        <h2>Choose the client</h2>
        <button type="button" className="text-button" onClick={() => void add()} disabled={busy}>
          <Plus size={14} /> Add client
        </button>
        {archived.length > 0 && (
          <button
            type="button"
            className="text-button"
            onClick={() => setShowArchived((v) => !v)}
          >
            {showArchived ? "Hide archived" : `Show ${archived.length} archived`}
          </button>
        )}
      </div>
      {logoInput}
      {!shown.length ? (
        <div className="mode-note">
          <Users size={16} />
          No clients yet. Add the first client to start a month of posts.
        </div>
      ) : (
        <RadioGroup
          className="modes clients"
          value={value}
          onValueChange={onChange}
          disabled={disabled}
        >
          {shown.map((c, i) => {
            const isArchived = c.status === "archived";
            return (
              <label
                key={c.id}
                className={`mode-card client-card ${value === c.id ? "active" : ""} ${isArchived ? "hidden-card" : ""} ${canEdit ? "editable" : ""}`}
              >
                <div className="mode-top">
                  {c.logo ? (
                    <img
                      className="client-logo"
                      src={`/api/studio/clients/${c.id}/logo?v=${c.updated}`}
                      alt=""
                    />
                  ) : (
                    <span className="client-initials" aria-hidden="true">
                      {initials(c.name)}
                    </span>
                  )}
                  <RadioGroupItem value={c.id} aria-label={c.name} disabled={disabled || isArchived} />
                </div>
                <strong>{c.name}</strong>
                <span>
                  {isArchived
                    ? "Archived"
                    : c.batches
                      ? `${c.batches} ${c.batches === 1 ? "month" : "months"}`
                      : "No months yet"}
                </span>
                {/* Spans, not buttons: a button inside a label would become the label's control. */}
                <span className="mode-tools">{tools(c, i)}</span>
              </label>
            );
          })}
        </RadioGroup>
      )}
    </>
  );
}

function Tool({
  label,
  onClick,
  disabled,
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <span
      role="button"
      tabIndex={disabled ? -1 : 0}
      className={`mode-tool ${disabled ? "is-disabled" : ""}`}
      aria-label={label}
      aria-disabled={disabled}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        if (!disabled) onClick();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !disabled) {
          e.preventDefault();
          onClick();
        }
      }}
    >
      {children}
    </span>
  );
}
