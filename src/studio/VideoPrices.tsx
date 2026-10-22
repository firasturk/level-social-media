/**
 * Connection → Higgsfield: the fallback price per video clip for each engine. Higgsfield gives no
 * list price; the studio asks it for an estimate when a clip is made and, when it gives none,
 * uses the price written here. Empty means "not known yet": the clip is blocked until an admin
 * confirms it.
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { get, post } from "@/api";
import { VIDEO_MODELS } from "@shared/video-models";

export default function VideoPrices() {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  useEffect(() => {
    get<{ prices: Record<string, number | null> }>("/api/studio/engine/video-prices")
      .then((r) => setDraft(Object.fromEntries(Object.entries(r.prices).map(([k, v]) => [k, v === null ? "" : String(v)]))))
      .catch(() => undefined);
  }, []);
  async function save(slug: string) {
    const raw = (draft[slug] ?? "").trim();
    const usd = raw === "" ? null : Number(raw);
    if (usd !== null && !(usd >= 0)) {
      toast.error("Write the price in US dollars, or leave it empty.");
      return;
    }
    setSaving(slug);
    try {
      await post("/api/studio/engine/video-price", { model: slug, usd });
      toast.success(usd ? "Price saved." : "Price cleared: the clip is blocked until confirmed.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(null);
    }
  }
  return (
    <div className="video-prices">
      <label className="field-label">Video clip prices (fallback, USD per clip)</label>
      <p className="quality-note">
        Higgsfield publishes no list price for clips: the studio asks it for an estimate when a clip is made. When it gives none, the price here is used; empty means "cost not known yet" and the clip waits for an admin to confirm it.
      </p>
      <ul className="video-prices-list">
        {VIDEO_MODELS.map((m) => (
          <li key={m.slug}>
            <span title={m.slug}>{m.name}</span>
            <input
              type="number"
              min={0}
              step={0.01}
              inputMode="decimal"
              placeholder="not known"
              value={draft[m.slug] ?? ""}
              onChange={(e) => setDraft((d) => ({ ...d, [m.slug]: e.target.value }))}
              aria-label={`${m.name} price per clip`}
            />
            <button type="button" className="text-button" disabled={saving === m.slug} onClick={() => void save(m.slug)}>
              Save
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
