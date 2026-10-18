import { useEffect, useState } from "react";
import { Activity, BookOpen, CircleAlert, CircleCheck, Info, LoaderCircle, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import { get, post } from "@/api";
import { AUDIT_AREAS, auditCounts, type AuditFinding, type AuditReport, type AuditSeverity } from "@shared/audit";
import { SKILLBOOK } from "@shared/skillbook";

const ICON: Record<AuditSeverity, typeof CircleCheck> = { error: CircleAlert, warn: TriangleAlert, ok: CircleCheck, info: Info };

/**
 * The system check: what is wrong in production and what to do about it, run now (quick or with
 * the live tools) or daily by the cron; and the skillbook, what the studio knows how to do.
 */
export default function SystemCheck() {
  const [report, setReport] = useState<AuditReport | null>(null);
  const [running, setRunning] = useState<"" | "quick" | "deep">("");
  const [showOk, setShowOk] = useState(false);
  const [skills, setSkills] = useState(false);
  useEffect(() => {
    get<{ report: AuditReport | null }>("/api/admin/audit")
      .then((r) => setReport(r.report))
      .catch(() => {});
  }, []);
  async function run(deep: boolean) {
    setRunning(deep ? "deep" : "quick");
    try {
      const r = await post<{ report: AuditReport }>("/api/admin/audit", { deep });
      setReport(r.report);
      const c = auditCounts(r.report);
      toast.success(c.error ? `${c.error} to fix, ${c.warn} to look at.` : c.warn ? `Nothing broken; ${c.warn} to look at.` : "All clear.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setRunning("");
    }
  }
  const counts = report ? auditCounts(report) : null;
  const shown = (report?.findings ?? []).filter((f) => showOk || f.severity !== "ok");
  const byArea = AUDIT_AREAS.map((a) => ({ ...a, findings: shown.filter((f) => f.area === a.id) })).filter((a) => a.findings.length);
  return (
    <section className="batches-page system-check">
      <div className="panel-heading" style={{ padding: "8px 16px 0" }}>
        <Activity size={18} />
        <h2>System check</h2>
        <span className="quality-note" style={{ marginLeft: "auto" }}>
          {report ? `Last run ${new Date(report.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · ${(report.ms / 1000).toFixed(1)} s${report.deep ? " · with the live tools" : ""}` : "Not run yet"}
        </span>
      </div>
      <div className="system-check-bar">
        <button type="button" className="primary" disabled={!!running} onClick={() => void run(false)}>
          {running === "quick" ? <LoaderCircle className="spinning" size={15} /> : <Activity size={15} />} Check now
        </button>
        <button type="button" className="secondary" disabled={!!running} onClick={() => void run(true)} title="Also calls the text model, Instagram and Drive, and reviews the latest month's writing (a minute or two)">
          {running === "deep" ? <LoaderCircle className="spinning" size={15} /> : null} Full check with the live tools
        </button>
        {counts && (
          <span className="system-check-counts">
            <b className="error">{counts.error} to fix</b>
            <b className="warn">{counts.warn} to look at</b>
            <b className="info">{counts.info} notes</b>
            <label>
              <input type="checkbox" checked={showOk} onChange={(e) => setShowOk(e.target.checked)} /> show what passed ({counts.ok})
            </label>
          </span>
        )}
        <span className="field-hint">Runs by itself once a day; failures reach the notify address below.</span>
      </div>
      {running && !report && (
        <div className="journey-reading">
          <LoaderCircle className="spinning" size={16} /> Checking…
        </div>
      )}
      {report && !shown.length && <p className="field-hint system-check-clear">All clear: nothing to fix or look at.</p>}
      {byArea.map((a) => (
        <div key={a.id} className="system-check-area">
          <h3>{a.label}</h3>
          <ul>
            {a.findings.map((f, i) => (
              <Finding key={i} f={f} />
            ))}
          </ul>
        </div>
      ))}
      <div className="system-check-area">
        <button type="button" className="text-button" onClick={() => setSkills((v) => !v)}>
          <BookOpen size={14} /> {skills ? "Hide" : "Show"} the skillbook: what the studio knows how to do ({SKILLBOOK.length})
        </button>
        {skills && (
          <ul className="skillbook">
            {SKILLBOOK.map((s) => (
              <li key={s.id}>
                <strong>{s.title}</strong>
                <span>{s.what}</span>
                <small>Where: {s.where}</small>
                <code>{s.files.join(" · ")}</code>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

function Finding({ f }: { f: AuditFinding }) {
  const Icon = ICON[f.severity];
  return (
    <li className={`system-finding ${f.severity}`}>
      <Icon size={15} />
      <span>
        <strong>
          {f.title}
          {f.about && <em> · {f.about}</em>}
        </strong>
        {f.detail && <span className="system-finding-detail">{f.detail}</span>}
        {f.fix && <small>Fix: {f.fix}</small>}
      </span>
    </li>
  );
}
