import { useEffect, useState } from "react";
import { History } from "lucide-react";
import { get } from "@/api";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import type { OverlaySpec, PostOverlayPatch } from "@shared/overlay";
import OverlayPreview from "./OverlayPreview";

interface Version {
  id: string;
  label: string;
  grid: string | null;
  created: number;
  posts: { index: number; headline: string; subline: string; ov?: PostOverlayPatch; image: string | null }[];
}

/**
 * The month's earlier versions: the grids made before new ideas replaced them, each opened as the
 * feed it was (newest post first), with its words when its plan was kept.
 */
export default function MonthVersions({ batchId, plannedAt, overlay, logoSrc }: { batchId: string; plannedAt?: number; overlay: OverlaySpec; logoSrc: string | null }) {
  const [versions, setVersions] = useState<Version[]>([]);
  const [open, setOpen] = useState<Version | null>(null);
  useEffect(() => {
    let live = true;
    get<{ versions: Version[] }>(`/api/studio/posts/versions?batch=${encodeURIComponent(batchId)}`)
      .then((r) => live && setVersions(r.versions.filter((v) => v.posts.some((p) => p.image))))
      .catch(() => live && setVersions([]));
    return () => {
      live = false;
    };
  }, [batchId, plannedAt]);
  if (!versions.length) return null;
  return (
    <section className="month-versions" aria-label="Earlier versions of this month">
      <span className="month-versions-title">
        <History size={14} /> Earlier versions
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
              {new Date(v.created).toLocaleDateString("en-GB", { day: "numeric", month: "short" })} · {v.posts.filter((p) => p.image).length} pictures
            </small>
          </button>
        ))}
      </div>
      <Dialog open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <DialogContent className="month-version-dialog">
          <DialogHeader>
            <DialogTitle>{open?.label}</DialogTitle>
            <DialogDescription>
              {open ? new Date(open.created).toLocaleString("en-GB", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" }) : ""} · the feed as it was, newest post first.
            </DialogDescription>
          </DialogHeader>
          <div className="month-version-feed">
            {open?.posts.map((p) =>
              p.image ? (
                p.headline ? (
                  <OverlayPreview key={p.index} src={p.image} spec={overlay} text={{ headline: p.headline, subline: p.subline }} logoSrc={logoSrc} patch={p.ov ? { ...p.ov, typo: undefined } : undefined} width={420} />
                ) : (
                  <img key={p.index} src={p.image} alt="" loading="lazy" />
                )
              ) : (
                <span key={p.index} className="feed-empty">
                  {String(p.index).padStart(2, "0")}
                </span>
              ),
            )}
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
