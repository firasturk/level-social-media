import { useEffect, useState } from "react";
import { Check, KeyRound, Search, Trash2 } from "lucide-react";
import { Orb } from "@/components/Orb";
import { toast } from "sonner";
import { askConfirm } from "@/lib/confirm";
import { del, get, post, put } from "@/api";

export interface MetaStatus {
  connected: boolean;
  account: { igId: string; username: string; page: string; connected: number; expires: number } | null;
  /** Every Instagram business account behind the token: one of them reads the others. */
  options?: { igId: string; username: string; page: string }[];
}

interface Profile {
  username: string;
  name: string;
  biography: string;
  followers: number;
  posts: number;
  media: { id: string; image: string | null; caption: string; likes: number | null }[];
}

/** The Meta (Instagram) tab of Connection: the token, its account, and a test read of any brand. */
export default function MetaConnection({ status, onChanged }: { status: MetaStatus | null; onChanged: () => void }) {
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [handle, setHandle] = useState("");
  const [reading, setReading] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);

  async function save() {
    setSaving(true);
    try {
      const r = await post<{ account: { username: string; page: string } }>("/api/studio/meta", { token });
      setToken("");
      toast.success(`Instagram connected through @${r.account.username} (${r.account.page}).`);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function choose(igId: string) {
    try {
      const r = await put<{ account: { username: string } }>("/api/studio/meta/account", { igId });
      toast.success(`Instagram is read through @${r.account.username} now.`);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function remove() {
    if (!(await askConfirm("Disconnect Instagram? Client profiles can no longer read Instagram accounts until a new token is saved."))) return;
    try {
      await del("/api/studio/meta");
      setProfile(null);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function read() {
    setReading(true);
    setProfile(null);
    try {
      const r = await get<{ profile: Profile }>(`/api/studio/meta/instagram/${encodeURIComponent(handle.replace(/^@/, ""))}?posts=6`);
      setProfile(r.profile);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setReading(false);
    }
  }

  return (
    <>
      <div className="qa-heading" style={{ marginTop: 12 }}>
        <KeyRound size={18} />
        <strong>Instagram (Meta)</strong>
      </div>
      {status?.connected && status.account ? (
        <div className="success-note">
          <Check size={19} />
          Connected through @{status.account.username} ({status.account.page}),{" "}
          {status.account.expires ? `until ${new Date(status.account.expires).toLocaleDateString()}` : "with no end date"}. Client profiles read public business and
          creator accounts with it.
          {status.account.expires ? " Paste a new extended token before that day." : ""}
        </div>
      ) : (
        <ol className="meta-steps">
          <li>
            Once only:{" "}
            <a className="text-link" href="https://developers.facebook.com/apps/creation/" target="_blank" rel="noreferrer">
              create a Meta app
            </a>{" "}
            named Level Social Media (type Business).
          </li>
          <li>
            <a className="text-link" href="https://developers.facebook.com/tools/explorer/" target="_blank" rel="noreferrer">
              Graph API Explorer
            </a>
            : pick the app, add the permissions instagram_basic, instagram_manage_insights, pages_show_list, pages_read_engagement, business_management and
            ads_read, press Generate Access Token and allow the pages and their Instagram accounts.
          </li>
          <li>
            <a className="text-link" href="https://developers.facebook.com/tools/debug/accesstoken/" target="_blank" rel="noreferrer">
              Access Token Debugger
            </a>
            : paste the token, Debug, then Extend Access Token. Copy the new token and paste it below.
          </li>
        </ol>
      )}
      <div className="footer-actions">
        <input
          type="password"
          autoComplete="off"
          placeholder={status?.connected ? "Paste a new token to replace it" : "EAAG…"}
          aria-label="Meta access token"
          value={token}
          onChange={(e) => setToken(e.target.value.trim())}
        />
        <button className="primary" onClick={() => void save()} disabled={saving || token.length < 40}>
          {saving ? <Orb size={17} /> : <KeyRound size={17} />}
          {status?.connected ? "Replace" : "Connect"}
        </button>
        {status?.connected && (
          <button className="secondary danger" onClick={() => void remove()} aria-label="Disconnect Instagram">
            <Trash2 size={17} />
          </button>
        )}
      </div>
      {status?.connected && (status.options?.length ?? 0) > 1 && (
        <label className="field-label">
          Reads other accounts through
          <select value={status.account?.igId ?? ""} onChange={(e) => void choose(e.target.value)}>
            {status.options!.map((o) => (
              <option key={o.igId} value={o.igId}>
                @{o.username} ({o.page})
              </option>
            ))}
          </select>
        </label>
      )}
      {status?.connected && (
        <>
          <div className="footer-actions">
            <input placeholder="Try an account: nike" aria-label="Instagram username" value={handle} onChange={(e) => setHandle(e.target.value.trim())} />
            <button className="secondary" onClick={() => void read()} disabled={reading || !handle}>
              {reading ? <Orb size={17} /> : <Search size={17} />} Read
            </button>
          </div>
          {profile && (
            <div className="meta-test">
              <strong>
                @{profile.username} · {profile.followers.toLocaleString()} followers · {profile.posts} posts
              </strong>
              <small dir="auto">{profile.biography}</small>
              <div className="meta-test-grid">
                {profile.media.map((m) => (m.image ? <img key={m.id} src={m.image} alt="" title={m.caption.slice(0, 120)} /> : null))}
              </div>
            </div>
          )}
        </>
      )}
    </>
  );
}

/** The connection's state, for the tab's dot. */
export function useMetaStatus(open: boolean): [MetaStatus | null, () => void] {
  const [status, setStatus] = useState<MetaStatus | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    get<MetaStatus>("/api/studio/meta")
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [open, tick]);
  return [status, () => setTick((t) => t + 1)];
}
