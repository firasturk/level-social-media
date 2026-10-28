/**
 * Tasks, Linear-like: one list grouped by status, each row a priority dot, the title, the client,
 * the due date (red when overdue) and who has it; filters by client, status, priority and due;
 * the status changes from a small menu without opening the task.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, ChevronDown, Plus } from "lucide-react";
import { toast } from "sonner";
import type { Task, TaskPriority, TaskStatus } from "@shared/team";
import { TASK_PRIORITIES, TASK_STATUSES } from "@shared/team";
import { Avatar } from "./Avatar";
import { dueLabel, dueState } from "@shared/team-ui";
import { Empty, ListSkeleton, Menu } from "./ui";
import { useTeam, type TaskFilters } from "./useTeam";

export function PriorityDot({ p, size = 8 }: { p: TaskPriority; size?: number }) {
  return <i className={`tm-prio ${p}`} style={{ width: size, height: size }} title={TASK_PRIORITIES.find((x) => x.id === p)?.label} aria-label={p} />;
}

export function StatusMenuButton({ status, onChange, compact = false }: { status: TaskStatus; onChange: (s: TaskStatus) => void; compact?: boolean }) {
  const [open, setOpen] = useState(false);
  const label = TASK_STATUSES.find((s) => s.id === status)?.label ?? status;
  return (
    <span className="tm-status-anchor" onClick={(e) => e.stopPropagation()}>
      <button type="button" className={`tm-status ${status} ${compact ? "compact" : ""}`} onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} title="Change the status">
        <i aria-hidden="true" />
        {!compact && label}
        <ChevronDown size={11} />
      </button>
      {open && (
        <Menu
          onClose={() => setOpen(false)}
          items={TASK_STATUSES.map((s) => ({ label: s.label, on: s.id === status, icon: s.id === status ? <Check size={13} /> : <i className={`tm-status-dot ${s.id}`} />, onClick: () => onChange(s.id) }))}
        />
      )}
    </span>
  );
}

function FilterSelect({ value, onChange, options, all }: { value: string; onChange: (v: string) => void; options: { id: string; label: string }[]; all: string }) {
  return (
    <select className="tm-filter" value={value} onChange={(e) => onChange(e.target.value)} aria-label={all}>
      <option value="">{all}</option>
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function TasksView({ onBack, compact = false }: { onBack?: () => void; compact?: boolean }) {
  const team = useTeam();
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [filters, setFilters] = useState<TaskFilters>({ mine: true, due: "all" });
  const [error, setError] = useState<string | null>(null);
  const clients = team.channels.filter((c) => c.kind === "client" && c.client);

  const load = useCallback(async () => {
    try {
      setError(null);
      setTasks(await team.listTasks(filters));
    } catch (e) {
      setError((e as Error).message);
    }
  }, [filters, team]);
  useEffect(() => {
    void load();
  }, [load, team.tasksStamp]);

  const groups = useMemo(() => {
    const by = new Map<TaskStatus, Task[]>(TASK_STATUSES.map((s) => [s.id, []]));
    const order: Record<TaskPriority, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
    for (const t of tasks ?? []) by.get(t.status)?.push(t);
    for (const list of by.values()) list.sort((a, b) => order[a.priority] - order[b.priority] || (a.due ?? "9999").localeCompare(b.due ?? "9999") || b.updated - a.updated);
    return by;
  }, [tasks]);

  const change = async (t: Task, status: TaskStatus) => {
    setTasks((ts) => ts?.map((x) => (x.id === t.id ? { ...x, status } : x)) ?? null);
    try {
      await team.updateTask(t.id, { status });
    } catch (e) {
      toast.error((e as Error).message);
      void load();
    }
  };

  const pick = (k: "client" | "status" | "priority") => (v: string) => setFilters((f) => ({ ...f, [k]: v || undefined }));

  const open = team.view.pane.kind === "task" ? team.view.pane.id : null;
  const total = tasks?.length ?? 0;

  return (
    <section className={`tm-tasks ${compact ? "compact" : ""}`} aria-label="Tasks">
      <header className="tm-channel-head">
        {onBack && (
          <button type="button" className="tm-icon tm-back" onClick={onBack} aria-label="Back">
            <ArrowLeft size={18} />
          </button>
        )}
        <div className="tm-channel-title">
          <h2>{filters.mine ? "My tasks" : "All tasks"}</h2>
          {tasks && <span className="tm-count">{total}</span>}
        </div>
        <div className="tm-channel-tools">
          <button type="button" className="cta primary small" onClick={() => team.setView({ pane: { kind: "newTask", prefill: {} } })}>
            <Plus size={14} /> New task
          </button>
        </div>
      </header>
      <div className="tm-filters">
        <div className="tm-seg" role="tablist" aria-label="Whose tasks">
          <button type="button" role="tab" aria-selected={!!filters.mine} className={filters.mine ? "on" : ""} onClick={() => setFilters((f) => ({ ...f, mine: true }))}>
            Mine
          </button>
          <button type="button" role="tab" aria-selected={!filters.mine} className={!filters.mine ? "on" : ""} onClick={() => setFilters((f) => ({ ...f, mine: false }))}>
            Everyone
          </button>
        </div>
        {clients.length > 0 && <FilterSelect value={filters.client ?? ""} onChange={pick("client")} options={clients.map((c) => ({ id: c.client!, label: c.name }))} all="Any client" />}
        <FilterSelect value={filters.status ?? ""} onChange={pick("status")} options={TASK_STATUSES} all="Any status" />
        <FilterSelect value={filters.priority ?? ""} onChange={pick("priority")} options={TASK_PRIORITIES} all="Any priority" />
        <select className="tm-filter" value={filters.due ?? "all"} onChange={(e) => setFilters((f) => ({ ...f, due: e.target.value as TaskFilters["due"] }))} aria-label="Due">
          <option value="all">Any time</option>
          <option value="overdue">Overdue</option>
          <option value="week">This week</option>
        </select>
      </div>
      <div className="tm-tasks-list">
        {tasks === null && !error && <ListSkeleton rows={6} />}
        {error && (
          <Empty
            title="Tasks could not load"
            hint={error}
            action={
              <button type="button" className="cta secondary small" onClick={() => void load()}>
                Try again
              </button>
            }
          />
        )}
        {tasks && !tasks.length && <Empty title="No tasks: enjoy the calm" hint={filters.mine ? "Tasks made for you, or from a message with “Make a task”, appear here." : "Nothing matches these filters."} />}
        {tasks && tasks.length > 0 &&
          TASK_STATUSES.map((s) => {
            const list = groups.get(s.id) ?? [];
            if (!list.length) return null;
            return (
              <div key={s.id} className={`tm-task-group ${s.id}`}>
                <div className="tm-task-group-head">
                  <i className={`tm-status-dot ${s.id}`} aria-hidden="true" />
                  <span>{s.label}</span>
                  <b>{list.length}</b>
                </div>
                {list.map((t) => {
                  const ds = dueState(t.due);
                  return (
                    <div key={t.id} role="button" tabIndex={0} className={`tm-task-row ${t.id === open ? "on" : ""} ${t.status === "done" ? "done" : ""}`} onClick={() => team.openTask(t.id)} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), team.openTask(t.id))}>
                      <PriorityDot p={t.priority} />
                      <span className="tm-task-title" dir="auto">
                        {t.title}
                        {t.kind === "month" && <small className="tm-pill soft">month</small>}
                      </span>
                      {(t.clientName || t.client) && <span className="chip tm-task-client" dir="auto">{t.clientName ?? t.client}</span>}
                      {t.due && (
                        <span className={`tm-due ${ds ?? ""}`} title={t.due}>
                          {dueLabel(t.due)}
                        </span>
                      )}
                      <StatusMenuButton status={t.status} compact onChange={(st) => void change(t, st)} />
                      {t.assignee ? <Avatar user={t.assignee} size={24} /> : <span className="tm-avatar empty" style={{ "--size": "24px" } as React.CSSProperties} title="Nobody yet" />}
                    </div>
                  );
                })}
              </div>
            );
          })}
      </div>
    </section>
  );
}
