import { useCallback, useEffect, useState } from "react";
import { History, LoaderCircle, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { get, post } from "@/api";
import { askConfirm } from "@/lib/confirm";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { OverlaySpec, PostOverlayPatch } from "@shared/overlay";
import OverlayPreview from "./OverlayPreview";

interface Version {
  id: string;
  label: string;
  grid: string | null;
  created: number;
  posts: { index: number; headline: string; subline: string; ov?: PostOverlayPatch; key: string | null; image: string | null }[];
  takes: { index: number; key: string; image: string }[];
  withPlan: boolean;
}

const when = (t: number) => new Date(t).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

/**
 * The month's earlier versions: the grids made before new ideas replaced them. Each opens as the
 * feed it was, with every picture it holds, and comes back to the studio whole or one picture at a
 * time (the month as it is now is kept as a version first).
 */
export default function MonthVersions({
  batchId,
  plannedAt,
  overlay,
  logoSrc,
  onRestored,
}: {
  batchId: string;
  plannedAt?: number;
  overlay: OverlaySpec;
  logoSrc: string | null;
  onRestored: () => Promise<void>;
}) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [open, setOpen] = useState<Version | null>(null);
  const [busy, setBusy] = useState("");
  const load = useCallback(
    () =>
      get<{ versions: Version[] }>(`/api/studio/posts/versions?batch=${encodeURIComponent(batchId)}`)
        .then((r) => setVersions(r.versions.filter((v) => v.posts.some((p) => p.image))))
        .catch(() => setVersions([])),
    [batchId],
  );
  useEffect(() => {
    void load();
  }, [load, plannedAt]);

  async function restore(v: Version, take?: { index: number; key: string }) {
    if (!take) {
      const ok = await askConfirm(
        v.withPlan
          ? `Bring this version back to the studio: its ideas, words and ${v.posts.filter((p) => p.image).length} pictures replace the month's. The month as it is now is kept in Earlier versions.`
          : `Bring these ${v.posts.filter((p) => p.image).length} pictures back to their posts in the studio (the posts keep today's words). The month as it is now is kept in Earlier versions.`,
        { ok: "Use this version", danger: false },
      );
      if (!ok) return;
    }
    setBusy(take ? take.key : v.id);
    try {
      const r = await post<{ restored: number }>("/api/studio/posts/versions/restore", { batch: batchId, version: v.id, ...(take ?? {}) });
      await onRestored();
      await load();
      toast.success(take ? `Post ${take.index} uses this picture now.` : `${r.restored} picture${r.restored === 1 ? "" : "s"} back in the studio.`);
      if (!take) setOpen(null);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  if (!versions.length) return null;
  const extra = open ? open.takes.filter((t) => !open.posts.some((p) => p.key === t.key)) : [];
  return (
    <section className="month-versions" aria-label="Earlier versions of this month">
      <span className="month-versions-title">
        <History size={14} /> Earlier versions · open one to see it, or bring it back to the studio
      </span>
      <div className="month-versions-list">
        {versions.map((v) => (
          <button key={v.id} type="button" className="month-version" onClick={() => setOpen(v)} title="Open this version">
            <span className="month-version-mosaic">
              {v.posts
                .filter((p) => p.image)
                .slice(0, 6)
                .map((p) => (
                  <img key={p.index} src={p.image!} alt="" loading="lazy" />
                ))}
            </span>
            <strong>{v.label}</strong>
            <small>
              {when(v.created)} · {Math.max(v.takes.length, v.posts.filter((p) => p.image).length)} pictures
            </small>
          </button>
        ))}
      </div>
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="month-version-dialog">
          <DialogHeader>
            <DialogTitle>{open?.label}</DialogTitle>
            <DialogDescription>
              {open ? when(open.created) : ""} · the feed as it was, newest post first{extra.length ? `, then every other picture made in it` : ""}.
            </DialogDescription>
          </DialogHeader>
          {open && (
            <>
              <div className="month-version-actions">
                <button type="button" className="primary" disabled={!!busy} onClick={() => void restore(open)}>
                  {busy === open.id ? <LoaderCircle className="spinning" size={15} /> : <RotateCcw size={15} />} Use this version in the studio
                </button>
              </div>
              <div className="month-version-scroll">
                <div className="month-version-feed">
                  {open.posts.map((p) =>
                    p.image ? (
                      <figure key={p.index} className="month-version-take">
                        {p.headline ? (
                          <OverlayPreview src={p.image} spec={overlay} text={{ headline: p.headline, subline: p.subline }} logoSrc={logoSrc} patch={p.ov ? { ...p.ov, typo: undefined } : undefined} width={420} />
                        ) : (
                          <img src={p.image} alt="" loading="lazy" />
                        )}
                        <figcaption>{String(p.index).padStart(2, "0")}</figcaption>
                      </figure>
                    ) : (
                      <span key={p.index} className="feed-empty">
                        {String(p.index).padStart(2, "0")}
                      </span>
                    ),
                  )}
                </div>
                {extra.length > 0 && (
                  <>
                    <p className="field-hint">Every other picture made in this version ({extra.length}): use any of them for its post.</p>
                    <div className="month-version-feed">
                      {extra.map((t) => (
                        <figure key={t.key} className="month-version-take">
                          <img src={t.image} alt="" loading="lazy" />
                          <figcaption>{String(t.index).padStart(2, "0")}</figcaption>
                          <button type="button" className="secondary" disabled={!!busy} onClick={() => void restore(open, { index: t.index, key: t.key })}>
                            {busy === t.key ? <LoaderCircle className="spinning" size={13} /> : null} Use for post {t.index}
                          </button>
                        </figure>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
    </section>
  );
}
