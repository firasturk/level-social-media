import { useEffect, useState } from "react";
import { Check, KeyRound, Library, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Orb } from "@/components/Orb";
import { askConfirm } from "@/lib/confirm";
import { del, get, post } from "@/api";
import type { PhotoLabOp } from "@shared/pricing";
import type { FreepikStatus } from "./FreepikPanel";
import MagnificSignIn from "./MagnificSignIn";
import "./freepik.css";

/**
 * Connection → Freepik: the key the Photo lab (remove or replace a background, relight, upscale)
 * runs on. It is verified with one authenticated call that spends no credits (a stock search) and
 * stored encrypted on the server. Without it the Photo lab runs as a labelled demo.
 */

/** Whether the viewer may run the provider: admins only for now, and only while its switch is on. */
export interface IntegrationAccess {
  admin: boolean;
  enabled: boolean;
  reason: string;
}

export interface PhotoLabStatus {
  connected: boolean;
  provider: "freepik" | "demo";
  reason: string;
  prices: Record<PhotoLabOp, number>;
  approximate: boolean;
  access?: IntegrationAccess;
}

export function useFreepikStatus(open: boolean): [PhotoLabStatus | null, () => void] {
  const [status, setStatus] = useState<PhotoLabStatus | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!open) return;
    get<PhotoLabStatus>("/api/studio/photolab/status")
      .then(setStatus)
      .catch(() => setStatus(null));
  }, [open, tick]);
  return [status, () => setTick((t) => t + 1)];
}

export default function FreepikTab({
  status,
  onChanged,
}: {
  status: PhotoLabStatus | null;
  onChanged: () => void;
}) {
  const [key, setKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [note, setNote] = useState<{ ok: boolean; message: string } | null>(null);

  async function save() {
    setSaving(true);
    try {
      const r = await post<{ ok: boolean; message: string }>("/api/studio/photolab/key", { key });
      setKey("");
      setNote(r);
      onChanged();
      toast.success("Freepik key saved and verified.");
    } catch (e) {
      setNote({ ok: false, message: (e as Error).message });
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!(await askConfirm("Remove the saved Freepik key? The Photo lab goes back to the demo until a new key is added."))) return;
    try {
      await del("/api/studio/photolab/key");
      setNote(null);
      onChanged();
      toast.success("Freepik key removed.");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  if (status && status.access && !status.access.admin)
    return (
      <>
        <div className="qa-heading" style={{ marginTop: 12 }}>
          <KeyRound size={18} />
          <strong>Freepik (Photo lab: Magnific tools)</strong>
        </div>
        <p className="quality-note">
          <b>Admins only for now.</b> The Freepik key and the Photo lab are limited to admins until the integration is approved for the whole team.
          {status.connected ? " A key is saved on the server." : " No key is saved yet."}
        </p>
      </>
    );

  return (
    <>
      <div className="qa-heading" style={{ marginTop: 12 }}>
        <KeyRound size={18} />
        <strong>Freepik (Photo lab: Magnific tools)</strong>
      </div>
      {status?.access && !status.access.enabled && <p className="image-error">{status.access.reason}</p>}
      {status?.connected ? (
        <div className="success-note">
          <Check size={19} />A Freepik key is saved on the server. The Photo lab (remove or replace a background,
          relight, upscale) runs on it; each run shows its approximate cost before it is paid.
        </div>
      ) : (
        <p className="quality-note">
          <b>Not connected.</b> The Photo lab runs as a demo (nothing is sent anywhere, the result is the input). To
          connect: sign in at{" "}
          <a href="https://www.freepik.com/api" target="_blank" rel="noreferrer" className="text-link">
            freepik.com/api
          </a>
          , open the API dashboard, create an API key, and paste it here. The key is checked with one call that costs
          no credits (a stock search), then stored encrypted.
        </p>
      )}
      {status && (
        <p className="field-hint">
          About {fmt(status.prices["remove-bg"])} to remove a background, {fmt(status.prices.background)} to replace
          one, {fmt(status.prices.relight)} to relight, {fmt(status.prices.upscale)} to upscale (2x). Approximate:
          Freepik bills credits per call.
        </p>
      )}
      <div className="footer-actions">
        <input
          id="freepik-key"
          type="password"
          autoComplete="off"
          placeholder="FPSX…"
          aria-label="Freepik API key"
          value={key}
          onChange={(e) => setKey(e.target.value.trim())}
        />
        <button className="primary" onClick={() => void save()} disabled={saving || key.length < 16}>
          {saving ? <Orb size={17} /> : <KeyRound size={17} />}
          {status?.connected ? "Replace" : "Save"}
        </button>
        {status?.connected && (
          <button className="secondary danger" onClick={() => void remove()} aria-label="Remove Freepik key">
            <Trash2 size={17} />
          </button>
        )}
      </div>
      {note && <p className={note.ok ? "success-note" : "image-error"}>{note.message}</p>}
      <FreepikAssetsSettings connected={!!status?.connected} />
    </>
  );
}

function fmt(n: number | undefined): string {
  return n == null ? "—" : `$${n.toFixed(2)}`;
}

/**
 * Stock assets and the Magnific MCP: the plan family (which decides whether a stock download is in
 * the plan or billed in credits; unset, downloads are blocked as "cost not known") and the MCP
 * sign-in block (MagnificSignIn.tsx: one button, the Magnific account's own sign-in in a new tab).
 */
function FreepikAssetsSettings({ connected }: { connected: boolean }) {
  const [status, setStatus] = useState<FreepikStatus | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    get<FreepikStatus>("/api/studio/freepik/status")
      .then((s) => live && setStatus(s))
      .catch(() => live && setStatus(null));
    return () => {
      live = false;
    };
  }, [tick, connected]);
  if (!status?.admin) return null;

  async function savePlan(plan: FreepikStatus["plan"]) {
    try {
      await post("/api/studio/freepik/plan", { plan });
      setTick((t) => t + 1);
      toast.success(plan === "unknown" ? "Plan cleared: stock downloads are blocked until it is set." : "Freepik plan saved.");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const plans: { id: FreepikStatus["plan"]; label: string; hint: string }[] = [
    { id: "premium", label: "Premium, Premium+ or Pro", hint: "Stock downloads through the API are in the plan, capped at 100 a day (the pricing page)." },
    { id: "business", label: "Business or Enterprise", hint: "No daily cap; every download is charged to the credit balance. The amount per download is not readable by the studio, so downloads stay blocked until it is known." },
    { id: "unknown", label: "Not set", hint: "Stock downloads are blocked as “cost not known”. Searching still works." },
  ];
  return (
    <>
      <div className="qa-heading" style={{ marginTop: 18 }}>
        <Library size={18} />
        <strong>Freepik stock assets</strong>
      </div>
      <p className="quality-note">
        Searching stock is free. What a download costs depends on the API plan: pick it so the studio can say “in your plan” or block a download whose cost it cannot know. An Unlimited website subscription covers the web app only; API calls run on credits.
      </p>
      <div className="fp-plan" role="radiogroup" aria-label="Freepik API plan">
        {plans.map((p) => (
          <label key={p.id}>
            <input type="radio" name="freepik-plan" checked={status.plan === p.id} onChange={() => void savePlan(p.id)} />
            <span>
              <b>{p.label}</b> — {p.hint}
            </span>
          </label>
        ))}
      </div>
      <MagnificSignIn onChanged={() => setTick((t) => t + 1)} />
    </>
  );
}
