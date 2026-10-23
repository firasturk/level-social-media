/**
 * Where a picture comes from, as a small badge: Freepik stock, the client's Drive, a Pinterest
 * pin, an upload, a product photo or a brand asset. Shown wherever pictures from more than one
 * source sit together (the Assets panel, the layers list, a layer's properties, a post's reference),
 * so a Freepik asset is never mistaken for the client's own photo.
 */
import "./source-badge.css";

export type PictureSource = "freepik" | "drive" | "pinterest" | "upload" | "product" | "brand";

export const SOURCE_LABELS: Record<PictureSource, string> = {
  freepik: "Freepik",
  drive: "Client's Drive",
  pinterest: "Pinterest",
  upload: "Upload",
  product: "Product photo",
  brand: "Brand asset",
};

export default function SourceBadge({ source, compact, className }: { source: PictureSource; compact?: boolean; className?: string }) {
  const label = SOURCE_LABELS[source];
  return (
    <span className={`src-badge ${source} ${compact ? "compact" : ""} ${className ?? ""}`} title={`Source: ${label}`}>
      {compact ? label.replace("Client's ", "") : label}
    </span>
  );
}
