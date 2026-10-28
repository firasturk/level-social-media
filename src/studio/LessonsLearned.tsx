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
// A finding is in use the day it is found (28 Oct): the team only rejects the wrong ones.
const FILTERS = [
  { id: "approved", label: "In use" },
  { id: "rejected", label: "Rejected" },
  { id: "all", label: "All" },
] as const;
const inUse = (l: Pick<LearnedLesson, "status">) => l.status === "approved" || l.status === "pending";

function dayOf(t: number): string {
  return new Date(t).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

/**
 * Lessons learned: what the review found in the client's pictures, day by day. A new lesson waits
 * here until the admin approves it; only approved lessons shape the next prompts. A rejected
 * lesson is dropped and never learned again.
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

  const shown = (rows ?? []).filter((l) => filter === "all" || (filter === "approved" ? inUse(l) : l.status === filter));
  const days = new Map<string, LearnedLesson[]>();
  for (const l of shown) {
    const d = dayOf(l.last);
    days.set(d, [...(days.get(d) ?? []), l]);
  }
  const today = Date.now() - 86_400_000;
  const fresh = (rows ?? []).filter((l) => inUse(l) && l.first >= Date.now() - 86_400_000).length;

  return (
    <div className="lessons-learned">
      <div className="style-meta">
        {!rows ? (
          <span>
            <Orb size={13} /> Reading the lessons…
          </span>
        ) : (
          <span>
            {fresh ? `${fresh} new lesson${fresh === 1 ? "" : "s"} today` : "Nothing new today"} · every finding shapes the next pictures at once; reject the wrong ones
          </span>
        )}
      </div>
      <div className="lessons-filters" role="tablist">
        {FILTERS.map((f) => (
          <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={`journey-chip small ${filter === f.id ? "active" : ""}`} onClick={() => setFilter(f.id)}>
            {f.label}
            {f.id === "approved" && fresh > 0 && <em>{fresh}</em>}
          </button>
        ))}
      </div>
      {rows && !shown.length && <p className="style-empty">{filter === "rejected" ? "Nothing rejected yet." : "Nothing in use yet: every finding of the review lands here the same day."}</p>}
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
                  <span className={`lesson-status ${inUse(l) ? "approved" : l.status}`}>{l.status === "rejected" ? "rejected" : l.first >= today ? "new today · in use" : "in use"}</span>
                </div>
                <p className="lesson-text" dir="auto">
                  {l.text}
                </p>
                <p className="lesson-rule">
                  <span>Rule it becomes:</span> {l.rule}
                </p>
                <div className="lesson-actions">
                  {l.status === "rejected" && (
                    <button type="button" className="btn-pill primary" disabled={busy === l.id} onClick={() => void judge(l.id, "approved")} title="Bring it back into use">
                      <Check size={13} /> Use it again
                    </button>
                  )}
                  {l.status !== "rejected" && (
                    <button type="button" className="btn-pill" disabled={busy === l.id} onClick={() => void judge(l.id, "rejected")} title="Wrong lesson: the prompts never carry it and it is not learned again">
                      <X size={13} /> Reject
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
