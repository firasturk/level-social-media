/**
 * "Assign" (28 Oct): an admin gives a month to team members (the copywriter), who then open it
 * with full access to fix the words and the pictures, as if it were their own. The whole list is
 * saved at once; unticking takes a member off.
 */
import { useEffect, useState } from "react";
import { Check, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { get, post } from "@/api";
import { Orb } from "@/components/Orb";
import "./client-changes.css";
import "./style-products.css";

interface Members {
  owner: string;
  members: { id: string; name: string; email: string }[];
  team: { id: string; name: string; email: string; role: string }[];
}

export default function AssignDialog({ batchId, onClose }: { batchId: string; onClose: () => void }) {
  const [data, setData] = useState<Members | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let alive = true;
    void get<Members>(`/api/studio/members?batch=${encodeURIComponent(batchId)}`)
      .then((d) => {
        if (!alive) return;
        setData(d);
        setChosen(new Set(d.members.map((m) => m.id)));
      })
      .catch((e) => toast.error((e as Error).message));
    return () => {
      alive = false;
    };
  }, [batchId]);
  async function save() {
    setSaving(true);
    try {
      const r = await post<{ users: string[] }>("/api/studio/members", { batch: batchId, users: [...chosen] });
      toast.success(r.users.length ? `Assigned to ${r.users.length} team member${r.users.length === 1 ? "" : "s"}.` : "Nobody assigned: the month is its owner's and the admins'.");
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="ccd spd">
        <DialogHeader>
          <DialogTitle>
            <UserPlus size={16} /> Assign this month
          </DialogTitle>
          <DialogDescription>The people ticked open this month with full access: the words, the pictures, the client link. Admins and the month's owner always can.</DialogDescription>
        </DialogHeader>
        <div className="ccd-list">
          {!data ? (
            <p className="ccd-what">
              <Orb size={13} /> Reading the team…
            </p>
          ) : data.team.length ? (
            <div className="ccd-post">
              {data.team.map((u) => (
                <button key={u.id} type="button" className={`chip spd-chip ${chosen.has(u.id) ? "on" : ""}`} onClick={() => setChosen((c) => { const n = new Set(c); if (n.has(u.id)) n.delete(u.id); else n.add(u.id); return n; })} title={u.email}>
                  {chosen.has(u.id) && <Check size={12} />} {u.name || u.email}
                  <small> · {u.role}</small>
                </button>
              ))}
            </div>
          ) : (
            <p className="ccd-what">No other team members yet: add them under Admin → Users.</p>
          )}
        </div>
        <div className="ccd-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={saving}>
            Not now
          </button>
          <button type="button" className="btn primary" onClick={() => void save()} disabled={!data || saving}>
            {saving ? <Orb size={13} /> : <Check size={13} />} Save
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
