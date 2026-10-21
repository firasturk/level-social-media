import { askConfirm } from "@/lib/confirm";
import SystemCheck from "./SystemCheck";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Bell,
  Check,
  Clapperboard,
  ShieldCheck,
  Trash2,
  UserX,
  UserCheck,
} from "lucide-react";
import { Orb } from "@/components/Orb";
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
  workflowV2: boolean;
  autopilotReview: boolean;
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
        workflowV2: d.settings.workflowV2,
        autopilotReview: d.settings.autopilotReview,
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

      <section className="batches-page admin-settings">
        <div className="panel-heading" style={{ padding: "8px 16px 0" }}>
          <Clapperboard size={18} />
          <h2>Studio hero video</h2>
        </div>
        <div className="hero-admin">
          {hero ? (
            <video key={hero} className="hero-preview" autoPlay muted loop playsInline>
              <source src={`/api/studio/hero?f=webm&v=${hero}`} type="video/webm" />
              <source src={`/api/studio/hero?v=${hero}`} type="video/mp4" />
            </video>
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
          <label className="check-row">
            <input type="checkbox" checked={!!form.workflowV2} onChange={(e) => setForm({ ...form, workflowV2: e.target.checked })} />
            <span>
              <span className="field-label">Four-stage workflow</span>
              <small>Start, Direction, Plan, Studio instead of the journey, for everyone on the team. The classic journey stays one click away in the Studio.</small>
            </span>
          </label>
          <label className="check-row">
            <input type="checkbox" checked={!!form.autopilotReview} onChange={(e) => setForm({ ...form, autopilotReview: e.target.checked })} />
            <span>
              <span className="field-label">Autopilot reviews before paying</span>
              <small>Autopilot plans the month and stops at the plan with its estimate; a person presses Generate. Off: it generates by itself, under the spend threshold above.</small>
            </span>
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
