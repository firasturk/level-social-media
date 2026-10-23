import { Combine, Eraser, Group, Scissors } from "lucide-react";
import type { ImageLayer, Layer } from "@shared/layers";
import { Orb } from "@/components/Orb";

/** An image layer that draws an SVG (a Freepik vector, an uploaded SVG, a piece of one): it can be taken apart. */
export function isSvgLayer(l: Layer | null | undefined): boolean {
  return !!l && l.type === "image" && (l.format === "SVG" || !!l.colors?.length || !!l.piece);
}

/** Why a picture layer cannot be split, said plainly by its format. */
export function splitRefusal(format: string | undefined | null): string {
  const f = (format ?? "").toUpperCase();
  if (f === "EPS/AI" || f === "EPS" || f === "AI")
    return "This file is EPS/AI: its shapes cannot be taken apart here. A browser cannot read EPS or AI and no converter runs, so the preview picture is placed. When Freepik offers the vector as SVG, use that one.";
  if (f === "PSD")
    return "This file is PSD: its layers cannot be taken apart here. The flattened preview picture is placed.";
  if (f === "PDF")
    return "This file is a PDF: its shapes cannot be taken apart here. The preview picture is placed.";
  if (f === "PNG" || f === "JPG" || f === "JPEG" || f === "WEBP" || f === "GIF")
    return `This layer is a ${f} picture, not a vector: it has no shapes to take apart.`;
  return "This layer is a picture, not an SVG vector: it has no shapes to take apart.";
}

export const SPLIT_HINT =
  "Split into layers: each group and shape of the SVG becomes its own layer, in exactly the same place, grouped. Clicking the vector on the picture moves it whole; pick one piece in the Layers list (or double-click it on the picture) to move, resize, turn, fade, recolour or delete it alone.";
export const LETTERING_SHAPES_HINT =
  "Lettering inside a vector is drawn as shapes: it stays a picture, not editable text.";

export type VectorBusy = "split" | "bg" | "merge" | null;

/**
 * The vector actions of the selected layer, with their labels: Split into layers, Remove
 * background, Merge back. Shown in the Layers panel (compact) and in Properties (with the hints).
 */
export default function VectorActions({
  layer,
  groupSize,
  busy,
  compact,
  onSplit,
  onRemoveBackground,
  onMerge,
  onSelectGroup,
}: {
  layer: ImageLayer;
  /** How many layers share this layer's group (1 when it has none). */
  groupSize: number;
  busy: VectorBusy;
  compact?: boolean;
  onSplit: () => void;
  onRemoveBackground: () => void;
  onMerge: () => void;
  onSelectGroup?: () => void;
}) {
  if (!isSvgLayer(layer)) {
    if (compact || !layer.format) return null;
    return <p className="ts-hint ts-vector-note">{splitRefusal(layer.format)}</p>;
  }
  const inGroup = !!layer.piece && groupSize > 1;
  return (
    <div className={`ts-vector-actions ${compact ? "compact" : ""}`} aria-label="Vector layers">
      <div className="ts-row ts-vector-buttons">
        <button
          type="button"
          className="ts-mini"
          onClick={onSplit}
          disabled={!!busy}
          title={SPLIT_HINT}
        >
          {busy === "split" ? <Orb size={12} /> : <Scissors size={12} />} Split into layers
        </button>
        <button
          type="button"
          className="ts-mini"
          onClick={onRemoveBackground}
          disabled={!!busy}
          title="Find the vector's own background (a filled shape covering most of it), show it, and remove it once you confirm. The other elements stay. Undo brings it back."
        >
          {busy === "bg" ? <Orb size={12} /> : <Eraser size={12} />} Remove background
        </button>
        {inGroup && (
          <button
            type="button"
            className="ts-mini"
            onClick={onMerge}
            disabled={!!busy}
            title="The pieces of this vector as one layer again, with every change you made to them (moves, colours, deletions)."
          >
            {busy === "merge" ? <Orb size={12} /> : <Combine size={12} />} Merge back
          </button>
        )}
        {inGroup && onSelectGroup && !compact && (
          <button
            type="button"
            className="ts-mini"
            onClick={onSelectGroup}
            disabled={!!busy}
            title="Select every piece of this vector, to move or resize it whole"
          >
            <Group size={12} /> Select whole vector
          </button>
        )}
      </div>
      {!compact && (
        <>
          <p className="ts-hint">
            {inGroup
              ? `A piece of a split vector (${groupSize} pieces, grouped). ${SPLIT_HINT.replace(/^Split into layers: each group and shape of the SVG becomes its own layer, in exactly the same place, grouped\. /, "")}`
              : SPLIT_HINT}
          </p>
          <p className="ts-hint">{LETTERING_SHAPES_HINT}</p>
        </>
      )}
    </div>
  );
}
