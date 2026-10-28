/**
 * "Restore a removed post" (28 Oct): the posts and slides taken out of this month, newest first,
 * each with its picture. Restoring brings a slide back to its carousel (as its last slide) and a
 * post back to the end of the month, picture included; nothing is made or paid.
 */
import { useEffect, useState } from "react";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { get, post } from "@/api";
import { Orb } from "@/components/Orb";
import "./client-changes.css";
import "./style-products.css";

interface Removed {
  id: string;
  title: string;
  key: string | null;
  image: string | null;
  created: number;
  exact: boolean;
  slide: boolean;
}

export default function RemovedDialog({ batchId, onClose, onRestored }: { batchId: string; onClose: () => void; onRestored: () => Promise<void> | void }) {
  const [list, setList] = useState<Removed[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void get<{ removed: Removed[] }>(`/api/studio/posts/removed?batch=${encodeURIComponent(batchId)}`)
      .then((d) => alive && setList(d.removed))
      .catch((e) => toast.error((e as Error).message));
    return () => {
      alive = false;
    };
  }, [batchId]);
  async function restore(r: Removed) {
    setBusy(r.id);
    try {
      const x = await post<{ index: number; slide: number | null; of: number | null; title: string }>("/api/studio/posts/restore", { batch: batchId, version: r.id });
      setList((l) => (l ?? []).filter((y) => y.id !== r.id));
      await onRestored();
      toast.success(x.slide ? `Back as slide ${x.slide} of ${x.of} (post ${x.index}).` : `Back as post ${x.index}.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }
  const when = (ms: number) => new Date(ms).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="ccd spd">
        <DialogHeader>
          <DialogTitle>
            <RotateCcw size={16} /> Removed posts
          </DialogTitle>
          <DialogDescription>A slide goes back to its carousel as the last slide; a post goes back to the end of the month. The picture comes back with it; nothing is made or paid.</DialogDescription>
        </DialogHeader>
        <div className="ccd-list">
          {!list ? (
            <p className="ccd-what">
              <Orb size={13} /> Looking for removed posts…
            </p>
          ) : list.length ? (
            list.map((r) => (
              <div key={r.id} className="ccd-post spd-row">
                {r.image ? <img src={r.image} alt="" className="spd-thumb" loading="lazy" /> : <span className="spd-thumb spd-thumb-empty" aria-hidden="true" />}
                <div className="spd-text">
                  <strong dir="auto">{r.title}</strong>
                  <small>
                    {r.slide ? "Slide" : "Post"} · removed {when(r.created)}
                    {r.exact ? "" : " · words not kept, picture and title only"}
                  </small>
                </div>
                <button type="button" className="btn primary" onClick={() => void restore(r)} disabled={busy !== null}>
                  {busy === r.id ? <Orb size={13} /> : <RotateCcw size={13} />} Restore
                </button>
              </div>
            ))
          ) : (
            <p className="ccd-what">Nothing was removed from this month.</p>
          )}
        </div>
        <div className="ccd-actions">
          <button type="button" className="btn ghost" onClick={onClose} disabled={busy !== null}>
            Close
          </button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
