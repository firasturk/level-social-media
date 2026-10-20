import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Check, RotateCcw, X } from "lucide-react";
import { Orb } from "@/components/Orb";
import { get, put } from "@/api";

export interface LearnedLesson {
  id: string;
  client: string;
  clientName?: string;
  kind: string;
  text: string;
  seen: number;
  first: number;
  last: number;
  status: "pending" | "approved" | "rejected";
  source: string;
  rule: string;
}

const SOURCE_LABEL: Record<string, string> = { review: "the review found it", client: "the client asked", retry: "fixed by itself" };
const FILTERS = [
  { id: "approved", label: "Learned" },
  { id: "rejected", label: "Rejected" },
  { id: "all", label: "All" },
] as const;

function dayOf(t: number): string {
  return new Date(t).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

/**
 * Lessons learned: what the studio learned from its own mistakes, day by day. Every lesson is used
 * by itself from the moment it is learned; the admin rejects the wrong ones here, and a rejected
 * lesson is dropped from the prompts and never learned again.
 */
export default function LessonsLearned({ onChange }: { onChange?: () => void }) {
  const [rows, setRows] = useState<LearnedLesson[] | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("approved");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    try {
      setRows(await get<LearnedLesson[]>("/api/studio/lessons/learned"));
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function judge(id: string, status: LearnedLesson["status"]) {
    setBusy(id);
    try {
      await put(`/api/studio/lessons/${id}`, { status });
      setRows((r) => (r ?? []).map((l) => (l.id === id ? { ...l, status } : l)));
      onChange?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  const shown = (rows ?? []).filter((l) => filter === "all" || l.status === filter);
  const days = new Map<string, LearnedLesson[]>();
  for (const l of shown) {
    const d = dayOf(l.last);
    days.set(d, [...(days.get(d) ?? []), l]);
  }
  const today = Date.now() - 86_400_000;
  const fresh = (rows ?? []).filter((l) => l.status === "approved" && l.first >= today).length;

  return (
    <div className="lessons-learned">
      <div className="style-meta">
        {!rows ? (
          <span>
            <Orb size={13} /> Reading the lessons…
          </span>
        ) : (
          <span>
            {fresh ? `${fresh} lesson${fresh === 1 ? "" : "s"} learned in the last day` : "Nothing new in the last day"} · every lesson shapes the next pictures by itself; reject the wrong ones here
          </span>
        )}
      </div>
      <div className="lessons-filters" role="tablist">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={`journey-chip small ${filter === f.id ? "active" : ""}`} onClick={() => setFilter(f.id)}>
            {f.label}
            {f.id === "approved" && fresh > 0 && <em>{fresh} new</em>}
          </button>
        ))}
      </div>
      {rows && !shown.length && <p className="style-empty">{filter === "rejected" ? "Nothing rejected yet." : "Nothing learned yet: every mistake the studio finds lands here the same day."}</p>}
      {[...days.entries()].map(([day, list]) => (
        <section key={day} className="lessons-day">
          <h3>{day}</h3>
          <ul className="design-cards lessons-list">
            {list.map((l) => (
              <li key={l.id} className={`design-card lesson-card ${l.status}`}>
                <div className="lesson-head">
                  <strong>{l.clientName ?? l.client}</strong>
                  <span className="lesson-kind">{l.kind}</span>
                  <span className="lesson-source">{SOURCE_LABEL[l.source] ?? l.source}</span>
                  {l.seen > 1 && <span className="lesson-seen">seen {l.seen}×</span>}
                  <span className={`lesson-status ${l.status}`}>{l.status === "approved" ? (l.first >= today ? "new today" : "in use") : l.status === "rejected" ? "rejected" : "set aside"}</span>
                </div>
                <p className="lesson-text" dir="auto">
                  {l.text}
                </p>
                <p className="lesson-rule">
                  <span>Rule it becomes:</span> {l.rule}
                </p>
                <div className="lesson-actions">
                  {l.status === "approved" ? (
                    <button type="button" className="btn-pill" disabled={busy === l.id} onClick={() => void judge(l.id, "rejected")} title="Wrong lesson: the prompts drop it and it is never learned again">
                      <X size={13} /> Reject
                    </button>
                  ) : (
                    <button type="button" className="btn-pill primary" disabled={busy === l.id} onClick={() => void judge(l.id, "approved")} title="Bring it back into use">
                      <Check size={13} /> Use it again
                    </button>
                  )}
                  {l.status === "rejected" && (
                    <span className="lesson-rule">
                      <RotateCcw size={12} /> dropped from the prompts
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
