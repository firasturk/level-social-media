import { useState } from "react";
import { Download, FileText, X } from "lucide-react";
import type { Attachment, RefPreview, ReviewStatus } from "@shared/team";
import { REVIEW_STATUSES } from "@shared/team";
import { fileSize, tokenizeBody } from "@shared/team-ui";
import { VoicePlayer } from "./VoiceNote";

/** The text of a message: mentions as chips, links clickable, Arabic lines right-to-left on their own. */
export function MessageBody({ body, me, className = "" }: { body: string; me?: string; className?: string }) {
  const tokens = tokenizeBody(body);
  return (
    <p className={`tm-body ${className}`} dir="auto">
      {tokens.map((t, i) => {
        if (t.t === "br") return <br key={i} />;
        if (t.t === "text") return <span key={i}>{t.v}</span>;
        if (t.t === "link")
          return (
            <a key={i} href={t.href} target="_blank" rel="noopener noreferrer" className="tm-link">
              {t.href.replace(/^https?:\/\//, "")}
            </a>
          );
        return (
          <span key={i} className={`tm-mention ${t.id === me ? "me" : ""} ${t.id === "level-ai" ? "ai" : ""}`}>
            @{t.name}
          </span>
        );
      })}
    </p>
  );
}

/** Pictures as tiles, voice notes as a player, anything else as a row with its name and size. */
export function Attachments({ items, compact = false }: { items: Attachment[]; compact?: boolean }) {
  const [zoom, setZoom] = useState<Attachment | null>(null);
  if (!items.length) return null;
  const images = items.filter((a) => a.kind === "image");
  const voices = items.filter((a) => a.kind === "voice");
  const files = items.filter((a) => a.kind === "file");
  return (
    <div className={`tm-attachments ${compact ? "compact" : ""}`}>
      {images.length > 0 && (
        <div className={`tm-images n${Math.min(images.length, 4)}`}>
          {images.map((a) => (
            <button key={a.id} type="button" className="tm-image" onClick={() => setZoom(a)} title={a.name} style={a.width && a.height ? ({ "--ar": `${a.width} / ${a.height}` } as React.CSSProperties) : undefined}>
              <img src={`${a.url}${a.url.includes("?") ? "&" : "?"}w=480`} alt={a.name} loading="lazy" />
            </button>
          ))}
        </div>
      )}
      {voices.map((a) => (
        <VoicePlayer key={a.id} src={a.url} duration={a.duration ?? null} />
      ))}
      {files.map((a) => (
        <a key={a.id} className="tm-file" href={a.url} target="_blank" rel="noopener noreferrer" download={a.name} title={a.name}>
          <span className="tm-file-icon">
            <FileText size={16} />
          </span>
          <span className="tm-file-name" dir="auto">
            {a.name}
          </span>
          <span className="tm-file-size">{fileSize(a.size)}</span>
          <Download size={14} className="tm-file-dl" />
        </a>
      ))}
      {zoom && (
        <div className="tm-lightbox" role="dialog" aria-label={zoom.name} onClick={() => setZoom(null)}>
          <img src={zoom.url} alt={zoom.name} />
          <a className="tm-lightbox-dl" href={zoom.url} download={zoom.name} onClick={(e) => e.stopPropagation()}>
            <Download size={16} /> Download
          </a>
          <button type="button" className="tm-lightbox-close" aria-label="Close" onClick={() => setZoom(null)}>
            <X size={18} />
          </button>
        </div>
      )}
    </div>
  );
}

export function reviewLabel(s: ReviewStatus | null | undefined): string {
  return REVIEW_STATUSES.find((x) => x.id === s)?.label ?? "";
}

/** The internal approval state, as a small pill. */
export function ReviewPill({ status, className = "" }: { status: ReviewStatus | null | undefined; className?: string }) {
  if (!status) return null;
  return <span className={`tm-pill review-${status} ${className}`}>{reviewLabel(status)}</span>;
}

/** What a message is about: a compact card with the creative's thumb, where it lives, its state. Click opens the Studio there. */
export function CreativeCard({ preview, onOpen, actions, large = false }: { preview: RefPreview; onOpen?: () => void; actions?: React.ReactNode; large?: boolean }) {
  return (
    <div className={`tm-creative ${large ? "large" : ""}`}>
      <button type="button" className="tm-creative-main" onClick={onOpen} disabled={!onOpen} title={onOpen ? "Open in the Studio" : undefined}>
        <span className="tm-creative-thumb">{preview.thumb ? <img src={preview.thumb} alt="" loading="lazy" /> : <span className="tm-creative-blank" aria-hidden="true" />}</span>
        <span className="tm-creative-text">
          <b dir="auto">{preview.title}</b>
          <small>{preview.where}</small>
          <span className="tm-creative-pills">
            {preview.status && <span className="tm-pill soft">{preview.status}</span>}
            <ReviewPill status={preview.review} />
          </span>
        </span>
      </button>
      {actions && <div className="tm-creative-actions">{actions}</div>}
    </div>
  );
}
