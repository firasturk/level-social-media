/**
 * Notifications in the studio: the Connection tab (Resend key, sender, status, test, "Send the
 * unsent"), the "Email me when <client> answers" switch on the Client approval tab, and the
 * "Client answered · n new" badge on the board head. All of it reads /api/studio/notify.
 */
import { useCallback, useEffect, useState } from "react";
import { Bell, Check, KeyRound, Mail, Send, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { askConfirm } from "@/lib/confirm";
import { Orb } from "@/components/Orb";
import { del, get, post } from "@/api";

export interface NotifyStatus {
  connected: boolean;
  from: string;
  counts: { pending: number; sent: number; unsent: number; failed: number };
}

/** The status of the Notifications connection while the dialog is open; the second value re-reads it. */
export function useNotifyStatus(open: boolean): [NotifyStatus | null, () => void] {
  const [status, setStatus] = useState<NotifyStatus | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    get<NotifyStatus>("/api/studio/notify/status")
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [open, tick]);
  return [status, () => setTick((t) => t + 1)];
}

/** Connection → Notifications: the Resend key, the sender, what waits, a test mail. */
export default function NotifyConnection({
  status,
  onChanged,
}: {
  status: NotifyStatus | null;
  onChanged: () => void;
}) {
  const [key, setKey] = useState("");
  const [from, setFrom] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [sending, setSending] = useState(false);
  const fromValue = from ?? status?.from ?? "";

  async function save() {
    setSaving(true);
    try {
      const r = await post<NotifyStatus>("/api/studio/notify/settings", {
        key: key || undefined,
        from: fromValue,
      });
      setKey("");
      setFrom(null);
      onChanged();
      toast.success(
        r.connected ? "Notifications connected." : "Sender saved. Add a Resend key to send.",
      );
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function removeKey() {
    if (
      !(await askConfirm(
        "Remove the Resend key? New client answers are kept as unsent until a key is saved again.",
      ))
    )
      return;
    try {
      await del("/api/studio/notify/settings/key");
      onChanged();
      toast.success("Resend key removed.");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function test() {
    setTesting(true);
    try {
      const r = await post<{ to: string; from: string }>("/api/studio/notify/test", {});
      toast.success(`Test e-mail sent to ${r.to} from ${r.from}.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setTesting(false);
    }
  }

  async function sendUnsent() {
    setSending(true);
    try {
      const r = await post<{ sent: number; failed: number }>("/api/studio/notify/send-unsent", {});
      onChanged();
      toast[r.failed ? "error" : "success"](
        `${r.sent} e-mail${r.sent === 1 ? "" : "s"} sent${r.failed ? `, ${r.failed} refused by Resend` : ""}.`,
      );
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  const counts = status?.counts;
  return (
    <div className="notify-panel">
      <div className="qa-heading" style={{ marginTop: 12 }}>
        <Bell size={18} />
        <strong>Notifications (Resend)</strong>
      </div>
      {status?.connected ? (
        <div className="success-note">
          <Check size={19} />
          Connected. When a client answers on the approval page, the team gets one e-mail per month
          {status.from ? (
            <>
              {" "}
              from <b>{status.from}</b>.
            </>
          ) : (
            <>
              {" "}
              from Resend's test sender, which only reaches the Resend account's own address. Add a
              from address below.
            </>
          )}
        </div>
      ) : (
        <p className="quality-note notify-not-connected">
          <b>Not connected.</b> Client answers are recorded and shown on the board, but no e-mail
          goes out. Create a key at{" "}
          <a
            href="https://resend.com/api-keys"
            target="_blank"
            rel="noreferrer"
            className="text-link"
          >
            resend.com/api-keys
          </a>{" "}
          (the free tier covers the studio), verify your sending domain under Domains, then save the
          key and a from address on that domain.
        </p>
      )}
      {counts && (
        <ul className="notify-counts" aria-label="Notification counts">
          <li>
            <b>{counts.pending}</b> waiting
          </li>
          <li>
            <b>{counts.unsent}</b> unsent
          </li>
          <li>
            <b>{counts.sent}</b> sent
          </li>
          {counts.failed > 0 && (
            <li className="warn">
              <b>{counts.failed}</b> failed
            </li>
          )}
        </ul>
      )}
      <label htmlFor="notify-from" className="field-label">
        From address
      </label>
      <input
        id="notify-from"
        type="text"
        autoComplete="off"
        placeholder="Level Studio <studio@levelmena.com>"
        value={fromValue}
        onChange={(e) => setFrom(e.target.value)}
      />
      <p className="quality-note">
        The domain after the @ must be verified in Resend (Domains → Add domain → the DNS records it
        shows), or Resend refuses the mail.
      </p>
      <label htmlFor="notify-key" className="field-label">
        Resend API key
      </label>
      <div className="footer-actions">
        <input
          id="notify-key"
          type="password"
          autoComplete="off"
          placeholder={status?.connected ? "Saved · paste a new key to replace it" : "re_…"}
          aria-label="Resend API key"
          value={key}
          onChange={(e) => setKey(e.target.value.trim())}
        />
        <button
          className="primary"
          onClick={() => void save()}
          disabled={saving || (!key && fromValue === (status?.from ?? ""))}
        >
          {saving ? <Orb size={17} /> : <KeyRound size={17} />}
          Save
        </button>
        {status?.connected && (
          <button
            className="secondary danger"
            onClick={() => void removeKey()}
            aria-label="Remove Resend key"
          >
            <Trash2 size={17} />
          </button>
        )}
      </div>
      <div className="footer-actions notify-actions">
        <button
          className="secondary"
          onClick={() => void test()}
          disabled={!status?.connected || testing}
          title="Sends one test e-mail to your own address"
        >
          {testing ? <Orb size={17} /> : <Mail size={17} />}
          Send a test e-mail
        </button>
        <button
          className="secondary"
          onClick={() => void sendUnsent()}
          disabled={!status?.connected || sending || !counts?.unsent}
          title="Sends the answers that were recorded while no key was saved"
        >
          {sending ? <Orb size={17} /> : <Send size={17} />}
          Send the unsent ({counts?.unsent ?? 0})
        </button>
      </div>
    </div>
  );
}

/** "Email me when <client> answers": the member's own subscription for this client. */
export function NotifySubscribe({ client }: { client: { id: string; name: string } }) {
  const [on, setOn] = useState<boolean | null>(null);
  const [others, setOthers] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    get<{ on: boolean; subscribers: string[] }>(
      `/api/studio/notify/subscriptions?client=${encodeURIComponent(client.id)}`,
    )
      .then((r) => {
        if (!live) return;
        setOn(r.on);
        setOthers(r.subscribers);
      })
      .catch(() => live && setOn(false));
    return () => {
      live = false;
    };
  }, [client.id]);
  async function toggle(next: boolean) {
    setBusy(true);
    try {
      await post("/api/studio/notify/subscriptions", { client: client.id, on: next });
      setOn(next);
      const r = await get<{ subscribers: string[] }>(
        `/api/studio/notify/subscriptions?client=${encodeURIComponent(client.id)}`,
      ).catch(() => null);
      if (r) setOthers(r.subscribers);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <label
      className={`notify-toggle ${on ? "on" : ""}`}
      title={
        others.length
          ? `Subscribed: ${others.join(", ")}`
          : "Nobody subscribed: every admin is e-mailed"
      }
    >
      <input
        type="checkbox"
        checked={!!on}
        disabled={on === null || busy}
        onChange={(e) => void toggle(e.target.checked)}
      />
      <Bell size={13} />
      <span>Email me when {client.name} answers</span>
    </label>
  );
}

/** "Client answered · n new" on the board head: answers newer than this member's seen mark. */
export function NotifyBadge({
  batch,
  stamp,
  onOpen,
}: {
  batch: string;
  stamp: string | number;
  onOpen: () => void;
}) {
  const [count, setCount] = useState(0);
  const load = useCallback(() => {
    get<{ count: number }>(`/api/studio/notify/unseen?batch=${encodeURIComponent(batch)}`)
      .then((r) => setCount(r.count))
      .catch(() => setCount(0));
  }, [batch]);
  useEffect(() => {
    load();
  }, [load, stamp]);
  if (!count) return null;
  return (
    <button
      type="button"
      className="notify-badge"
      title="The client answered on the approval page. Opens Client approval and marks these as seen."
      onClick={() => {
        onOpen();
        setCount(0);
        void post("/api/studio/notify/seen", { batch }).catch(() => undefined);
      }}
    >
      <Bell size={12} /> Client answered · {count} new
    </button>
  );
}
