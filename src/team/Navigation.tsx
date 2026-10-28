/**
 * The left column: My tasks, then Channels (general, the clients), Projects, Direct messages and
 * Groups, each row bold with a dot when unread and a badge when someone mentioned you.
 * "New message" picks people (one: a dm, several: a group); "New project" names a channel.
 */
import { useMemo, useState } from "react";
import { AtSign, Hash, ListTodo, Lock, MessagesSquare, Plus, SquarePen } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { Channel, TeamUser } from "@shared/team";
import { Avatar } from "./Avatar";
import { channelTitle, groupChannels } from "@shared/team-ui";
import { useTeam } from "./useTeam";

export function Navigation({ onPick, compact = false }: { onPick?: () => void; compact?: boolean }) {
  const team = useTeam();
  const me = team.me!;
  const groups = useMemo(() => groupChannels(team.channels), [team.channels]);
  const [newMessage, setNewMessage] = useState(false);
  const [newProject, setNewProject] = useState(false);
  const current = team.view.section === "chat" ? team.view.channel : null;

  const go = (id: string) => {
    team.openChannel(id);
    onPick?.();
  };

  return (
    <nav className={`tm-nav ${compact ? "compact" : ""}`} aria-label="Team">
      <button type="button" className={`tm-nav-row tm-nav-tasks ${team.view.section === "tasks" ? "on" : ""}`} onClick={() => { team.setView({ section: "tasks" }); onPick?.(); }}>
        <span className="tm-nav-icon">
          <ListTodo size={15} />
        </span>
        <span className="tm-nav-name">My tasks</span>
        {team.tasksOpen > 0 && <span className="tm-count">{team.tasksOpen}</span>}
      </button>
      <button type="button" className="tm-nav-new" onClick={() => setNewMessage(true)}>
        <SquarePen size={14} /> New message
      </button>

      <Section title="Channels">
        {groups.general.map((c) => <NavRow key={c.id} c={c} me={me.id} on={c.id === current} onGo={go} />)}
        {groups.clients.map((c) => <NavRow key={c.id} c={c} me={me.id} on={c.id === current} onGo={go} />)}
        {!groups.general.length && !groups.clients.length && <p className="tm-nav-empty">No channels yet.</p>}
      </Section>
      <Section title="Projects" action={{ label: "New project channel", onClick: () => setNewProject(true) }}>
        {groups.projects.map((c) => <NavRow key={c.id} c={c} me={me.id} on={c.id === current} onGo={go} />)}
        {!groups.projects.length && <p className="tm-nav-empty">A project channel for a launch, a shoot, a campaign.</p>}
      </Section>
      <Section title="Direct messages" action={{ label: "New message", onClick: () => setNewMessage(true) }}>
        {groups.dms.map((c) => <NavRow key={c.id} c={c} me={me.id} on={c.id === current} onGo={go} />)}
        {!groups.dms.length && <p className="tm-nav-empty">Write to someone directly.</p>}
      </Section>
      {groups.groups.length > 0 && (
        <Section title="Groups">
          {groups.groups.map((c) => <NavRow key={c.id} c={c} me={me.id} on={c.id === current} onGo={go} />)}
        </Section>
      )}

      {newMessage && <NewMessageDialog onClose={() => setNewMessage(false)} onDone={(id) => { setNewMessage(false); go(id); }} />}
      {newProject && <NewProjectDialog onClose={() => setNewProject(false)} onDone={(id) => { setNewProject(false); go(id); }} />}
    </nav>
  );
}

function NavRow({ c, me, on, onGo }: { c: Channel; me: string; on: boolean; onGo: (id: string) => void }) {
  const title = channelTitle(c, me);
  const other = c.kind === "dm" ? c.members?.find((m) => m.id !== me) : null;
  return (
    <button type="button" className={`tm-nav-row ${on ? "on" : ""} ${c.unread ? "unread" : ""}`} onClick={() => onGo(c.id)} title={title}>
      <span className="tm-nav-icon">{other ? <Avatar user={other} size={20} /> : c.kind === "group" ? <Lock size={14} /> : c.kind === "project" ? <MessagesSquare size={14} /> : <Hash size={14} />}</span>
      <span className="tm-nav-name" dir="auto">
        {title}
      </span>
      {c.mentioned ? (
        <span className="tm-badge mention" title="You were mentioned">
          <AtSign size={10} />
          {c.unread > 0 ? c.unread : ""}
        </span>
      ) : c.unread > 0 ? (
        <span className="tm-badge">{c.unread > 99 ? "99+" : c.unread}</span>
      ) : null}
    </button>
  );
}

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: { label: string; onClick: () => void } }) {
  return (
    <div className="tm-nav-section">
      <div className="tm-nav-head">
        <span>{title}</span>
        {action && (
          <button type="button" className="tm-icon small" onClick={action.onClick} title={action.label} aria-label={action.label}>
            <Plus size={14} />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

function PeoplePicker({ users, picked, onToggle }: { users: TeamUser[]; picked: Set<string>; onToggle: (id: string) => void }) {
  const [q, setQ] = useState("");
  const shown = users.filter((u) => u.name.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <div className="tm-people">
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a person" dir="auto" aria-label="Find a person" />
      <ul>
        {shown.map((u) => (
          <li key={u.id}>
            <label className={picked.has(u.id) ? "on" : ""}>
              <input type="checkbox" checked={picked.has(u.id)} onChange={() => onToggle(u.id)} />
              <Avatar user={u} size={26} />
              <span>
                {u.name}
                <small>{u.email}</small>
              </span>
            </label>
          </li>
        ))}
        {!shown.length && <li className="tm-muted">Nobody by that name.</li>}
      </ul>
    </div>
  );
}

function NewMessageDialog({ onClose, onDone }: { onClose: () => void; onDone: (channel: string) => void }) {
  const team = useTeam();
  const me = team.me!;
  const [picked, setPicked] = useState(new Set<string>());
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const others = team.users.filter((u) => u.id !== me.id);
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const create = async () => {
    setBusy(true);
    try {
      const members = [...picked];
      const c = await team.createChannel(members.length === 1 ? { kind: "dm", members } : { kind: "group", name: name.trim() || undefined, members });
      onDone(c.id);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="tm-dialog">
        <DialogHeader>
          <DialogTitle>New message</DialogTitle>
          <DialogDescription>One person opens a direct message; several make a private group.</DialogDescription>
        </DialogHeader>
        <PeoplePicker users={others} picked={picked} onToggle={toggle} />
        {picked.size > 1 && <input className="tm-input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Group name (optional)" dir="auto" aria-label="Group name" />}
        <DialogFooter>
          <button type="button" className="cta secondary small" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="cta primary small" disabled={!picked.size || busy} onClick={() => void create()}>
            {picked.size > 1 ? "Start the group" : "Start the conversation"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function NewProjectDialog({ onClose, onDone }: { onClose: () => void; onDone: (channel: string) => void }) {
  const team = useTeam();
  const me = team.me!;
  const [name, setName] = useState("");
  const [client, setClient] = useState("");
  const [picked, setPicked] = useState(new Set<string>(team.users.filter((u) => u.id !== me.id).map((u) => u.id)));
  const [busy, setBusy] = useState(false);
  const clients = team.channels.filter((c) => c.kind === "client" && c.client);
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const create = async () => {
    setBusy(true);
    try {
      const c = await team.createChannel({ kind: "project", name: name.trim(), client: client || null, members: [...picked] });
      onDone(c.id);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="tm-dialog">
        <DialogHeader>
          <DialogTitle>New project channel</DialogTitle>
          <DialogDescription>A place for one piece of work: a launch, a shoot, a campaign. Everyone you pick sees it.</DialogDescription>
        </DialogHeader>
        <input className="tm-input" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Project name" dir="auto" aria-label="Project name" />
        {clients.length > 0 && (
          <select className="tm-input" value={client} onChange={(e) => setClient(e.target.value)} aria-label="Client">
            <option value="">No client</option>
            {clients.map((c) => (
              <option key={c.id} value={c.client!}>
                {c.name}
              </option>
            ))}
          </select>
        )}
        <PeoplePicker users={team.users.filter((u) => u.id !== me.id)} picked={picked} onToggle={toggle} />
        <DialogFooter>
          <button type="button" className="cta secondary small" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="cta primary small" disabled={!name.trim() || busy} onClick={() => void create()}>
            Create the channel
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
