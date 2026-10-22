/**
 * Brand memory: what the studio remembers about a client, in four groups (brand rules, campaign
 * instructions, post instructions, proposed lessons). Each item shows its text, source, scope,
 * status, creation date, approver and revision. The admin approves or rejects; anyone can revise
 * (a new revision replaces the old one, which stays in the history), retire or add an item.
 *
 * RelevantRules lists only the items active for one post (or one month) with the conflicts between
 * them, for the Direction board.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { toast } from "sonner";
import { Check, History, Pencil, Plus, Power, X } from "lucide-react";
import { del, get, post, put } from "@/api";
import type { Client, User } from "@shared/types";
import {
  CATEGORY_LABEL,
  MEMORY_CATEGORIES,
  SOURCE_LABEL,
  conflictsBetween,
  scopeLabel,
  type MemoryCategory,
  type MemoryConflict,
  type MemoryItem,
} from "@shared/brandMemory";
import "./memory.css";

interface Month {
  id: string;
  name: string;
  month: string | null;
}

const api = "/api/studio/lessons";

function dayOf(t: number | null | undefined): string {
  if (!t) return "";
  return new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
}

function monthName(m: Month | undefined): string | undefined {
  if (!m) return undefined;
  if (m.month && /^\d{4}-\d{2}$/.test(m.month)) {
    const d = new Date(Number(m.month.slice(0, 4)), Number(m.month.slice(5, 7)) - 1, 1);
    return d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  }
  return m.name;
}

function useAdmin(given?: boolean): boolean {
  const [admin, setAdmin] = useState(!!given);
  useEffect(() => {
    if (given !== undefined) {
      setAdmin(given);
      return;
    }
    let live = true;
    get<{ user: User | null }>("/api/auth/me")
      .then((s) => live && setAdmin(s.user?.role === "admin"))
      .catch(() => live && setAdmin(false));
    return () => {
      live = false;
    };
  }, [given]);
  return admin;
}

function useMonths(clientId: string): Month[] {
  const [months, setMonths] = useState<Month[]>([]);
  useEffect(() => {
    let live = true;
    get<Month[]>(`${api}/months?client=${encodeURIComponent(clientId)}`)
      .then((m) => live && setMonths(m))
      .catch(() => live && setMonths([]));
    return () => {
      live = false;
    };
  }, [clientId]);
  return months;
}

const STATUS_LABEL: Record<MemoryItem["status"], string> = { pending: "waiting", approved: "in use", rejected: "rejected" };

/* ───────────── One item ───────────── */

function ItemRow({
  item,
  admin,
  months,
  busy,
  onJudge,
  onRevise,
  onDeactivate,
  onForget,
}: {
  item: MemoryItem;
  admin: boolean;
  months: Month[];
  busy: boolean;
  onJudge: (id: string, status: MemoryItem["status"]) => void;
  onRevise: (id: string, text: string) => Promise<void>;
  onDeactivate: (id: string) => void;
  onForget: (id: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.text);
  const retired = !!item.deactivated;
  const month = months.find((m) => m.id === item.scope.batch);
  async function save(e: FormEvent) {
    e.preventDefault();
    const t = draft.trim();
    if (!t || t === item.text) {
      setEditing(false);
      return;
    }
    await onRevise(item.id, t);
    setEditing(false);
  }
  return (
    <li className={`mem-item ${item.status}${retired ? " retired" : ""}`} data-kind={item.kind}>
      {editing ? (
        <form className="mem-edit" onSubmit={(e) => void save(e)}>
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={2} maxLength={600} dir="auto" autoFocus />
          <div className="mem-edit-actions">
            <button type="submit" className="btn-pill primary" disabled={busy}>
              <Check size={13} /> Save as revision {item.revision + 1}
            </button>
            <button type="button" className="btn-pill" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <p className="mem-text" dir="auto" title={item.rule}>
          {item.text}
        </p>
      )}
      <div className="mem-meta">
        <span className={`mem-status ${retired ? "retired" : item.status}`}>{retired ? "retired" : STATUS_LABEL[item.status]}</span>
        <span className="mem-scope" title="Where it applies">
          {scopeLabel(item.scope, monthName(month))}
        </span>
        <span className="mem-source">{SOURCE_LABEL[item.source] ?? item.source}</span>
        {item.category === "lesson" && item.kind !== "rule" && <span className="mem-kind">{item.kind === "ailook" ? "AI look" : item.kind}</span>}
        {item.seen > 1 && <span className="mem-seen">seen {item.seen}×</span>}
        <span className="mem-date" title="Created">
          {dayOf(item.first)}
        </span>
        {item.approver && (
          <span className="mem-approver" title={item.approved_at ? `Approved ${dayOf(item.approved_at)}` : "Decided by"}>
            {item.status === "approved" ? "approved by" : "decided by"} {item.approver}
          </span>
        )}
        <span className="mem-revision" title={item.replaces ? "Replaces an earlier revision" : "First revision"}>
          {item.replaces ? <History size={11} /> : null} rev {item.revision}
        </span>
      </div>
      {!retired && !editing && (
        <div className="mem-actions">
          {admin && item.status !== "approved" && (
            <button type="button" className="btn-pill primary" disabled={busy} onClick={() => onJudge(item.id, "approved")} title="The next prompts carry it">
              <Check size={13} /> Approve
            </button>
          )}
          {admin && item.status !== "rejected" && (
            <button type="button" className="btn-pill" disabled={busy} onClick={() => onJudge(item.id, "rejected")} title="Wrong: the prompts never carry it">
              <X size={13} /> Reject
            </button>
          )}
          <button type="button" className="btn-pill" disabled={busy} onClick={() => setEditing(true)} title="Write it again as a new revision; this one stays in the history">
            <Pencil size={13} /> Revise
          </button>
          <button type="button" className="btn-pill" disabled={busy} onClick={() => onDeactivate(item.id)} title="Retire it: kept for the record, never in a prompt again">
            <Power size={13} /> Deactivate
          </button>
          {item.status !== "approved" && (
            <button type="button" className="mem-forget" aria-label="Forget this item" disabled={busy} onClick={() => onForget(item.id)} title="Delete it for good">
              ×
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/* ───────────── Add form ───────────── */

function AddForm({ clientId, batchId, months, onAdded }: { clientId: string; batchId?: string; months: Month[]; onAdded: (item: MemoryItem) => void }) {
  const [open, setOpen] = useState<"" | "brand_rule" | "campaign_instruction" | "post_instruction">("");
  const [text, setText] = useState("");
  const [batch, setBatch] = useState(batchId ?? "");
  const [postIndex, setPostIndex] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (batchId) setBatch(batchId);
    else if (!batch && months.length) setBatch(months[0].id);
  }, [batchId, months, batch]);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!open || !text.trim()) return;
    setBusy(true);
    try {
      const scope = open === "brand_rule" ? undefined : open === "campaign_instruction" ? { batch } : { batch, post: Number(postIndex) };
      const item = await post<MemoryItem>(api, { client: clientId, text: text.trim(), category: open, scope });
      onAdded(item);
      setText("");
      setPostIndex("");
      setOpen("");
      toast.success(item.status === "approved" ? "Added: the next prompts carry it." : "Added: it waits for the admin's approval.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not add it.");
    } finally {
      setBusy(false);
    }
  }
  if (!open)
    return (
      <div className="mem-add-buttons">
        <button type="button" className="btn-pill" onClick={() => setOpen("brand_rule")}>
          <Plus size={13} /> Add a brand rule
        </button>
        <button type="button" className="btn-pill" onClick={() => setOpen("campaign_instruction")} disabled={!batchId && !months.length} title={!batchId && !months.length ? "This client has no month yet" : undefined}>
          <Plus size={13} /> Add an instruction for this month
        </button>
        <button type="button" className="btn-pill" onClick={() => setOpen("post_instruction")} disabled={!batchId && !months.length} title={!batchId && !months.length ? "This client has no month yet" : undefined}>
          <Plus size={13} /> Add an instruction for one post
        </button>
      </div>
    );
  const needsMonth = open !== "brand_rule";
  return (
    <form className="mem-add" onSubmit={(e) => void submit(e)}>
      <strong>{open === "brand_rule" ? "New brand rule" : open === "campaign_instruction" ? "New instruction for a month" : "New instruction for one post"}</strong>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        maxLength={600}
        dir="auto"
        autoFocus
        placeholder={open === "brand_rule" ? "e.g. No people in any picture; the product stands alone." : open === "campaign_instruction" ? "e.g. Every picture this month is set outdoors at golden hour." : "e.g. This post shows the cup from above, lid off."}
      />
      <div className="mem-add-row">
        {needsMonth && !batchId && (
          <label>
            Month
            <select value={batch} onChange={(e) => setBatch(e.target.value)}>
              {months.map((m) => (
                <option key={m.id} value={m.id}>
                  {monthName(m) ?? m.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {open === "post_instruction" && (
          <label>
            Post
            <input type="number" min={1} max={60} value={postIndex} onChange={(e) => setPostIndex(e.target.value)} required placeholder="№" />
          </label>
        )}
        <button type="submit" className="btn-pill primary" disabled={busy || !text.trim() || (needsMonth && !batch) || (open === "post_instruction" && !postIndex)}>
          <Check size={13} /> Add
        </button>
        <button type="button" className="btn-pill" onClick={() => setOpen("")}>
          Cancel
        </button>
      </div>
    </form>
  );
}

/* ───────────── The panel ───────────── */

export default function MemoryPanel({ client, batchId, admin: givenAdmin, onChange }: { client: Client; batchId?: string; admin?: boolean; onChange?: () => void }) {
  const admin = useAdmin(givenAdmin);
  const months = useMonths(client.id);
  const [items, setItems] = useState<MemoryItem[] | null>(null);
  const [showRetired, setShowRetired] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await get<MemoryItem[]>(`${api}?client=${encodeURIComponent(client.id)}`));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not read the memory.");
      setItems([]);
    }
  }, [client.id]);
  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<void>, fail: string) {
    setBusy(true);
    try {
      await fn();
      onChange?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : fail);
    } finally {
      setBusy(false);
    }
  }
  const judge = (id: string, status: MemoryItem["status"]) =>
    void act(async () => {
      const r = await put<{ approver: string; approved_at: number | null }>(`${api}/${id}`, { status });
      setItems((l) => (l ?? []).map((x) => (x.id === id ? { ...x, status, approver: r.approver, approved_at: r.approved_at } : x)));
    }, "Could not change it.");
  const revise = (id: string, text: string) =>
    act(async () => {
      const fresh = await post<MemoryItem>(`${api}/${id}/revise`, { text });
      const t = Date.now();
      setItems((l) => [fresh, ...(l ?? []).map((x) => (x.id === id ? { ...x, deactivated: t } : x))]);
    }, "Could not revise it.");
  const deactivate = (id: string) =>
    void act(async () => {
      await post(`${api}/${id}/deactivate`);
      setItems((l) => (l ?? []).map((x) => (x.id === id ? { ...x, deactivated: Date.now() } : x)));
    }, "Could not retire it.");
  const forget = (id: string) =>
    void act(async () => {
      await del(`${api}/${id}`);
      setItems((l) => (l ?? []).filter((x) => x.id !== id));
    }, "Could not forget it.");

  const groups = useMemo(() => {
    const out = {} as Record<MemoryCategory, MemoryItem[]>;
    for (const c of MEMORY_CATEGORIES) out[c] = [];
    for (const i of items ?? []) if (showRetired || !i.deactivated) out[i.category]?.push(i);
    for (const c of MEMORY_CATEGORIES) out[c].sort((a, b) => Number(!!a.deactivated) - Number(!!b.deactivated) || b.last - a.last);
    return out;
  }, [items, showRetired]);
  const active = useMemo(() => (items ?? []).filter((i) => !i.deactivated), [items]);
  const conflicts = useMemo(() => conflictsBetween(active.filter((i) => i.status === "approved")), [active]);
  const waiting = active.filter((i) => i.status === "pending").length;

  return (
    <div className="mem-panel">
      <div className="mem-head">
        <span className="muted small">
          {items === null ? "Reading the memory…" : `${active.filter((i) => i.status === "approved").length} in use · ${waiting} waiting${admin ? "" : " (an admin approves)"}`}
        </span>
        <label className="mem-toggle">
          <input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} /> show history
        </label>
      </div>
      <AddForm clientId={client.id} batchId={batchId} months={months} onAdded={(item) => setItems((l) => [item, ...(l ?? [])])} />
      {conflicts.length > 0 && <ConflictList conflicts={conflicts} months={months} />}
      {MEMORY_CATEGORIES.map((cat) => (
        <section key={cat} className="mem-group" data-category={cat}>
          <h4>
            {CATEGORY_LABEL[cat]} <em>{groups[cat].filter((i) => !i.deactivated).length}</em>
          </h4>
          {groups[cat].length === 0 ? (
            <p className="muted small mem-empty">
              {cat === "brand_rule"
                ? `Nothing yet. A brand rule is carried into every picture of ${client.name}.`
                : cat === "campaign_instruction"
                  ? "Nothing yet. An instruction for a month shapes only that month's pictures."
                  : cat === "post_instruction"
                    ? "Nothing yet. An instruction for a post shapes only that post."
                    : "Nothing proposed. Every problem the review finds, every change the client asks for, lands here and waits for approval."}
            </p>
          ) : (
            <ul className="mem-list">
              {groups[cat].map((item) => (
                <ItemRow key={item.id} item={item} admin={admin} months={months} busy={busy} onJudge={judge} onRevise={revise} onDeactivate={deactivate} onForget={forget} />
              ))}
            </ul>
          )}
        </section>
      ))}
    </div>
  );
}

function ConflictList({ conflicts, months }: { conflicts: MemoryConflict[]; months: Month[] }) {
  return (
    <div className="mem-conflicts" role="note">
      <strong>
        {conflicts.length} conflict{conflicts.length === 1 ? "" : "s"}
      </strong>
      <ul>
        {conflicts.map((c, i) => (
          <li key={`${c.forbids.id}-${c.asks.id}-${i}`}>
            <span className="mem-conflict-about">{c.about}</span>: “{c.forbids.text}” ({scopeLabel(c.forbids.scope, monthName(months.find((m) => m.id === c.forbids.scope.batch)))}) forbids what “{c.asks.text}” (
            {scopeLabel(c.asks.scope, monthName(months.find((m) => m.id === c.asks.scope.batch)))}) asks for.
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ───────────── Relevant rules (Direction board) ───────────── */

/**
 * The rules active for one post of a month (or the month alone without a post index): approved
 * brand rules, the month's instructions, the post's instructions and the approved lessons, plus
 * the conflicts between them.
 */
export function RelevantRules({ clientId, batchId, postIndex }: { clientId: string; batchId: string; postIndex?: number }) {
  const [memory, setMemory] = useState<Record<MemoryCategory, MemoryItem[]> | null>(null);
  useEffect(() => {
    let live = true;
    const q = `client=${encodeURIComponent(clientId)}&batch=${encodeURIComponent(batchId)}${postIndex ? `&post=${postIndex}` : ""}`;
    get<Record<MemoryCategory, MemoryItem[]>>(`${api}/memory?${q}`)
      .then((m) => live && setMemory(m))
      .catch(() => live && setMemory(null));
    return () => {
      live = false;
    };
  }, [clientId, batchId, postIndex]);
  if (!memory) return null;
  const active = MEMORY_CATEGORIES.flatMap((c) => memory[c] ?? []).filter((i) => i.status === "approved");
  const conflicts = conflictsBetween(active);
  if (!active.length) return null;
  return (
    <div className="mem-relevant">
      <h5>
        Rules for {postIndex ? `post ${postIndex}` : "this month"} <em>{active.length}</em>
      </h5>
      <ul>
        {active.map((i) => (
          <li key={i.id} data-category={i.category}>
            <span className="mem-relevant-cat">{i.category === "brand_rule" ? "brand" : i.category === "campaign_instruction" ? "month" : i.category === "post_instruction" ? "post" : "lesson"}</span>
            <span dir="auto">{i.text}</span>
          </li>
        ))}
      </ul>
      {conflicts.length > 0 && (
        <ul className="mem-relevant-conflicts">
          {conflicts.map((c, k) => (
            <li key={`${c.forbids.id}-${c.asks.id}-${k}`}>
              Conflict about <strong>{c.about}</strong>: “{c.forbids.text}” vs “{c.asks.text}”.
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
