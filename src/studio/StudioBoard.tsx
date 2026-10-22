/**
 * The Studio board, as designed: one row of tabs (Posts, Feed, Words, Client approval, Versions)
 * with the month in numbers beside them, and one action bar (Export, Client link, Make N planned,
 * More). The posts themselves are the cards below; the Words and Client approval tabs are simple
 * lists over the same plan. Everything the old toolbar did is one click away under More.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Download, Ellipsis, Link2, MessageSquareReply } from "lucide-react";
import { formatUsd } from "@shared/pricing";
import type { Post } from "@shared/posts";
import type { Task } from "@shared/types";
import type { Approval } from "@shared/config";
import { NotifySubscribe } from "./Notify";
import { countsLine, type MonthCounts } from "@shared/counts";
import type { SaveStatus as SaveState } from "@shared/save-status";
import SaveStatus from "./SaveStatus";

export type StudioTab = "posts" | "words" | "approval" | "versions";

/** The month in numbers, from the shared count helper (the Plan and the Start screen use the same). */
export type StudioCounts = MonthCounts;
export { countsLine };

export default function StudioBoard({
  tab,
  onTab,
  counts,
  makeCount,
  makeCost,
  onMake,
  onExport,
  exporting,
  onClientLink,
  onFeed,
  changes,
  onClientChanges,
  clientChangesBusy,
  more,
  badge,
  loading,
  saveStatus,
  onRetrySave,
  children,
}: {
  tab: StudioTab;
  onTab: (t: StudioTab) => void;
  counts: StudioCounts;
  /** Posts the Plan would make now, and their estimate; the button opens the Plan, where it is confirmed. */
  makeCount: number;
  makeCost: number;
  onMake: () => void;
  onExport: () => void;
  exporting: boolean;
  onClientLink: () => void;
  /** The feed opens as its own screen; its tab is a door, not a view. */
  onFeed: () => void;
  changes: number;
  onClientChanges: () => void;
  clientChangesBusy: boolean;
  /** The More menu's items (the old toolbar's tools). */
  more: ReactNode;
  /** "Client answered · n new", beside the counts. */
  badge?: ReactNode;
  /** The month is still opening: the counts are not zeros, they are not known yet. */
  loading?: boolean;
  /** The plan's autosave, with a retry when it failed. */
  saveStatus?: SaveState;
  onRetrySave?: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", close);
    return () => window.removeEventListener("mousedown", close);
  }, [open]);
  const tabs: { key: StudioTab | "feed"; label: string }[] = [
    { key: "posts", label: "Posts" },
    { key: "feed", label: "Feed" },
    { key: "words", label: "Words" },
    { key: "approval", label: "Client approval" },
    { key: "versions", label: "Versions" },
  ];
  return (
    <section className="studio-board">
      <div className="studio-board-head">
        <div className="studio-tabs" role="tablist" aria-label="Views">
          {tabs.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={t.key === tab} className={t.key === tab ? "on" : ""} onClick={() => (t.key === "feed" ? onFeed() : onTab(t.key))}>
              {t.label}
            </button>
          ))}
        </div>
        <span className="studio-counts" aria-busy={loading || undefined}>
          {loading ? "Counting the month…" : countsLine(counts)}
          {saveStatus && <SaveStatus status={saveStatus} onRetry={onRetrySave} className="inline" />}
        </span>
        {badge}
        <div className="studio-actions">
          {changes > 0 && (
            <button type="button" className="cta secondary" onClick={onClientChanges} disabled={clientChangesBusy} title="Read what the client asked on the approval page, change those posts and make them again">
              <MessageSquareReply size={14} /> Do client comments ({changes})
            </button>
          )}
          <button type="button" className="cta secondary" onClick={onExport} disabled={!counts.made || exporting}>
            <Download size={14} /> Export
          </button>
          <button type="button" className="cta secondary" onClick={onClientLink} title="Copy a link the client opens to approve the posts">
            <Link2 size={14} /> Client link
          </button>
          {makeCount > 0 ? (
            <button type="button" className="cta primary" onClick={onMake} disabled={loading} title={`The ${makeCount} picture${makeCount === 1 ? "" : "s"} still to make this month (never made, failed, or made for an older idea). Opens the Plan, where the cost is shown and confirmed; pictures already made stay.`}>
              Make {makeCount} remaining · about {formatUsd(makeCost)}
            </button>
          ) : (
            <button type="button" className="cta primary" onClick={onMake} title="Opens the Plan">
              Open the plan
            </button>
          )}
          <div className="card-menu studio-more" ref={box}>
            <button type="button" className="studio-more-button" aria-label="More" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
              <Ellipsis size={16} />
            </button>
            {open && (
              <div className="card-menu-list" role="menu" onClick={() => setOpen(false)}>
                {more}
              </div>
            )}
          </div>
        </div>
      </div>
      {children}
    </section>
  );
}

/** The month's words: headline on the picture, caption, hashtags; each line saves when you leave it. */
export function WordsView({ plan, tasks, outputThumb, onSavePlan }: { plan: Post[]; tasks: Task[]; outputThumb: (t: Task) => string; onSavePlan: (next: Post[]) => Promise<void> }) {
  const taskOf = (i: number) => tasks.find((t) => t.post === i && t.output) ?? null;
  const save = (index: number, patch: Partial<Post>) => void onSavePlan(plan.map((y) => (y.index === index ? { ...y, ...patch } : y)));
  if (!plan.length) return <p className="flow-muted studio-empty">No posts in this month yet. Write the plan first; each post's words are edited here afterwards.</p>;
  return (
    <ul className="words-list">
      {[...plan]
        .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.index - b.index)
        .map((x) => {
          const t = taskOf(x.index);
          return (
            <li key={x.index}>
              <span className="words-thumb">{t ? <img src={outputThumb(t)} alt="" /> : <span className="flow-post-blank" />}</span>
              <div className="words-main">
                <b>
                  {String(x.index).padStart(2, "0")} · {x.title}
                  {x.group ? <small> · {x.group.kind === "carousel" ? "carousel" : "series"} slide {x.group.slide} of {x.group.of}</small> : null}
                </b>
                <label>
                  <span>On the picture</span>
                  <input defaultValue={x.headline ?? ""} placeholder="Headline on the picture (empty: none)" dir="auto" onBlur={(e) => (e.target.value || "") !== (x.headline ?? "") && save(x.index, { headline: e.target.value || undefined })} />
                </label>
                <label>
                  <span>Caption</span>
                  <textarea rows={2} defaultValue={x.caption} dir="auto" placeholder="Caption, at most 10 words" onBlur={(e) => e.target.value !== x.caption && save(x.index, { caption: e.target.value })} />
                </label>
                <label>
                  <span>Hashtags</span>
                  <input defaultValue={x.hashtags} dir="auto" placeholder="#…" onBlur={(e) => e.target.value !== x.hashtags && save(x.index, { hashtags: e.target.value })} />
                </label>
              </div>
            </li>
          );
        })}
    </ul>
  );
}

/** What the client said on the approval page, post by post. */
export function ApprovalView({
  plan,
  tasks,
  approvals,
  outputThumb,
  onClientLink,
  onWhatsApp,
  onOpen,
  client,
}: {
  plan: Post[];
  tasks: Task[];
  approvals: Record<string, Approval> | undefined;
  /** The month's client: shows "Email me when <client> answers". */
  client?: { id: string; name: string } | null;
  outputThumb: (t: Task) => string;
  onClientLink: () => void;
  onWhatsApp: () => void;
  onOpen: (index: number) => void;
}) {
  const taskOf = (i: number) => tasks.find((t) => t.post === i && t.output) ?? null;
  const list = Object.entries(approvals ?? {});
  const approved = list.filter(([, a]) => a.status === "approved").length;
  const changes = list.filter(([, a]) => a.status === "changes").length;
  const made = plan.filter((x) => taskOf(x.index)).length;
  return (
    <div className="approval-view">
      <div className="approval-head">
        <p>
          {list.length ? (
            <>
              <b>{approved} approved</b>
              {changes ? <> · <b className="warn">{changes} to change</b></> : null} · {Math.max(0, made - list.length)} not seen yet
            </>
          ) : made ? (
            "The client has not opened the link yet. Send it when the pictures are ready."
          ) : (
            "Nothing to approve yet: the pictures come first."
          )}
        </p>
        <div className="approval-actions">
          {client && <NotifySubscribe client={client} />}
          <button type="button" className="cta secondary" onClick={onClientLink}>
            <Link2 size={14} /> Copy the client link
          </button>
          {made > 0 && (
            <button type="button" className="cta secondary" onClick={onWhatsApp}>
              Send on WhatsApp
            </button>
          )}
        </div>
      </div>
      <ul className="approval-list">
        {[...plan]
          .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.index - b.index)
          .map((x) => {
            const t = taskOf(x.index);
            const a = approvals?.[String(x.index)];
            return (
              <li key={x.index}>
                <span className="words-thumb">{t ? <img src={outputThumb(t)} alt="" /> : <span className="flow-post-blank" />}</span>
                <div className="words-main">
                  <b>
                    {String(x.index).padStart(2, "0")} · {x.title}
                  </b>
                  <span className={`flow-pill ${a?.status === "approved" ? "ok" : a?.status === "changes" ? "warn" : ""}`}>
                    {a?.status === "approved" ? "Client approved" : a?.status === "changes" ? "Change asked" : t ? "Not seen yet" : "No picture yet"}
                    {a?.by ? ` · by ${a.by}` : ""}
                  </span>
                  {a?.answers?.length ? (
                    <ul className="approval-answers">
                      {[...a.answers]
                        .sort((p, q) => q.at - p.at)
                        .map((r) => (
                          <li key={r.rid} className={r.status}>
                            <b dir="auto">{r.by?.trim() || "Someone"}</b> {r.status === "approved" ? "approved" : "asked for a change"}
                            {r.note ? <q dir="auto">{r.note}</q> : null}
                            <small className="flow-muted">
                              {new Date(r.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                              {r.version ? ` · on ${r.version.label ?? (r.version.kind === "video" ? "a video" : "the picture")}` : ""}
                            </small>
                          </li>
                        ))}
                    </ul>
                  ) : (
                    <>
                      {a?.note && <q className="approval-note">{a.note}</q>}
                      {a?.at ? <small className="flow-muted">{new Date(a.at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</small> : null}
                    </>
                  )}
                </div>
                <button type="button" className="text-button" onClick={() => onOpen(x.index)}>
                  Open the post
                </button>
              </li>
            );
          })}
      </ul>
    </div>
  );
}
