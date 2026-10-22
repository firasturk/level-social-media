import { useEffect, useState } from "react";
import { ScanText } from "lucide-react";
import { get, post, postForm } from "@/api";
import type { Finding, FindingSeverity, OcrResult } from "@shared/ocr-check";
import "./ocr.css";

/**
 * The OCR check of one post, in the editor's Image group: is Google Vision connected, read the raw
 * picture (the engine's output, which must carry no writing but the product's packaging) or the
 * final artwork (the words drawn by the browser, which must read exactly as approved), then the
 * expected-against-detected table and the regions drawn over the picture. A faint reading is
 * never acted on: its row says "Needs a human look".
 */

interface Status {
  connected: boolean;
  provider: string;
  reason: string;
}

interface Check {
  id: string;
  kind: "raw" | "artwork";
  provider: string;
  connected: boolean;
  detected: OcrResult;
  findings: Finding[];
  created: number;
}

interface CheckAnswer {
  check: Check;
  findings: Finding[];
  connected: boolean;
  provider: string;
}

export interface OcrPanelProps {
  batchId: string;
  /** The post's index in the month. */
  post: number;
  /** The task (picture) the raw check reads; the latest picture of the post when omitted. */
  task?: string | null;
  /** The raw picture, for the regions of a raw check. */
  imageUrl: string;
  expected: { headline?: string; subline?: string; price?: string };
  /** The post as it will be published (words and logo drawn by the browser), for the artwork check. */
  composeArtwork?: () => Promise<Blob>;
}

const VERDICT: Record<Finding["kind"], string> = {
  match: "Reads as approved",
  mismatch: "Reads differently",
  missing: "Not found",
  extra: "Unexpected writing",
  "low-confidence": "Needs a human look",
};

const FIELD: Record<Finding["field"], string> = {
  headline: "Headline",
  subline: "Second line",
  price: "Price",
  number: "Number",
  text: "Other writing",
};

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

export default function OcrPanel({ batchId, post: postIndex, task, imageUrl, expected, composeArtwork }: OcrPanelProps) {
  const [status, setStatus] = useState<Status | null>(null);
  const [check, setCheck] = useState<Check | null>(null);
  const [artworkUrl, setArtworkUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState<"raw" | "artwork" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    get<Status>("/api/studio/ocr/status")
      .then((s) => alive && setStatus(s))
      .catch(() => alive && setStatus({ connected: false, provider: "demo", reason: "Not connected" }));
    get<{ checks: Check[] }>(`/api/studio/ocr/checks?batch=${encodeURIComponent(batchId)}&post=${postIndex}`)
      .then((d) => {
        if (!alive) return;
        // The latest check of the raw picture is shown again on reopen; an artwork check needs its upload.
        const latest = d.checks.find((c) => c.kind === "raw") ?? null;
        setCheck(latest);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [batchId, postIndex]);

  useEffect(() => {
    return () => {
      if (artworkUrl) URL.revokeObjectURL(artworkUrl);
    };
  }, [artworkUrl]);

  async function runRaw() {
    setBusy("raw");
    setError(null);
    try {
      const r = await post<CheckAnswer>("/api/studio/ocr/check", { batch: batchId, post: postIndex, task: task ?? undefined, kind: "raw" });
      setArtworkUrl(null);
      setCheck(r.check);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The check failed.");
    } finally {
      setBusy(null);
    }
  }

  async function runArtwork() {
    if (!composeArtwork) return;
    setBusy("artwork");
    setError(null);
    try {
      const blob = await composeArtwork();
      const form = new FormData();
      form.set("batch", batchId);
      form.set("post", String(postIndex));
      if (task) form.set("task", task);
      form.set("kind", "artwork");
      form.set("expected", JSON.stringify(expected));
      form.set("file", blob, "artwork.png");
      const r = await postForm<CheckAnswer>("/api/studio/ocr/check", form);
      setArtworkUrl(URL.createObjectURL(blob));
      setCheck(r.check);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The check failed.");
    } finally {
      setBusy(null);
    }
  }

  const connected = status?.connected ?? false;
  const shown = check?.kind === "artwork" && artworkUrl ? artworkUrl : imageUrl;
  const findings = check?.findings ?? [];
  const boxes = findings.filter((f) => f.box && f.box[2] > f.box[0] && f.box[3] > f.box[1]);

  return (
    <section className="ocr-panel" aria-label="Writing check">
      <div className="ocr-head">
        <strong>
          <ScanText size={15} /> Writing check
        </strong>
        <span className={`ocr-chip ${status ? (connected ? "pass" : "off") : ""}`} title={status?.reason ?? ""}>
          {!status ? "Checking the connection…" : connected ? "Google Vision connected" : "Not connected · demo"}
        </span>
      </div>
      <div className="ocr-actions">
        <button type="button" className="secondary" disabled={busy !== null} onClick={() => void runRaw()} title="Read the picture as the engine made it: nothing may be written on it but the product's packaging">
          {busy === "raw" ? "Reading…" : "Check the raw picture"}
        </button>
        <button type="button" className="secondary" disabled={busy !== null || !composeArtwork} onClick={() => void runArtwork()} title="Read the post as it will be published: the headline, second line and price must read exactly as approved">
          {busy === "artwork" ? "Reading…" : "Check the final artwork"}
        </button>
      </div>
      {error && (
        <p className="ocr-note warn" role="alert">
          {error}
        </p>
      )}
      {check && (
        <>
          {!check.connected && (
            <p className="ocr-note warn">Not connected · demo result. Connect a Google key or a Vertex service account to read the picture for real.</p>
          )}
          <figure className="ocr-figure">
            <img src={shown} alt={check.kind === "artwork" ? "The final artwork" : "The raw picture"} />
            <div className="ocr-boxes" aria-hidden="true">
              {boxes.map((f, i) => (
                <div
                  key={i}
                  className={`ocr-box ${f.severity}`}
                  style={{ left: `${f.box![0] * 100}%`, top: `${f.box![1] * 100}%`, width: `${(f.box![2] - f.box![0]) * 100}%`, height: `${(f.box![3] - f.box![1]) * 100}%` }}
                >
                  <small>{f.kind === "low-confidence" ? "Human look" : FIELD[f.field]}</small>
                </div>
              ))}
            </div>
          </figure>
          {findings.length ? (
            <table className="ocr-table">
              <thead>
                <tr>
                  <th>What</th>
                  <th>Expected</th>
                  <th>Detected</th>
                  <th>Sure</th>
                  <th>Verdict</th>
                </tr>
              </thead>
              <tbody>
                {findings.map((f, i) => (
                  <tr key={i}>
                    <td>{FIELD[f.field]}</td>
                    <td className="ocr-words">{f.expected ?? "—"}</td>
                    <td className="ocr-words">{f.detected ?? "—"}</td>
                    <td className="ocr-conf">{f.detected ? pct(f.confidence) : "—"}</td>
                    <td>
                      <span className={`ocr-verdict ${f.severity as FindingSeverity}`} title={f.note}>
                        {VERDICT[f.kind]}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="ocr-note ocr-empty">
              {check.kind === "raw"
                ? check.detected.blocks.length
                  ? "Only the product's packaging or the brand's name was read on the raw picture."
                  : "No writing was read on the raw picture."
                : "Nothing was read on the artwork."}
            </p>
          )}
        </>
      )}
      {!check && !error && <p className="ocr-note">Read the raw picture for unintended writing, or the final artwork for the approved words.</p>}
    </section>
  );
}
