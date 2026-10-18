import { useEffect, useState } from "react";
import { Grid3x3, LoaderCircle, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { get, post } from "@/api";
import { loadImage, renderOverlay } from "@/lib/overlay";
import type { OverlaySpec } from "@shared/overlay";
import type { Post } from "@shared/posts";
import type { TestGridInfo } from "@shared/testgrid";

const imageUrl = (batchId: string, at: number) => `/api/studio/posts/test-grid/image?batch=${encodeURIComponent(batchId)}&v=${at}`;

/**
 * The grid painted without words, with each post's words drawn on its cell in the month's fonts
 * (the client's overlay, as on the finished posts).
 */
async function compose(src: string, info: TestGridInfo, plan: Post[], spec: OverlaySpec, logoSrc: string | null): Promise<string> {
  const img = await loadImage(src);
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const cw = W / info.cols;
  const ch = H / info.rows;
  for (let i = 0; i < info.order.length; i++) {
    const p = plan.find((x) => x.index === info.order[i]);
    if (!p || spec.template === "none" || p.overlay === false || !(p.headline || p.subline)) continue;
    const x = (i % info.cols) * cw;
    const y = Math.floor(i / info.cols) * ch;
    const cell = document.createElement("canvas");
    cell.width = Math.round(cw);
    cell.height = Math.round(ch);
    cell.getContext("2d")!.drawImage(img, x, y, cw, ch, 0, 0, cell.width, cell.height);
    const drawn = await renderOverlay(cell.toDataURL("image/jpeg", 0.92), spec, { headline: p.headline, subline: p.subline }, logoSrc, cell.width, { patch: { ...p.ov, typo: undefined } });
    ctx.drawImage(drawn, x, y, cw, ch);
  }
  return canvas.toDataURL("image/jpeg", 0.9);
}

/**
 * Test grid: the month's whole feed in one picture before any post is paid for: the colours, the
 * rhythm of the tiles and the look, next to the grid the month follows.
 */
export default function TestGrid({
  batchId,
  plan,
  overlay,
  logoSrc,
  reference,
  blocked,
  onShowIssues,
}: {
  batchId: string | null;
  plan: Post[];
  overlay: OverlaySpec;
  logoSrc: string | null;
  /** The grid the month follows, small. */
  reference: string | null;
  blocked: boolean;
  onShowIssues: () => void;
}) {
  const [info, setInfo] = useState<TestGridInfo | null | undefined>(undefined);
  const [picture, setPicture] = useState<string | null>(null);
  const [making, setMaking] = useState(false);

  useEffect(() => {
    if (!batchId) return;
    get<{ grid: TestGridInfo | null }>(`/api/studio/posts/test-grid?batch=${encodeURIComponent(batchId)}`)
      .then((r) => setInfo(r.grid))
      .catch(() => setInfo(null));
  }, [batchId]);

  // The words follow the posts: the picture is drawn again when a headline changes.
  const words = plan.map((p) => `${p.index}:${p.headline ?? ""}:${p.subline ?? ""}:${JSON.stringify(p.ov ?? {})}`).join("|");
  useEffect(() => {
    if (!batchId || !info) return;
    let alive = true;
    compose(imageUrl(batchId, info.at), info, plan, overlay, logoSrc)
      .then((url) => alive && setPicture(url))
      .catch(() => alive && setPicture(imageUrl(batchId, info.at)));
    return () => {
      alive = false;
    };
  }, [batchId, info, words, overlay, logoSrc]); // eslint-disable-line react-hooks/exhaustive-deps

  async function make() {
    if (!batchId) return;
    if (blocked) return onShowIssues();
    setMaking(true);
    try {
      const r = await post<{ grid: TestGridInfo }>("/api/studio/posts/test-grid", { batch: batchId });
      setPicture(null);
      setInfo(r.grid);
      toast.success("The test grid is ready: compare it with your grid.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setMaking(false);
    }
  }

  const stale = !!info && plan.some((p) => !info.order.includes(p.index)) && plan.length <= 12;
  return (
    <div className="journey-box magic-box test-grid">
      <div className="journey-box-title">
        <Grid3x3 size={15} />
        <strong>Test grid</strong>
        {info && (
          <span className="journey-box-actions">
            <button type="button" className="text-button" onClick={() => void make()} disabled={making} title="Paint the month's feed again">
              {making ? <LoaderCircle className="spinning" size={13} /> : <RefreshCw size={13} />} Make it again
            </button>
          </span>
        )}
      </div>
      {making ? (
        <div className="test-grid-wait">
          <LoaderCircle className="spinning" size={22} />
          <strong>Painting the month's feed…</strong>
          <span>About a minute: every post in one picture, in feed order.</span>
        </div>
      ) : info ? (
        <div className="test-grid-body">
          <a href={picture ?? undefined} target="_blank" rel="noreferrer" className="test-grid-picture" title="Open full size">
            {picture ? <img src={picture} alt="The month's feed" /> : <LoaderCircle className="spinning" size={18} />}
          </a>
          <div className="test-grid-side">
            {reference && (
              <figure>
                <img src={reference} alt="" />
                <figcaption>Your grid</figcaption>
              </figure>
            )}
            <p className="field-hint">
              A sketch of the direction: the colours, the rhythm and the look. The products are exact in the real posts, each made from its own photo.
              {stale ? " The posts changed since: make it again." : ""}
            </p>
          </div>
        </div>
      ) : info === undefined ? (
        <div className="journey-reading">
          <LoaderCircle className="spinning" size={16} />
        </div>
      ) : (
        <div className="test-grid-empty">
          <p className="field-hint">
            One picture of the month's whole feed, in feed order, from your shots and colours, with each post's words drawn in the month's fonts. Check it
            against your grid before paying for every post.
          </p>
          <button type="button" className="primary" onClick={() => void make()} disabled={!plan.length}>
            <Grid3x3 size={16} /> Make the test grid
          </button>
        </div>
      )}
    </div>
  );
}
