import { useCallback, useEffect, useRef, useState } from "react";
import { askConfirm } from "@/lib/confirm";
import { createPortal } from "react-dom";
import { ImagePlus, LoaderCircle, X } from "lucide-react";
import { toast } from "sonner";
import { del, get } from "@/api";
import { makeReference } from "@/lib/image";

interface Reference {
  id: string;
  name: string | null;
  created: number;
  /** Pose photos: the framing they are used for. */
  framing?: string | null;
}

const FRAMING_LABEL: Record<string, string> = {
  FULL_BODY: "Full body",
  THREE_QUARTER: "¾ body",
  UPPER_BODY: "Upper body",
  LOWER_BODY: "Lower body",
};

/**
 * Inspiration photos for one skill. Each generation borrows background, pose and lighting from
 * one of them (never clothing or accessories); the team adds and removes photos here.
 */
export default function ReferenceLibrary({
  skill,
  title,
  onChanged,
  empty = "No reference photos yet. Add a few: each image borrows background, pose and lighting from one of them (never the clothes or accessories).",
  hint,
  actions,
}: {
  skill: string;
  title: string;
  /** Called after photos were added or removed, with the new count. */
  onChanged?: (count: number) => void | Promise<void>;
  /** Text shown while the library is empty. */
  empty?: string;
  /** Text shown under the photos; defaults to the fashion wording. */
  hint?: string;
  /** Extra controls next to "Add photos" (for example an import button). */
  actions?: React.ReactNode;
}) {
  const [items, setItems] = useState<Reference[]>([]);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  // Hovering a thumbnail shows the photo at a readable size next to the pointer.
  const [preview, setPreview] = useState<{ item: Reference; x: number; y: number } | null>(null);

  const load = useCallback(async () => {
    try {
      const d = await get<{ references: Reference[] }>(
        `/api/studio/references?skill=${encodeURIComponent(skill)}`,
      );
      setItems(d.references);
    } catch {
      setItems([]);
    }
  }, [skill]);

  useEffect(() => {
    void load();
  }, [load]);

  async function add(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append("skill", skill);
      // Reference photos are sent to the prompt builder on every run; a resized copy keeps those
      // calls small and fast without changing what the builder sees.
      for (const f of Array.from(files)) {
        // Flat bars around a photo (white side borders) are cut away: the engines would copy them.
        const small = await makeReference(f, 1600, 0.94, true).catch(() => f);
        form.append("file", small, f.name.replace(/\.[^.]+$/, "") + ".jpg");
      }
      const r = await fetch("/api/studio/references", { method: "POST", body: form });
      if (!r.ok)
        throw new Error(((await r.json()) as { error?: string }).error || "Upload failed.");
      await load();
      toast.success(`${files.length} reference${files.length > 1 ? "s" : ""} added.`);
      await onChanged?.(items.length + files.length);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }

  async function remove(id: string) {
    if (!(await askConfirm("Remove this reference photo from the library?"))) return;
    try {
      await del(`/api/studio/references/${id}`);
      setItems((l) => l.filter((r) => r.id !== id));
      await onChanged?.(items.length - 1);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <>
      <div className="field-row">
        <label className="field-label">{title}</label>
        <button
          type="button"
          className="text-button"
          disabled={busy}
          onClick={() => input.current?.click()}
        >
          {busy ? <LoaderCircle className="spinning" size={13} /> : <ImagePlus size={13} />}
          Add photos
        </button>
        {actions}
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          hidden
          onChange={(e) => void add(e.target.files)}
        />
      </div>
      {items.length ? (
        <div className="mood-strip">
          {items.map((r) => (
            <figure
              key={r.id}
              onMouseEnter={(e) => setPreview({ item: r, x: e.clientX, y: e.clientY })}
              onMouseMove={(e) => setPreview({ item: r, x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setPreview(null)}
            >
              <img
                src={`/api/studio/references/${r.id}/file`}
                alt={r.name ?? "reference"}
                loading="lazy"
              />
              <button
                type="button"
                className="mood-remove"
                aria-label="Remove reference"
                onClick={() => void remove(r.id)}
              >
                <X size={12} />
              </button>
              {r.framing && (
                <span className="ref-tag">{FRAMING_LABEL[r.framing] ?? r.framing}</span>
              )}
            </figure>
          ))}
        </div>
      ) : (
        <div className="prompt-tip">{empty}</div>
      )}
      {preview && createPortal(<HoverPreview {...preview} />, document.body)}
      {items.length > 0 && (
        <div className="prompt-tip">
          {items.length} photo{items.length > 1 ? "s" : ""}.{" "}
          {hint ??
            "Each image borrows background, pose and lighting from one of them, rotating so results differ; clothes, hats, bags and accessories are never copied."}
        </div>
      )}
    </>
  );
}

const PREVIEW_W = 420;
const PREVIEW_H = 560;

/** The hovered reference at a readable size, kept inside the viewport and never under the pointer. */
function HoverPreview({ item, x, y }: { item: Reference; x: number; y: number }) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = x + 20 + PREVIEW_W > vw ? Math.max(8, x - 20 - PREVIEW_W) : x + 20;
  const top = Math.max(8, Math.min(y - PREVIEW_H / 3, vh - PREVIEW_H - 8));
  return (
    <div className="ref-preview" style={{ left, top }} aria-hidden>
      <img src={`/api/studio/references/${item.id}/file`} alt="" />
      <div className="ref-preview-caption">
        {item.name ?? "Reference"}
        {item.framing ? ` · ${FRAMING_LABEL[item.framing] ?? item.framing}` : ""}
      </div>
    </div>
  );
}
