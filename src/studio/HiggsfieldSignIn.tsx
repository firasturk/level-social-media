import { useEffect, useRef, useState } from "react";
import { Check, Coins, LogIn, LogOut, RefreshCw, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { Orb } from "@/components/Orb";
import { askConfirm } from "@/lib/confirm";
import { post } from "@/api";
import { mcpStatus, type HiggsfieldBilling, type HiggsfieldMcpStatus } from "./videoApi";

/**
 * Connection → Higgsfield, the top block: the owner's Higgsfield subscription (thousands of
 * credits a month) pays for videos only through a sign-in to the Higgsfield account, never through
 * the Cloud API key below. "Sign in to Higgsfield" opens Higgsfield's own sign-in in a new tab; the
 * studio registers itself as an OAuth client once and never asks anyone to paste a token. When
 * Higgsfield refuses that redirect, the same button falls back to a code to type on a Higgsfield
 * page. Under it, the billing choice: subscription credits or the Cloud API, per clip.
 */

export function useHiggsfieldMcpStatus(open: boolean): [HiggsfieldMcpStatus | null, (fresh?: boolean) => void] {
  const [status, setStatus] = useState<HiggsfieldMcpStatus | null>(null);
  const [tick, setTick] = useState(0);
  const fresh = useRef(false);
  useEffect(() => {
    if (!open) return;
    mcpStatus(fresh.current)
      .then(setStatus)
      .catch(() => setStatus(null));
    fresh.current = false;
  }, [open, tick]);
  return [
    status,
    (f = false) => {
      fresh.current = f;
      setTick((t) => t + 1);
    },
  ];
}

type Start = { mode: "redirect"; url: string } | { mode: "device"; userCode: string; verificationUri: string; verificationUriComplete: string | null; interval: number; expires: number; refused: string };

export default function HiggsfieldSignIn({ status, onChanged }: { status: HiggsfieldMcpStatus | null; onChanged: (fresh?: boolean) => void }) {
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState<null | { since: number }>(null);
  const [device, setDevice] = useState<Extract<Start, { mode: "device" }> | null>(status?.device ? { mode: "device", ...status.device } : null);
  const [error, setError] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

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
        setError("The sign-in did not finish in five minutes. Press Sign in to Higgsfield again when ready.");
        return;
      }
      mcpStatus()
        .then((s) => {
          if (s.signedIn) {
            stop();
            toast.success("Signed in to Higgsfield: videos can use the subscription credits.");
            onChanged(true);
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
        const r = await post<{ signedIn: boolean; pending?: boolean; interval?: number }>("/api/studio/higgsfield/mcp/signin/poll");
        if (r.signedIn) {
          setDevice(null);
          toast.success("Signed in to Higgsfield: videos can use the subscription credits.");
          onChanged(true);
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
      const r = await post<Start>("/api/studio/higgsfield/mcp/signin/start");
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
    if (!(await askConfirm("Sign out of Higgsfield? Videos on the subscription credits stop until someone signs in again; the Cloud API key is untouched."))) return;
    try {
      await post("/api/studio/higgsfield/mcp/signout");
      toast.success("Signed out of Higgsfield.");
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  async function chooseBilling(billing: HiggsfieldBilling) {
    try {
      await post("/api/studio/higgsfield/mcp/billing", { billing });
      toast.success(billing === "credits" ? "Videos now use the subscription credits." : "Videos now use the Cloud API key, paid per clip.");
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const admin = status?.admin ?? true;
  const billing = status?.billing ?? "cloud";
  return (
    <div className="hf-signin">
      <div className="qa-heading">
        <Coins size={18} />
        <strong>Subscription credits (Higgsfield sign-in)</strong>
      </div>
      <p className="quality-note">
        Your Higgsfield subscription's credits pay for videos only through a sign-in to the Higgsfield account. The Cloud API key below is a separate account billed per clip and never spends those credits.
      </p>
      {status?.access && !status.access.enabled && <p className="image-error">{status.access.reason}</p>}
      {!status ? (
        <p className="quality-note">
          <Orb size={14} /> Reading the Higgsfield sign-in…
        </p>
      ) : status.signedIn ? (
        <div className="success-note hf-signed">
          <Check size={19} />
          <span>
            Signed in{status.email ? ` as ${status.email}` : ""}
            {status.plan ? ` · ${status.plan}` : ""}
            {status.credits !== null ? ` · Credits: ${status.credits.toLocaleString("en-GB")}` : status.balanceError ? ` · credits not read: ${status.balanceError}` : ""}
          </span>
        </div>
      ) : (
        <p className="quality-note">
          <b>Not signed in.</b> Press the button: Higgsfield's own sign-in opens in a new tab, and this page updates when it is done. Nothing is typed here.
        </p>
      )}
      {admin && (
        <div className="footer-actions">
          {status?.signedIn ? (
            <>
              <button type="button" className="secondary" onClick={() => onChanged(true)}>
                <RefreshCw size={15} /> Refresh credits
              </button>
              <button type="button" className="secondary danger" onClick={() => void signOut()}>
                <LogOut size={15} /> Sign out
              </button>
            </>
          ) : (
            <button type="button" className="primary" onClick={() => void signIn()} disabled={busy || !!waiting || !!device || status?.switch.enabled === false}>
              {busy || waiting ? <Orb size={15} /> : <LogIn size={15} />} Sign in to Higgsfield
            </button>
          )}
          {waiting && (
            <small className="field-hint">
              A Higgsfield tab opened. Sign in there; this page updates by itself.{" "}
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
            <Orb size={12} /> Waiting for Higgsfield… the code expires at {new Date(device.expires).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}.
          </small>
        </div>
      )}
      {error && (
        <p className="image-error">
          <TriangleAlert size={14} /> {error}
        </p>
      )}

      <label className="field-label" style={{ marginTop: 12 }}>
        Which account pays for videos
      </label>
      <div className="hf-billing" role="radiogroup" aria-label="Which account pays for videos">
        <label className={`hf-choice ${billing === "credits" ? "on" : ""}`}>
          <input type="radio" name="hf-billing" checked={billing === "credits"} disabled={!admin} onChange={() => void chooseBilling("credits")} />
          <span>
            <b>Subscription credits · sign-in</b>
            <small>Clips are costed in credits before each run and drawn from the signed-in account. Needs the sign-in above.</small>
          </span>
        </label>
        <label className={`hf-choice ${billing === "cloud" ? "on" : ""}`}>
          <input type="radio" name="hf-billing" checked={billing === "cloud"} disabled={!admin} onChange={() => void chooseBilling("cloud")} />
          <span>
            <b>Cloud API · pay per clip</b>
            <small>Clips go through the Cloud API key below and are invoiced per clip; the subscription credits are not touched.</small>
          </span>
        </label>
      </div>
      {status && billing === "credits" && !status.signedIn && <p className="field-hint warn">Sign in first: with this choice every clip is refused until someone is signed in.</p>}
      {status && billing === "cloud" && !status.cloudConfigured && <p className="field-hint warn">No Cloud API key is saved: with this choice every clip is refused until one is.</p>}
      {status && !status.billingChosen && <small className="field-hint">No choice made yet: the studio uses the credits once signed in, else the Cloud key.</small>}
      {!admin && <small className="field-hint">Admins only for now: the sign-in and the billing choice are limited to admins.</small>}
    </div>
  );
}
