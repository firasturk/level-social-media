import { useEffect, useState } from "react";
import { Check, KeyRound, LogIn, PlugZap, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Orb } from "@/components/Orb";
import { askConfirm } from "@/lib/confirm";
import { del, get, post, put } from "@/api";

/**
 * Connection → Pinterest (server/pinterest.ts): Pinterest's official API, used to read a pin's
 * video for the video editor's "Edit like this video". The admin pastes the access token, and
 * ideally the app id, app secret and refresh token so the access token renews itself; or saves the
 * app id and secret and signs in with Pinterest. Everything is stored encrypted on the server and
 * never comes back to the browser. Admins only.
 */

export interface PinterestStatus {
  state: "connected" | "not_connected" | "expired";
  admin: boolean;
  access: { admin: boolean; enabled: boolean; reason: string };
  account?: { username: string; name: string } | null;
  expires?: number | null;
  refreshExpires?: number | null;
  autoRenew?: boolean;
  hasToken?: boolean;
  hasRefreshToken?: boolean;
  appId?: string | null;
  hasAppSecret?: boolean;
  scopes?: string;
  redirectUri?: string;
}

export function usePinterestStatus(open: boolean): [PinterestStatus | null, () => void] {
  const [status, setStatus] = useState<PinterestStatus | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    get<PinterestStatus>("/api/studio/pinterest/status")
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [open, tick]);
  return [status, () => setTick((t) => t + 1)];
}

const day = (t: number) => new Date(t).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

export default function PinterestConnection({ status, onChanged }: { status: PinterestStatus | null; onChanged: () => void }) {
  const [accessToken, setAccessToken] = useState("");
  const [appId, setAppId] = useState("");
  const [appSecret, setAppSecret] = useState("");
  const [refreshToken, setRefreshToken] = useState("");
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null);

  if (status && !status.admin)
    return (
      <>
        <div className="qa-heading" style={{ marginTop: 12 }}>
          <KeyRound size={18} />
          <strong>Pinterest (pin videos for the video editor)</strong>
        </div>
        <p className="quality-note">
          <b>Admins only for now.</b> {status.state === "connected" ? "Pinterest is connected." : "Pinterest is not connected yet."}
        </p>
      </>
    );

  async function save() {
    setBusy("save");
    setNote(null);
    try {
      const body: Record<string, string> = {};
      if (accessToken) body.accessToken = accessToken;
      if (appId) body.appId = appId;
      if (appSecret) body.appSecret = appSecret;
      if (refreshToken) body.refreshToken = refreshToken;
      const r = await put<PinterestStatus>("/api/studio/pinterest", body);
      setAccessToken("");
      setAppSecret("");
      setRefreshToken("");
      setAppId("");
      toast.success(r.account ? `Pinterest connected as @${r.account.username}.` : "Saved. Sign in with Pinterest to finish.");
      onChanged();
    } catch (e) {
      setNote({ ok: false, message: (e as Error).message });
    } finally {
      setBusy("");
    }
  }

  async function test() {
    setBusy("test");
    setNote(null);
    try {
      const r = await post<{ ok: boolean; message: string }>("/api/studio/pinterest/test", {});
      setNote({ ok: true, message: r.message });
      onChanged();
    } catch (e) {
      setNote({ ok: false, message: (e as Error).message });
      onChanged();
    } finally {
      setBusy("");
    }
  }

  async function signIn() {
    setBusy("signin");
    try {
      const r = await post<{ url: string }>("/api/studio/pinterest/signin/start", {});
      window.location.assign(r.url);
    } catch (e) {
      setNote({ ok: false, message: (e as Error).message });
      setBusy("");
    }
  }

  async function remove() {
    if (!(await askConfirm("Disconnect Pinterest? The tokens, app id and app secret are deleted from the server. Pin links go back to reading the pin page, which often fails."))) return;
    try {
      await del("/api/studio/pinterest");
      setNote(null);
      onChanged();
      toast.success("Pinterest disconnected.");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const s = status;
  const canSave = !!(accessToken || appId || appSecret || refreshToken) && !busy;
  return (
    <>
      <div className="qa-heading" style={{ marginTop: 12 }}>
        <KeyRound size={18} />
        <strong>Pinterest (pin videos for the video editor)</strong>
      </div>
      {s?.access && !s.access.enabled && <p className="image-error">{s.access.reason}</p>}
      {s?.state === "connected" ? (
        <div className="success-note">
          <Check size={19} />
          <span>
            Connected{s.account ? ` as ${s.account.name}${s.account.name !== s.account.username ? ` (@${s.account.username})` : ""}` : ""}.{" "}
            {s.autoRenew
              ? `The access token renews itself${s.refreshExpires ? ` (the refresh token is good until ${day(s.refreshExpires)} and is renewed with it)` : ""}.`
              : s.expires
                ? `The access token lasts until ${day(s.expires)}; add the app id, app secret and refresh token to renew it automatically.`
                : "Pinterest access tokens last 30 days; add the app id, app secret and refresh token to renew it automatically."}
          </span>
        </div>
      ) : s?.state === "expired" ? (
        <div className="error-banner">
          <TriangleAlert size={18} />
          Token expired. Paste a new access token, or sign in with Pinterest again.
        </div>
      ) : (
        <p className="quality-note">
          <b>Not connected.</b> "Edit like this video" then tries to read the pin page, which Pinterest usually refuses.
        </p>
      )}
      <ol className="meta-steps">
        <li>
          At{" "}
          <a className="text-link" href="https://developers.pinterest.com/apps/" target="_blank" rel="noreferrer">
            developers.pinterest.com/apps
          </a>
          , sign in with the Pinterest account to connect and create an app (Pinterest reviews it before it can be used).
        </li>
        <li>
          In the app, add this redirect URI: <code>{s?.redirectUri ?? "…/api/studio/pinterest/callback"}</code>. The scopes used are <code>{s?.scopes ?? "boards:read,pins:read,user_accounts:read"}</code>.
        </li>
        <li>Paste the app id and app secret below and press Save, then Sign in with Pinterest: the access and refresh tokens are kept and renewed by themselves. Or paste an access token generated in the app (with those scopes); it lasts 30 days.</li>
        <li>Pinterest's API reads the pins the connected account can see on its own boards: save a pin to one of its boards before pasting its link.</li>
      </ol>
      <div className="pinterest-fields" style={{ display: "grid", gap: 8 }}>
        <input type="password" autoComplete="off" placeholder={s?.hasToken ? "Access token saved · paste a new one to replace it" : "Access token (pina…)"} aria-label="Pinterest access token" value={accessToken} onChange={(e) => setAccessToken(e.target.value.trim())} />
        <input autoComplete="off" inputMode="numeric" placeholder={s?.appId ? `App id ${s.appId} · paste another to replace it` : "App id"} aria-label="Pinterest app id" value={appId} onChange={(e) => setAppId(e.target.value.trim())} />
        <input type="password" autoComplete="off" placeholder={s?.hasAppSecret ? "App secret saved · paste a new one to replace it" : "App secret"} aria-label="Pinterest app secret" value={appSecret} onChange={(e) => setAppSecret(e.target.value.trim())} />
        <input type="password" autoComplete="off" placeholder={s?.hasRefreshToken ? "Refresh token saved · paste a new one to replace it" : "Refresh token (pinr…), optional"} aria-label="Pinterest refresh token" value={refreshToken} onChange={(e) => setRefreshToken(e.target.value.trim())} />
      </div>
      <div className="footer-actions">
        {s && s.state !== "not_connected" && (
          <button className="secondary danger" onClick={() => void remove()} aria-label="Disconnect Pinterest">
            <Trash2 size={17} />
          </button>
        )}
        <span style={{ flex: 1 }} />
        {s?.appId && s.hasAppSecret && (
          <button className="secondary" disabled={!!busy} onClick={() => void signIn()}>
            {busy === "signin" ? <Orb size={17} /> : <LogIn size={17} />} Sign in with Pinterest
          </button>
        )}
        {s && s.state !== "not_connected" && (
          <button className="secondary" disabled={!!busy} onClick={() => void test()}>
            {busy === "test" ? <Orb size={17} /> : <PlugZap size={17} />} Test the connection
          </button>
        )}
        <button className="primary" disabled={!canSave} onClick={() => void save()}>
          {busy === "save" ? <Orb size={17} /> : <Check size={17} />} Save
        </button>
      </div>
      {note && <p className={note.ok ? "quality-note" : "image-error"} role={note.ok ? "status" : "alert"}>{note.message}</p>}
      <p className="prompt-tip">Everything pasted here is checked with Pinterest, then stored encrypted on the server; it never comes back to the browser. Reading pins costs nothing.</p>
    </>
  );
}
