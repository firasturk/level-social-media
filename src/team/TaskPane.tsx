/**
 * One task in the right pane: its words, who has it, the client, the month and post it belongs to
 * (with the creative), when it is due, how urgent, its status; then what happened to it, and a
 * comment box. The same pane, empty, makes a new task ("Make a task" from a message prefills it).
 */
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft, Send, X } from "lucide-react";
import { toast } from "sonner";
import type { Task, TaskEvent, TaskPriority, TaskStatus } from "@shared/team";
import { TASK_PRIORITIES, TASK_STATUSES } from "@shared/team";
import { Avatar } from "./Avatar";
import { dueState, fullTime, relativeTime } from "@shared/team-ui";
import { CreativeCard } from "./MessageBody";
import { StatusMenuButton } from "./TasksView";
import { ListSkeleton } from "./ui";
import { useTeam, type TaskDraft } from "./useTeam";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="tm-field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function PeopleSelect({ value, onChange }: { value: string | null | undefined; onChange: (id: string | null) => void }) {
  const team = useTeam();
  return (
    <select className="tm-input" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">Nobody yet</option>
      {team.users.map((u) => (
        <option key={u.id} value={u.id}>
          {u.name}
        </option>
      ))}
    </select>
  );
}

function ClientSelect({ value, onChange }: { value: string | null | undefined; onChange: (id: string | null) => void }) {
  const team = useTeam();
  const clients = team.channels.filter((c) => c.kind === "client" && c.client);
  return (
    <select className="tm-input" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">No client</option>
      {clients.map((c) => (
        <option key={c.id} value={c.client!}>
          {c.name}
        </option>
      ))}
    </select>
  );
}

export function TaskPane({ id, onClose, asPage = false }: { id: string; onClose: () => void; asPage?: boolean }) {
  const team = useTeam();
  const [task, setTask] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setTask(await team.getTask(id));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [id, team]);
  useEffect(() => {
    setTask(null);
    void load();
  }, [load]);

  const save = async (patch: TaskDraft) => {
    if (!task) return;
    const was = task;
    setTask({ ...task, ...(patch as Partial<Task>) } as Task);
    try {
      setTask(await team.updateTask(task.id, patch));
    } catch (e) {
      setTask(was);
      toast.error((e as Error).message);
    }
  };

  const sendComment = async () => {
    if (!task || !comment.trim()) return;
    setBusy(true);
    try {
      setTask(await team.commentTask(task.id, comment.trim()));
      setComment("");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside className={`tm-pane tm-task ${asPage ? "page" : ""}`} aria-label="Task">
      <header className="tm-pane-head">
        {asPage && (
          <button type="button" className="tm-icon tm-back" onClick={onClose} aria-label="Back">
            <ArrowLeft size={18} />
          </button>
        )}
        <div className="tm-pane-title">
          <h3>Task</h3>
          {task && <small>{task.kind === "month" ? "A month assigned" : `made by ${task.createdBy.name} · ${relativeTime(task.created)}`}</small>}
        </div>
        {task && <StatusMenuButton status={task.status} onChange={(s) => void save({ status: s })} />}
        {!asPage && (
          <button type="button" className="tm-icon" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <X size={17} />
          </button>
        )}
      </header>
      <div className="tm-pane-body">
        {!task && !error && <ListSkeleton rows={6} />}
        {error && <p className="tm-error">{error}</p>}
        {task && (
          <>
            <input className="tm-task-heading" defaultValue={task.title} key={`${task.id}-title`} dir="auto" aria-label="Title" onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== task.title && void save({ title: e.target.value.trim() })} />
            <textarea className="tm-task-desc" defaultValue={task.description} key={`${task.id}-desc`} dir="auto" rows={3} placeholder="Describe the work (optional)" aria-label="Description" onBlur={(e) => e.target.value !== task.description && void save({ description: e.target.value })} />
            {task.preview && task.batch && task.post !== null && <CreativeCard preview={task.preview} onOpen={() => team.openCreative(task.batch!, task.post!)} />}
            <div className="tm-fields">
              <Field label="Assignee">
                <PeopleSelect value={task.assignee?.id} onChange={(v) => void save({ assignee: v })} />
              </Field>
              <Field label="Client">
                <ClientSelect value={task.client} onChange={(v) => void save({ client: v })} />
              </Field>
              <Field label="Priority">
                <select className="tm-input" value={task.priority} onChange={(e) => void save({ priority: e.target.value as TaskPriority })}>
                  {TASK_PRIORITIES.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Due">
                <input type="date" className={`tm-input ${dueState(task.due) === "overdue" ? "overdue" : ""}`} value={task.due ?? ""} onChange={(e) => void save({ due: e.target.value || null })} />
              </Field>
              {(task.batchName || task.batch) && (
                <Field label="Month">
                  <span className="tm-input static" dir="auto">
                    {task.batchName ?? task.batch}
                    {task.post !== null ? ` · post ${task.post}` : ""}
                  </span>
                </Field>
              )}
            </div>
            <h4 className="tm-subhead">Activity</h4>
            <ul className="tm-events">
              {(task.events ?? []).map((e) => (
                <EventRow key={e.id} e={e} />
              ))}
              {!task.events?.length && <li className="tm-muted">Nothing yet.</li>}
            </ul>
            <div className="tm-comment">
              <textarea value={comment} onChange={(e) => setComment(e.target.value)} dir="auto" rows={2} placeholder="Add a comment" aria-label="Comment" onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && void sendComment()} />
              <button type="button" className="tm-send" onClick={() => void sendComment()} disabled={!comment.trim() || busy} aria-label="Send the comment">
                <Send size={14} />
              </button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}

function EventRow({ e }: { e: TaskEvent }) {
  const words = (() => {
    if ("comment" in e.change) return null;
    const { field, from, to } = e.change;
    const label = (v: string | null | undefined) => {
      if (field === "status") return TASK_STATUSES.find((s) => s.id === v)?.label ?? v ?? "none";
      if (field === "priority") return TASK_PRIORITIES.find((s) => s.id === v)?.label ?? v ?? "none";
      return v || "none";
    };
    if (field === "created") return "made the task";
    return (
      <>
        changed <b>{field}</b> {from !== undefined && from !== null && from !== "" ? <>from <b>{label(from)}</b> </> : null}to <b>{label(to)}</b>
      </>
    );
  })();
  return (
    <li className={"comment" in e.change ? "comment" : ""}>
      <Avatar user={e.by} size={22} />
      <div>
        <div className="tm-event-line">
          <b>{e.by.name}</b> {words} <time title={fullTime(e.at)}>{relativeTime(e.at)}</time>
        </div>
        {"comment" in e.change && <p dir="auto">{e.change.comment}</p>}
      </div>
    </li>
  );
}

export function NewTaskPane({ prefill, onClose, asPage = false }: { prefill: TaskDraft; onClose: () => void; asPage?: boolean }) {
  const team = useTeam();
  const [d, setD] = useState<TaskDraft>({ priority: "normal", status: "todo", assignee: team.me?.id ?? null, ...prefill });
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof TaskDraft>(k: K, v: TaskDraft[K]) => setD((x) => ({ ...x, [k]: v }));
  const create = async () => {
    if (!d.title?.trim()) return;
    setBusy(true);
    try {
      const t = await team.createTask({ ...d, title: d.title.trim() });
      toast.success("Task made.");
      team.openTask(t.id);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <aside className={`tm-pane tm-task ${asPage ? "page" : ""}`} aria-label="New task">
      <header className="tm-pane-head">
        {asPage && (
          <button type="button" className="tm-icon tm-back" onClick={onClose} aria-label="Back">
            <ArrowLeft size={18} />
          </button>
        )}
        <div className="tm-pane-title">
          <h3>New task</h3>
          {prefill.sourceMessage && <small>from a message</small>}
        </div>
        {!asPage && (
          <button type="button" className="tm-icon" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <X size={17} />
          </button>
        )}
      </header>
      <div className="tm-pane-body">
        <input className="tm-task-heading" autoFocus value={d.title ?? ""} onChange={(e) => set("title", e.target.value)} placeholder="What needs doing?" dir="auto" aria-label="Title" onKeyDown={(e) => e.key === "Enter" && void create()} />
        <textarea className="tm-task-desc" value={d.description ?? ""} onChange={(e) => set("description", e.target.value)} dir="auto" rows={4} placeholder="Describe the work (optional)" aria-label="Description" />
        <div className="tm-fields">
          <Field label="Assignee">
            <PeopleSelect value={d.assignee} onChange={(v) => set("assignee", v)} />
          </Field>
          <Field label="Client">
            <ClientSelect value={d.client} onChange={(v) => set("client", v)} />
          </Field>
          <Field label="Priority">
            <select className="tm-input" value={d.priority ?? "normal"} onChange={(e) => set("priority", e.target.value as TaskPriority)}>
              {TASK_PRIORITIES.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Due">
            <input type="date" className="tm-input" value={d.due ?? ""} onChange={(e) => set("due", e.target.value || null)} />
          </Field>
          <Field label="Status">
            <select className="tm-input" value={d.status ?? "todo"} onChange={(e) => set("status", e.target.value as TaskStatus)}>
              {TASK_STATUSES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </Field>
          {d.batch && (
            <Field label="Month">
              <span className="tm-input static">
                {d.batch}
                {d.post != null ? ` · post ${d.post}` : ""}
              </span>
            </Field>
          )}
        </div>
        <div className="tm-pane-actions">
          <button type="button" className="cta secondary small" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="cta primary small" disabled={!d.title?.trim() || busy} onClick={() => void create()}>
            Make the task
          </button>
        </div>
      </div>
    </aside>
  );
}
