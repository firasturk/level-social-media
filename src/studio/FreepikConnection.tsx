import { useEffect, useState } from "react";
import { Check, KeyRound, Library, Plug, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Orb } from "@/components/Orb";
import { askConfirm } from "@/lib/confirm";
import { del, get, post } from "@/api";
import type { PhotoLabOp } from "@shared/pricing";
import type { FreepikStatus } from "./FreepikPanel";
import "./freepik.css";

/**
 * Connection → Freepik: the key the Photo lab (remove or replace a background, relight, upscale)
 * runs on. It is verified with one authenticated call that spends no credits (a stock search) and
 * stored encrypted on the server. Without it the Photo lab runs as a labelled demo.
 */

export interface PhotoLabStatus {
  connected: boolean;
  provider: "freepik" | "demo";
  reason: string;
  prices: Record<PhotoLabOp, number>;
  approximate: boolean;
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

  return (
    <>
      <div className="qa-heading" style={{ marginTop: 12 }}>
        <KeyRound size={18} />
        <strong>Freepik (Photo lab: Magnific tools)</strong>
      </div>
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
 * bearer token (OAuth with the Magnific account; see docs/freepik.md for how to obtain one).
 */
function FreepikAssetsSettings({ connected }: { connected: boolean }) {
  const [status, setStatus] = useState<FreepikStatus | null>(null);
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
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
  async function saveToken() {
    setSaving(true);
    try {
      const r = await post<{ ok: boolean; tools: number }>("/api/studio/freepik/mcp/token", { token });
      setToken("");
      setTick((t) => t + 1);
      toast.success(`Magnific MCP connected: ${r.tools} tools listed.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function removeToken() {
    if (!(await askConfirm("Remove the saved Magnific MCP token? The MCP tools go back to Not connected."))) return;
    try {
      await del("/api/studio/freepik/mcp/token");
      setTick((t) => t + 1);
      toast.success("Magnific MCP token removed.");
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
      <div className="qa-heading" style={{ marginTop: 18 }}>
        <Plug size={18} />
        <strong>Magnific MCP (mcp.magnific.com)</strong>
      </div>
      {status.mcp.connected ? (
        <div className="success-note">
          <Check size={19} />A Magnific MCP token is saved. Its tools are listed under the Freepik panel's governance: browsing is free, a download follows the plan, anything generative is estimated and confirmed first.
        </div>
      ) : (
        <p className="quality-note">
          <b>Not connected.</b> The MCP server signs in with OAuth (the Magnific account), not an API key. Obtain a bearer access token for it (docs/freepik.md explains the device sign-in) and paste it here; it is checked with initialize and tools/list, which cost nothing, then stored encrypted. Access tokens expire: paste a fresh one when the tools say the token was refused.
        </p>
      )}
      <div className="footer-actions">
        <input id="freepik-mcp-token" type="password" autoComplete="off" placeholder="eyJ…" aria-label="Magnific MCP bearer token" value={token} onChange={(e) => setToken(e.target.value.trim())} />
        <button className="primary" onClick={() => void saveToken()} disabled={saving || token.length < 20}>
          {saving ? <Orb size={17} /> : <Plug size={17} />}
          {status.mcp.connected ? "Replace" : "Save"}
        </button>
        {status.mcp.connected && (
          <button className="secondary danger" onClick={() => void removeToken()} aria-label="Remove Magnific MCP token">
            <Trash2 size={17} />
          </button>
        )}
      </div>
    </>
  );
}
