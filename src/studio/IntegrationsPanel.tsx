import { useCallback, useEffect, useState } from "react";
import { Plug, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Orb } from "@/components/Orb";
import { get, post } from "@/api";

/**
 * Admin → Integrations: one switch per outside provider (Freepik's Photo lab, Higgsfield video,
 * the video editor placeholder) that turns it off for everyone at once, the estimate an admin
 * enters for a kind of run that has no published price, and the ledger of recent operations: who,
 * when, provider, kind, post, the provider's task id, the estimate and reported cost, the status.
 * The rules live in docs/integrations.md.
 */

type Provider = "freepik" | "higgsfield" | "editor" | "audio";

interface ProviderState {
  provider: Provider;
  label: string;
  scope: string;
  enabled: boolean;
  estimates: Record<string, number | null>;
}

interface OpRow {
  id: string;
  provider: Provider;
  kind: string;
  user_id: string;
  user_name: string | null;
  user_email: string | null;
  batch: string | null;
  post: number | null;
  task_id: string | null;
  estimate: number | null;
  reported: number | null;
  status: "proposed" | "confirmed" | "running" | "done" | "failed" | "refused";
  note: string;
  created: number;
}

interface Answer {
  providers: ProviderState[];
  ops: OpRow[];
  estimateKinds: Record<Provider, { kind: string; label: string }[]>;
}

const usd = (n: number | null) => (n == null ? "not known" : `$${n.toFixed(2)}`);
const when = (t: number) => new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export default function IntegrationsPanel() {
  const [data, setData] = useState<Answer | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      setData(await get<Answer>("/api/admin/integrations?limit=60"));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function flip(p: ProviderState) {
    setBusy(p.provider);
    try {
      const r = await post<{ providers: ProviderState[] }>("/api/admin/integrations/switch", { provider: p.provider, enabled: !p.enabled });
      setData((d) => (d ? { ...d, providers: r.providers } : d));
      toast.success(`${p.label} switched ${p.enabled ? "off: every run is refused until it is on again" : "on"}.`);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function saveEstimate(p: ProviderState, kind: string) {
    const key = `${p.provider}.${kind}`;
    const raw = (drafts[key] ?? "").trim();
    const value = raw === "" ? null : Number(raw);
    if (value != null && (!Number.isFinite(value) || value < 0)) {
      toast.error("Enter the cost in dollars, or leave it empty to clear it.");
      return;
    }
    setBusy(key);
    try {
      const r = await post<{ providers: ProviderState[] }>("/api/admin/integrations/estimate", { provider: p.provider, kind, usd: value });
      setData((d) => (d ? { ...d, providers: r.providers } : d));
      setDrafts((x) => ({ ...x, [key]: "" }));
      toast.success(value == null ? "Estimate cleared: these runs are blocked until one is set." : `Estimate saved: about ${usd(value)} each.`);
      await load();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="batches-page admin-settings integrations">
      <div className="panel-heading" style={{ padding: "8px 16px 0" }}>
        <Plug size={18} />
        <h2>Integrations</h2>
        <span className="quality-note" style={{ marginLeft: "auto" }}>
          Admins only for now. Every paid run is confirmed first and written below; nothing is retried or sent elsewhere.
        </span>
      </div>
      {!data ? (
        <p className="quality-note" style={{ padding: "8px 16px" }}>
          <Orb size={14} /> Reading the integrations…
        </p>
      ) : (
        <>
          <div className="admin-grid">
            {data.providers.map((p) => (
              <div key={p.provider} className="integration-card">
                <label className="check-row">
                  <input type="checkbox" checked={p.enabled} disabled={busy === p.provider} onChange={() => void flip(p)} aria-label={`${p.label} on`} />
                  <span>
                    <span className="field-label">
                      {p.label} {p.enabled ? "" : "(off)"}
                    </span>
                    <small>{p.scope}</small>
                  </span>
                </label>
                {(data.estimateKinds[p.provider] ?? []).map((k) => {
                  const key = `${p.provider}.${k.kind}`;
                  const current = p.estimates[k.kind];
                  return (
                    <label key={k.kind} className="integration-estimate">
                      <span className="field-label">
                        {k.label}: estimated cost ($) {current == null ? "" : `· now ${usd(current)}`}
                      </span>
                      <span className="footer-actions">
                        <input
                          type="number"
                          min={0}
                          step={0.01}
                          placeholder={current == null ? "Not set: runs are blocked" : String(current)}
                          value={drafts[key] ?? ""}
                          onChange={(e) => setDrafts((x) => ({ ...x, [key]: e.target.value }))}
                        />
                        <button className="secondary" disabled={busy === key} onClick={() => void saveEstimate(p, k.kind)}>
                          {busy === key ? <Orb size={14} /> : null} Save
                        </button>
                      </span>
                      <small>{current == null ? "Without an estimate the run is refused: cost not known, blocked until clarified." : "An approximate figure for the confirmation; the provider bills its own credits."}</small>
                    </label>
                  );
                })}
              </div>
            ))}
          </div>

          <div className="panel-heading" style={{ padding: "8px 16px 0" }}>
            <h3>Recent operations</h3>
            <button className="text-button" style={{ marginLeft: "auto" }} onClick={() => void load()}>
              <RefreshCw size={13} /> Refresh
            </button>
          </div>
          {data.ops.length === 0 ? (
            <p className="quality-note" style={{ padding: "8px 16px 16px" }}>
              Nothing yet. The first Photo lab run, video or key change appears here.
            </p>
          ) : (
            <div className="batches-table integrations-table" role="table">
              <div className="batches-head" role="row">
                <span>Who</span>
                <span>When</span>
                <span>Provider</span>
                <span>Kind</span>
                <span>Post</span>
                <span>Task id</span>
                <span>Estimate / reported</span>
                <span>Status</span>
              </div>
              {data.ops.map((o) => (
                <div className="batches-row" role="row" key={o.id} title={o.note}>
                  <span className="batches-name">
                    <strong>{o.user_name || o.user_id}</strong>
                    {o.user_email && <small>{o.user_email}</small>}
                  </span>
                  <span>{when(o.created)}</span>
                  <span>{data.providers.find((p) => p.provider === o.provider)?.label ?? o.provider}</span>
                  <span>{o.kind}</span>
                  <span>{o.post != null ? `Post ${o.post}` : "—"}</span>
                  <span className="integrations-task">{o.task_id ?? "—"}</span>
                  <span>
                    {usd(o.estimate)}
                    {o.reported != null ? ` / ${usd(o.reported)}` : ""}
                  </span>
                  <span>
                    <span className={`pill ${o.status === "done" ? "ready" : o.status === "failed" || o.status === "refused" ? "failed" : "queued"}`}>{o.status}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}
