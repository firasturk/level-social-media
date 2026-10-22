import { useEffect, useRef, useState } from "react";
import { Check, LogIn, LogOut, Plug, Trash2, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Orb } from "@/components/Orb";
import { askConfirm } from "@/lib/confirm";
import { del, get, post } from "@/api";

/**
 * Connection → Freepik → "Magnific MCP": the MCP tools (stock, image, video, audio on the Magnific
 * credit balance) run on a sign-in to the Magnific account. "Sign in to Magnific" opens Magnific's
 * own sign-in in a new tab; the studio registers itself as an OAuth client once and never asks
 * anyone to paste a token. When Magnific refuses that redirect, the same button falls back to a
 * code to type on a Magnific page. The signed-in state says who, and until when if the sign-in
 * cannot renew itself (no refresh token). "Advanced: paste a token" keeps the old path for one
 * release. The same block as Higgsfield's (HiggsfieldSignIn.tsx), on the same classes.
 */

export interface MagnificSignInStatus {
  signedIn: boolean;
  /** The access token expired and no refresh token can renew it: sign in again. */
  expired: boolean;
  email: string | null;
  signedInAt: number | null;
  expiresAt: number | null;
  /** True when a refresh token exists (the sign-in renews itself). */
  refresh: boolean;
  scope: string | null;
  /** A token pasted by hand is saved too (the advanced path). */
  token: boolean;
  /** Which credential the tools run on. */
  source: "signin" | "token" | null;
  admin: boolean;
  switch: { enabled: boolean };
  access: { admin: boolean; enabled: boolean; reason: string };
  url: string;
  /** A device-flow sign-in in progress (the fallback when the redirect registration is refused). */
  device: Device | null;
}

type Device = { userCode: string; verificationUri: string; verificationUriComplete: string | null; interval: number; expires: number; refused: string };
type Start = { mode: "redirect"; url: string } | ({ mode: "device" } & Device);

const BASE = "/api/studio/freepik/mcp";
export const magnificStatus = () => get<MagnificSignInStatus>(`${BASE}/status`);

/** "22 Oct, 14:05" in the viewer's zone. */
function when(ms: number): string {
  return new Date(ms).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export default function MagnificSignIn({ onChanged }: { onChanged: () => void }) {
  const [status, setStatus] = useState<MagnificSignInStatus | null>(null);
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<null | { since: number }>(null);
  const [device, setDevice] = useState<Device | null>(null);
  const [error, setError] = useState("");
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = () => {
    setTick((t) => t + 1);
    onChanged();
  };
  useEffect(() => {
    let live = true;
    magnificStatus()
      .then((s) => {
        if (!live) return;
        setStatus(s);
        if (s.device) setDevice(s.device);
      })
      .catch(() => live && setStatus(null));
    return () => {
      live = false;
    };
  }, [tick]);

  const stop = () => {
    if (timer.current) clearInterval(timer.current);
    timer.current = null;
    setWaiting(null);
  };
  useEffect(() => stop, []);
  // The new tab signs in; this page asks the server every few seconds until it says so (five minutes at most).
  useEffect(() => {
    if (!waiting) return;
    timer.current = setInterval(() => {
      if (Date.now() - waiting.since > 5 * 60_000) {
        stop();
        setError("The sign-in did not finish in five minutes. Press Sign in to Magnific again when ready.");
        return;
      }
      magnificStatus()
        .then((s) => {
          if (s.signedIn) {
            stop();
            toast.success("Signed in to Magnific: the MCP tools run on that account.");
            refresh();
          }
        })
        .catch(() => undefined);
    }, 3000);
    return stop;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting]);
  // The device flow: the token endpoint is asked every `interval` seconds while the code is typed.
  useEffect(() => {
    if (!device) return;
    let cancelled = false;
    let delay = device.interval * 1000;
    const poll = async () => {
      if (cancelled) return;
      try {
        const r = await post<{ signedIn: boolean; pending?: boolean; interval?: number }>(`${BASE}/signin/poll`);
        if (r.signedIn) {
          setDevice(null);
          toast.success("Signed in to Magnific: the MCP tools run on that account.");
          refresh();
          return;
        }
        if (r.interval) delay = r.interval * 1000;
      } catch (e) {
        setDevice(null);
        setError((e as Error).message);
        return;
      }
      if (!cancelled) setTimeout(() => void poll(), delay);
    };
    const t = setTimeout(() => void poll(), delay);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [device?.userCode]);

  async function signIn() {
    setBusy(true);
    setError("");
    try {
      const r = await post<Start>(`${BASE}/signin/start`);
      if (r.mode === "redirect") {
        const tab = window.open(r.url, "_blank", "noopener");
        if (!tab) setError(`The browser blocked the new tab. Open this link to sign in: ${r.url}`);
        setWaiting({ since: Date.now() });
      } else {
        setDevice(r);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function signOut() {
    if (!(await askConfirm("Sign out of Magnific? The MCP tools stop until someone signs in again (a pasted token, if one is saved, is used meanwhile)."))) return;
    try {
      await post(`${BASE}/signout`);
      toast.success("Signed out of Magnific.");
      refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function saveToken() {
    setSaving(true);
    try {
      const r = await post<{ ok: boolean; tools: number }>(`${BASE}/token`, { token });
      setToken("");
      refresh();
      toast.success(`Magnific MCP token saved: ${r.tools} tools listed.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function removeToken() {
    if (!(await askConfirm(status?.signedIn ? "Remove the pasted Magnific MCP token? The tools keep running on the sign-in." : "Remove the pasted Magnific MCP token? The MCP tools go back to Not connected until someone signs in."))) return;
    try {
      await del(`${BASE}/token`);
      refresh();
      toast.success("Magnific MCP token removed.");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const admin = status?.admin ?? true;
  const until = status?.expiresAt ? when(status.expiresAt) : null;
  return (
    <div className="hf-signin">
      <div className="qa-heading">
        <Plug size={18} />
        <strong>Magnific MCP (mcp.magnific.com)</strong>
      </div>
      <p className="quality-note">
        The MCP tools (stock, image, video, audio) run on a sign-in to the Magnific account, under the Freepik panel's governance: browsing is free, a download follows the plan, anything generative is estimated and confirmed first. Press the button: Magnific's own sign-in opens in a new tab, and this page updates when it is done. Nothing is typed here.
      </p>
      {status?.access && !status.access.enabled && <p className="image-error">{status.access.reason}</p>}
      {!status ? (
        <p className="quality-note">
          <Orb size={14} /> Reading the Magnific sign-in…
        </p>
      ) : status.signedIn ? (
        <div className="success-note hf-signed">
          <Check size={19} />
          <span>
            Signed in{status.email ? ` as ${status.email}` : ""}
            {status.refresh ? " · the sign-in renews itself" : until ? ` · until ${until} (Magnific gave no refresh token: sign in again after that)` : ""}
            {status.token ? " · a pasted token is saved too and can be removed under Advanced" : ""}
          </span>
        </div>
      ) : status.expired ? (
        <p className="field-hint warn">
          <TriangleAlert size={13} /> The sign-in expired{until ? ` at ${until}` : ""} and could not renew itself: press Sign in to Magnific again.
          {status.token ? " Meanwhile the tools run on the pasted token." : ""}
        </p>
      ) : status.token ? (
        <p className="quality-note">
          <b>Running on a pasted token</b> (the old path, kept for one release). Sign in instead: the sign-in renews itself and the token can then be removed under Advanced.
        </p>
      ) : (
        <p className="quality-note">
          <b>Not signed in.</b> The MCP tools answer Not connected until someone signs in.
        </p>
      )}
      {admin && (
        <div className="footer-actions">
          {status?.signedIn ? (
            <button type="button" className="secondary danger" onClick={() => void signOut()}>
              <LogOut size={15} /> Sign out
            </button>
          ) : (
            <button type="button" className="primary" onClick={() => void signIn()} disabled={busy || !!waiting || !!device || status?.switch.enabled === false}>
              {busy || waiting ? <Orb size={15} /> : <LogIn size={15} />} Sign in to Magnific
            </button>
          )}
          {waiting && (
            <small className="field-hint">
              A Magnific tab opened. Sign in there; this page updates by itself.{" "}
              <button type="button" className="text-button" onClick={stop}>
                Cancel
              </button>
            </small>
          )}
        </div>
      )}
      {device && (
        <div className="hf-device">
          <p className="field-hint warn">
            <TriangleAlert size={13} /> {device.refused} The sign-in continues with a code instead.
          </p>
          <p>
            Open{" "}
            <a href={device.verificationUriComplete ?? device.verificationUri} target="_blank" rel="noreferrer" className="text-link">
              {device.verificationUri}
            </a>{" "}
            and type this code:
          </p>
          <code className="hf-code">{device.userCode}</code>
          <small className="field-hint">
            <Orb size={12} /> Waiting for Magnific… the code expires at {new Date(device.expires).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}.
          </small>
        </div>
      )}
      {error && (
        <p className="image-error">
          <TriangleAlert size={14} /> {error}
        </p>
      )}
      {admin && (
        <details className="prompt-details">
          <summary>Advanced: paste a token</summary>
          <p className="field-hint">
            The old path, kept for one release: a bearer access token obtained by hand for the Magnific account (docs/freepik.md). It is checked with initialize and tools/list, which cost nothing, then stored encrypted; it is not refreshed. The sign-in above is used whenever one exists.
          </p>
          <div className="footer-actions">
            <input id="freepik-mcp-token" type="password" autoComplete="off" placeholder="eyJ…" aria-label="Magnific MCP bearer token" value={token} onChange={(e) => setToken(e.target.value.trim())} />
            <button type="button" className="secondary" onClick={() => void saveToken()} disabled={saving || token.length < 20}>
              {saving ? <Orb size={17} /> : <Plug size={17} />}
              {status?.token ? "Replace" : "Save"}
            </button>
            {status?.token && (
              <button type="button" className="secondary danger" onClick={() => void removeToken()} aria-label="Remove Magnific MCP token">
                <Trash2 size={17} />
              </button>
            )}
          </div>
        </details>
      )}
      {!admin && <small className="field-hint">Admins only for now: the sign-in is limited to admins.</small>}
    </div>
  );
}
