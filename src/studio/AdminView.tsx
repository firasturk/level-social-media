import { askConfirm } from "@/lib/confirm";
import SystemCheck from "./SystemCheck";
import IntegrationsPanel from "./IntegrationsPanel";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Bell,
  Check,
  Clapperboard,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  UserX,
  UserCheck,
} from "lucide-react";
import { Orb } from "@/components/Orb";
import { AutoplayVideo } from "@/components/AutoplayVideo";
import { del, get, post, postForm } from "@/api";

interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
  disabled: number;
  created: number;
  last_seen: number | null;
  batches: number;
  images: number;
  spent: number;
}

interface AdminSettings {
  inviteCode: string;
  spendThreshold: number;
  pricing?: "everyone" | "admins";
  retentionDays: number;
  notifyWebhook: string;
  notifyEmail: string;
  resendConfigured: boolean;
}

export default function AdminView({ me }: { me: string }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [form, setForm] = useState<Partial<AdminSettings> & { resendApiKey?: string }>({});
  const [saving, setSaving] = useState(false);
  const [hero, setHero] = useState<string>("");
  const [heroBusy, setHeroBusy] = useState(false);
  useEffect(() => {
    get<{ hero?: string }>("/api/studio/state")
      .then((d) => setHero(d.hero ?? ""))
      .catch(() => {});
  }, []);
  const uploadHero = async (file: File | null) => {
    if (!file) return;
    setHeroBusy(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const r = await postForm<{ hero: string }>("/api/admin/hero", fd);
      setHero(r.hero);
      toast.success("Hero video updated. Reload the studio to see it.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setHeroBusy(false);
    }
  };
  const removeHero = async () => {
    setHeroBusy(true);
    try {
      await del("/api/admin/hero");
      setHero("");
      toast.success("Hero video removed.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setHeroBusy(false);
    }
  };

  async function load() {
    try {
      const d = await get<{ users: AdminUser[]; settings: AdminSettings }>("/api/admin/users");
      setUsers(d.users);
      setSettings(d.settings);
      setForm({
        inviteCode: d.settings.inviteCode,
        spendThreshold: d.settings.spendThreshold,
        pricing: d.settings.pricing ?? "everyone",
        retentionDays: d.settings.retentionDays,
        notifyWebhook: d.settings.notifyWebhook,
        notifyEmail: d.settings.notifyEmail,
      });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function save() {
    setSaving(true);
    try {
      await post("/api/admin/settings", form);
      toast.success("Settings saved.");
      await load();
      setForm((f) => ({ ...f, resendApiKey: undefined }));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function toggle(u: AdminUser) {
    try {
      await post("/api/admin/users/disable", { id: u.id, disabled: !u.disabled });
      // Someone leaving: offer to keep their months in the studio under your name.
      if (!u.disabled && u.batches > 0 && (await askConfirm(`${u.name} is signed out and can no longer sign in. Move their ${u.batches} month${u.batches > 1 ? "s" : ""} to you so the work stays in the studio?`, { ok: "Move to me", danger: false })))
        await transfer(u, true);
      else if (!u.disabled) toast.success(`${u.name} is signed out and can no longer sign in.`);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function transfer(u: AdminUser, asked = false) {
    if (!asked && !(await askConfirm(`Move ${u.name}'s ${u.batches} month${u.batches > 1 ? "s" : ""} to you?`, { ok: "Move to me", danger: false }))) return;
    try {
      const r = await post<{ moved: number }>("/api/admin/users/transfer", { id: u.id });
      toast.success(`${r.moved} month${r.moved === 1 ? "" : "s"} moved to you.`);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function role(u: AdminUser) {
    try {
      await post("/api/admin/users/role", {
        id: u.id,
        role: u.role === "admin" ? "member" : "admin",
      });
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const totalSpent = users.reduce((n, u) => n + (u.spent || 0), 0);

  return (
    <div className="admin">
      <SystemCheck />
      <Problems />
      <section className="batches-page">
        <div className="panel-heading" style={{ padding: "8px 16px 0" }}>
          <ShieldCheck size={18} />
          <h2>Team</h2>
          <span className="quality-note" style={{ marginLeft: "auto" }}>
            Total estimated spend ≈ ${totalSpent.toFixed(2)}
          </span>
        </div>
        <div className="batches-table admin-table" role="table">
          <div className="batches-head" role="row">
            <span>User</span>
            <span>Role</span>
            <span>Batches</span>
            <span>Images</span>
            <span>Spent</span>
            <span>Last seen</span>
            <span />
          </div>
          {users.map((u) => (
            <div className={`batches-row ${u.disabled ? "disabled" : ""}`} role="row" key={u.id}>
              <span className="batches-name">
                <strong>{u.name}</strong>
                <small>{u.email}</small>
              </span>
              <span>{u.role}</span>
              <span>{u.batches}</span>
              <span>{u.images}</span>
              <span>≈ ${(u.spent || 0).toFixed(2)}</span>
              <span>{u.last_seen ? new Date(u.last_seen).toLocaleString("en-GB") : "never"}</span>
              <span className="footer-actions">
                {u.id !== me && (
                  <>
                    {u.batches > 0 && (
                      <button className="secondary" onClick={() => void transfer(u)} title="Move this person's months to you">
                        Move months to me
                      </button>
                    )}
                    <button className="secondary" onClick={() => void role(u)} title="Toggle admin">
                      {u.role === "admin" ? "Make member" : "Make admin"}
                    </button>
                    <button
                      className={`secondary ${u.disabled ? "" : "danger"}`}
                      onClick={() => void toggle(u)}
                    >
                      {u.disabled ? <UserCheck size={15} /> : <UserX size={15} />}
                      {u.disabled ? "Enable" : "Disable"}
                    </button>
                  </>
                )}
              </span>
            </div>
          ))}
        </div>
      </section>

      <IntegrationsPanel />

      <section className="batches-page admin-settings">
        <div className="panel-heading" style={{ padding: "8px 16px 0" }}>
          <Clapperboard size={18} />
          <h2>Studio hero video</h2>
        </div>
        <div className="hero-admin">
          {hero ? (
            <AutoplayVideo key={hero} className="hero-preview" src={`/api/studio/hero?v=${hero}`} fallbackSrc={`/api/studio/hero?f=webm&v=${hero}`} decorative label="Studio hero video" />
          ) : (
            <p className="quality-note">
              No video yet. Upload a short looping MP4 or WebM (under 40 MB) to show it under the
              studio title.
            </p>
          )}
          <div className="footer-actions">
            <label className="secondary">
              {heroBusy ? (
                <Orb size={16} />
              ) : (
                <Clapperboard size={16} />
              )}
              {hero ? "Replace video" : "Upload video"}
              <input
                type="file"
                accept="video/mp4,video/webm,video/quicktime"
                hidden
                disabled={heroBusy}
                onChange={(e) => {
                  void uploadHero(e.target.files?.[0] ?? null);
                  e.target.value = "";
                }}
              />
            </label>
            {hero && (
              <button
                className="text-button danger-text"
                onClick={() => void removeHero()}
                disabled={heroBusy}
              >
                <Trash2 size={14} /> Remove
              </button>
            )}
          </div>
        </div>
      </section>

      <section className="batches-page admin-settings">
        <div className="panel-heading" style={{ padding: "8px 16px 0" }}>
          <Bell size={18} />
          <h2>Workspace settings</h2>
        </div>
        <div className="admin-grid">
          <label>
            <span className="field-label">Invite code for new accounts</span>
            <input
              value={form.inviteCode ?? ""}
              onChange={(e) => setForm({ ...form, inviteCode: e.target.value })}
            />
            <small>Empty closes registration.</small>
          </label>
          <label>
            <span className="field-label">Ask before spending more than ($)</span>
            <input
              type="number"
              min={0}
              value={form.spendThreshold ?? 20}
              onChange={(e) => setForm({ ...form, spendThreshold: Number(e.target.value) })}
            />
            <small>A confirmation appears when a run's estimate exceeds this.</small>
          </label>
          <label>
            <span className="field-label">Who sees prices</span>
            <select value={form.pricing ?? "everyone"} onChange={(e) => setForm({ ...form, pricing: e.target.value as "everyone" | "admins" })}>
              <option value="everyone">Everyone on the team</option>
              <option value="admins">Admins only</option>
            </select>
            <small>Admins only: the team sees "cost shown to admins" where an amount would be, and in the video and AI tools no credits, no balance and no "Get the cost" step. Every run is still confirmed and recorded with its cost.</small>
          </label>
          <label>
            <span className="field-label">Delete batches after (days)</span>
            <input
              type="number"
              min={0}
              value={form.retentionDays ?? 90}
              onChange={(e) => setForm({ ...form, retentionDays: Number(e.target.value) })}
            />
            <small>
              Originals and results of batches untouched for this long are removed. 0 keeps
              everything.
            </small>
          </label>
          <label>
            <span className="field-label">Slack / Discord webhook URL</span>
            <input
              value={form.notifyWebhook ?? ""}
              placeholder="https://hooks.slack.com/..."
              onChange={(e) => setForm({ ...form, notifyWebhook: e.target.value })}
            />
            <small>Sent when a batch finishes or pauses with an error.</small>
          </label>
          <label>
            <span className="field-label">Notification email(s)</span>
            <input
              value={form.notifyEmail ?? ""}
              placeholder="name@company.com, other@company.com"
              onChange={(e) => setForm({ ...form, notifyEmail: e.target.value })}
            />
            <small>Needs a Resend API key below.</small>
          </label>
          <label>
            <span className="field-label">
              Resend API key {settings?.resendConfigured ? "(saved)" : ""}
            </span>
            <input
              type="password"
              autoComplete="off"
              placeholder={settings?.resendConfigured ? "•••••• (leave empty to keep)" : "re_..."}
              value={form.resendApiKey ?? ""}
              onChange={(e) => setForm({ ...form, resendApiKey: e.target.value })}
            />
            <small>Free at resend.com; used only for the emails above.</small>
          </label>
        </div>
        <div className="footer-actions" style={{ padding: "0 16px 8px" }}>
          <button className="primary" onClick={() => void save()} disabled={saving}>
            {saving ? <Orb size={16} /> : <Check size={16} />} Save
            settings
          </button>
          <button
            className="secondary"
            onClick={() =>
              post("/api/admin/notify/test")
                .then(() => toast.success("Test notification sent."))
                .catch((e) => toast.error(e.message))
            }
          >
            <Bell size={16} /> Send test notification
          </button>
        </div>
      </section>
    </div>
  );
}

/** One problem as the error log groups it (server/error-log.ts): the same message, whoever met it. */
interface ProblemGroup {
  fingerprint: string;
  kind: "toast" | "crash" | "network" | "server";
  message: string;
  count: number;
  users: string[];
  first: number;
  last: number;
  screen: string | null;
  detail: string | null;
}

interface ProblemRow {
  id: string;
  at: number;
  user_name: string | null;
  screen: string | null;
  message: string;
  detail: string | null;
  build: string | null;
}

interface ProblemSummary {
  groups: ProblemGroup[];
  last24h: number;
  total: number;
}

const PROBLEM_KIND: Record<ProblemGroup["kind"], string> = {
  toast: "Message shown",
  crash: "Screen broke",
  network: "No connection",
  server: "Server error",
};
const PROBLEM_COLUMNS = { gridTemplateColumns: "minmax(0, 3fr) 0.9fr 0.5fr 1.1fr 0.9fr 124px" };
const PROBLEMS_SHOWN = 25;

function timeAgo(at: number): string {
  const min = Math.round((Date.now() - at) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

const plural = (n: number) => `${n} problem${n === 1 ? "" : "s"}`;

/**
 * Problems the team hit: every error message a person was shown, every screen that broke, every
 * request that got no answer and every server error of the last 14 days, the same problem on one
 * row. A row opens its latest occurrences; "Resolved" clears it once it is dealt with.
 */
function Problems() {
  const [data, setData] = useState<ProblemSummary | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState("");
  /** The row opened last: an answer for a row closed since is not shown under another. */
  const wanted = useRef("");
  const [rows, setRows] = useState<ProblemRow[] | null>(null);
  const [all, setAll] = useState(false);
  const [clearing, setClearing] = useState("");

  async function load() {
    try {
      setData(await get<ProblemSummary>("/api/admin/errors"));
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function toggle(g: ProblemGroup) {
    if (open === g.fingerprint) {
      wanted.current = "";
      return setOpen("");
    }
    wanted.current = g.fingerprint;
    setOpen(g.fingerprint);
    setRows(null);
    const found = await get<{ rows: ProblemRow[] }>(`/api/admin/errors?fingerprint=${encodeURIComponent(g.fingerprint)}`)
      .then((r) => r.rows)
      .catch(() => [] as ProblemRow[]);
    if (wanted.current === g.fingerprint) setRows(found);
  }

  async function resolve(g: ProblemGroup) {
    setClearing(g.fingerprint);
    try {
      await post("/api/admin/errors/clear", { fingerprint: g.fingerprint });
      if (open === g.fingerprint) {
        wanted.current = "";
        setOpen("");
      }
      toast.success("Marked as resolved. It comes back here if it happens again.");
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setClearing("");
    }
  }

  const groups = data?.groups ?? [];
  const shown = all ? groups : groups.slice(0, PROBLEMS_SHOWN);

  return (
    <section className="batches-page">
      <div className="panel-heading" style={{ padding: "8px 16px 0" }}>
        <TriangleAlert size={18} />
        <h2>Problems the team hit</h2>
        {data && (
          <span className="quality-note" style={{ marginLeft: "auto" }}>
            {plural(data.last24h)} in the last 24 hours, {data.total} in 14 days
          </span>
        )}
      </div>
      {failed && !data && (
        <p className="quality-note" style={{ padding: "0 16px" }}>
          The list could not be loaded. Reload the page to try again.
        </p>
      )}
      {data && !groups.length && (
        <p className="quality-note" style={{ padding: "0 16px" }}>
          No problems recorded.
        </p>
      )}
      {groups.length > 0 && (
        <div className="batches-table" role="table">
          <div className="batches-head" role="row" style={PROBLEM_COLUMNS}>
            <span>What they saw</span>
            <span>Kind</span>
            <span>Times</span>
            <span>Who</span>
            <span>Last</span>
            <span />
          </div>
          {shown.map((g) => (
            <div key={g.fingerprint}>
              <div className="batches-row" role="row" style={{ ...PROBLEM_COLUMNS, cursor: "pointer" }} onClick={() => void toggle(g)}>
                <span className="batches-name" style={{ minWidth: 0 }}>
                  <span>
                    <button
                      type="button"
                      aria-expanded={open === g.fingerprint}
                      title="Show the latest times this happened"
                      style={{ padding: 0, background: "transparent", textAlign: "left", font: "inherit", fontWeight: 600, color: "inherit", overflowWrap: "anywhere" }}
                    >
                      {g.message.length > 180 ? `${g.message.slice(0, 180)}…` : g.message}
                    </button>
                    {g.screen && <small style={{ overflowWrap: "anywhere" }}>{g.screen}</small>}
                  </span>
                </span>
                <span>{PROBLEM_KIND[g.kind] ?? g.kind}</span>
                <span>{g.count}×</span>
                <span style={{ overflowWrap: "anywhere" }}>{g.users.length ? g.users.join(", ") : "Not signed in"}</span>
                <span title={new Date(g.last).toLocaleString("en-GB")}>{timeAgo(g.last)}</span>
                <span className="footer-actions">
                  <button
                    type="button"
                    className="secondary"
                    disabled={clearing === g.fingerprint}
                    title="Clear this problem from the list. It comes back if it happens again."
                    onClick={(e) => {
                      e.stopPropagation();
                      void resolve(g);
                    }}
                  >
                    {clearing === g.fingerprint ? <Orb size={15} /> : <Check size={15} />} Resolved
                  </button>
                </span>
              </div>
              {open === g.fingerprint && (
                <div style={{ padding: "4px 16px 14px", borderBottom: "1px solid var(--border)", fontSize: 13 }}>
                  {!rows ? (
                    <span className="quality-note">Loading…</span>
                  ) : !rows.length ? (
                    <span className="quality-note">Nothing more is recorded for this one.</span>
                  ) : (
                    rows.slice(0, 5).map((r) => (
                      <div key={r.id} style={{ padding: "8px 0", borderTop: "1px solid var(--border)" }}>
                        <div>
                          <strong>{new Date(r.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</strong>
                          {" · "}
                          {r.user_name ?? "Not signed in"}
                          {r.screen ? ` · ${r.screen}` : ""}
                          {r.build ? ` · version ${r.build}` : ""}
                        </div>
                        {r.message !== g.message && <div style={{ marginTop: 4, overflowWrap: "anywhere" }}>{r.message}</div>}
                        {r.detail && (
                          <pre style={{ margin: "6px 0 0", padding: "8px 10px", background: "var(--surface-2)", borderRadius: 8, fontSize: 12, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>
                            {r.detail}
                          </pre>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {groups.length > PROBLEMS_SHOWN && (
        <div style={{ padding: "10px 16px 0" }}>
          <button type="button" className="text-button" onClick={() => setAll((v) => !v)}>
            {all ? "Show fewer" : `Show all ${groups.length}`}
          </button>
        </div>
      )}
    </section>
  );
}
