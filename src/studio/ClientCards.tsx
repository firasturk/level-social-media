import { useRef, useState } from "react";
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
import { del, post, postForm } from "@/api";
import { initials } from "@shared/clients";
import type { Client } from "@shared/types";

type Reply = { clients: Client[]; id?: string };

/** Clients as cards: pick the brand a batch is produced for. Replaces the production-approach cards. */
export default function ClientCards({
  clients,
  value,
  disabled,
  canEdit = false,
  onChange,
  onClientsChanged,
}: {
  clients: Client[];
  value: string;
  disabled: boolean;
  /** Admins may rename, re-order, change the logo and archive. Anyone may add. */
  canEdit?: boolean;
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

  function add() {
    const name = window.prompt("Client name:", "");
    if (!name || !name.trim()) return;
    void call(
      () => post<Reply>("/api/studio/clients", { name: name.trim() }),
      (r) => r.id,
    );
  }

  function rename(c: Client) {
    const name = window.prompt("Client name:", c.name);
    if (name === null || !name.trim() || name.trim() === c.name) return;
    void call(() => post<Reply>(`/api/studio/clients/${c.id}`, undefined).catch(() => putName()));
    async function putName() {
      const res = await fetch(`/api/studio/clients/${c.id}`, {
        method: "PUT",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name!.trim() }),
      });
      const data = (await res.json().catch(() => ({}))) as Reply & { error?: string };
      if (!res.ok) throw new Error(data.error || "Rename failed.");
      return data;
    }
  }

  function move(c: Client, dir: -1 | 1) {
    const ids = active.map((x) => x.id);
    const i = ids.indexOf(c.id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    void call(() => post<Reply>("/api/studio/clients/order", { ids }));
  }

  function archive(c: Client) {
    const msg = c.batches
      ? `Archive "${c.name}"? Its ${c.batches} batches stay in history.`
      : `Remove "${c.name}"? It has no batches, so it will be deleted.`;
    if (!window.confirm(msg)) return;
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

  return (
    <>
      <div className="workflow-label">
        <span className="step">01</span>
        <h2>Choose the client</h2>
        <button type="button" className="text-button" onClick={add} disabled={busy}>
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
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/svg+xml"
        hidden
        onChange={(e) => void uploadLogo(e.target.files?.[0])}
      />
      {!shown.length ? (
        <div className="mode-note">
          <Users size={16} />
          No clients yet. Add the first client to start a batch.
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
                      ? `${c.batches} ${c.batches === 1 ? "batch" : "batches"}`
                      : "No batches yet"}
                </span>
                <span className="mode-tools">
                  {/* Spans, not buttons: a button inside a label would become the label's control. */}
                  {canEdit && !isArchived && (
                    <>
                      <Tool label="Move left" onClick={() => move(c, -1)} disabled={i === 0}>
                        <ChevronLeft size={13} />
                      </Tool>
                      <Tool
                        label="Move right"
                        onClick={() => move(c, 1)}
                        disabled={i === active.length - 1}
                      >
                        <ChevronRight size={13} />
                      </Tool>
                      <Tool label="Rename client" onClick={() => rename(c)}>
                        <Pencil size={13} />
                      </Tool>
                      <Tool label="Change logo" onClick={() => pickLogo(c)}>
                        <ImagePlus size={13} />
                      </Tool>
                      <Tool label="Archive client" onClick={() => archive(c)}>
                        <Archive size={13} />
                      </Tool>
                    </>
                  )}
                  {canEdit && isArchived && (
                    <Tool label="Restore client" onClick={() => restore(c)}>
                      <ArchiveRestore size={13} />
                    </Tool>
                  )}
                </span>
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
