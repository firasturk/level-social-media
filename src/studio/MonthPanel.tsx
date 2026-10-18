import type { ReactNode } from "react";
import { Grid3x3, History, ImagePlus, Package, StickyNote, X } from "lucide-react";
import { Section } from "./BrandPanel";
import { displayName } from "./PlanView";
import { styleThumb } from "./StyleGallery";
import type { Source } from "@shared/types";

/**
 * The month's own things, kept out of the posts' way: its product photos, the notes for the ideas
 * writer and the reference grid it follows, and its earlier versions. Lives in the left panel with
 * the brand kit.
 */
export default function MonthPanel({
  products,
  sourceUrl,
  onUpload,
  onRemoveProduct,
  busy,
  notes,
  onNotes,
  gridRef,
  onClearGrid,
  versions,
}: {
  products: Source[];
  sourceUrl: (id: string) => string;
  onUpload: () => void;
  onRemoveProduct: (id: string) => void;
  busy: boolean;
  notes: string;
  onNotes: (v: string) => void;
  gridRef: string | null;
  onClearGrid: () => void;
  versions: ReactNode;
}) {
  return (
    <>
      <Section
        title="Products"
        subtitle={products.length ? `${products.length} photo${products.length > 1 ? "s" : ""} this month` : "No product photos yet"}
        defaultOpen={products.length === 0}
        actions={
          <button type="button" className="secondary month-panel-upload" onClick={onUpload} disabled={busy}>
            <ImagePlus size={14} /> Upload products
          </button>
        }
      >
        {products.length ? (
          <div className="month-products">
            {products.map((s) => (
              <figure key={s.id} title={s.name}>
                <img src={sourceUrl(s.id)} alt={s.name} loading="lazy" />
                <figcaption>{displayName(s.name)}</figcaption>
                <button type="button" className="mood-remove" aria-label={`Remove ${s.name}`} onClick={() => onRemoveProduct(s.id)}>
                  <X size={12} />
                </button>
              </figure>
            ))}
          </div>
        ) : (
          <p className="field-hint">
            <Package size={13} /> Drop the client's product photos anywhere on the page, or upload them.
          </p>
        )}
      </Section>
      <Section title="Notes and grid" subtitle={gridRef ? "Follows a reference grid" : notes ? "Notes for the ideas" : "Nothing yet"} defaultOpen={false}>
        <label className="field-label">
          <StickyNote size={13} /> Notes for this month's ideas
        </label>
        <textarea rows={3} value={notes} placeholder="Occasions, launches, offers, what to push…" onChange={(e) => onNotes(e.target.value)} />
        {gridRef && (
          <div className="grid-chip month-grid-chip">
            <Grid3x3 size={14} />
            <span>Every post is staged in this grid's world.</span>
            <img src={gridRef.startsWith("style:") ? styleThumb({ id: gridRef.slice(6), updated: 0 }) : `/api/studio/references/${gridRef}/file`} alt="" />
            <button type="button" className="text-button" onClick={onClearGrid}>
              Stop following
            </button>
          </div>
        )}
      </Section>
      <Section title="Earlier versions" subtitle="Open one, or bring it back" defaultOpen={false}>
        <p className="field-hint">
          <History size={13} /> Every Generate keeps the month as it was.
        </p>
        {versions}
      </Section>
    </>
  );
}
