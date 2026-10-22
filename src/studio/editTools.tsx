/**
 * The pieces of an AI edit shared by the post editor's Image group and the Photo studio's Edit
 * panel: the one-click instruction presets and the reference picture attached to the post for its
 * edits. One copy, so the two screens say and do the same thing.
 */
import { useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { toast } from "sonner";
import { Orb } from "@/components/Orb";
import { del, postForm } from "@/api";
import { rasterize } from "@/lib/image";
import { referenceThumb } from "./PostTools";
import type { Post } from "@shared/posts";

/** One-click revision instructions; each appends to the edit box. */
export const REVISION_PRESETS: { label: string; text: string }[] = [
  {
    label: "Background",
    text: "Change only the background: a cleaner, simpler setting in the brand's colours; the product, its position, size and light stay exactly as they are.",
  },
  {
    label: "Lighting",
    text: "Relight the scene: softer, more natural light from one side with gentle shadows; the product's own colours stay true to its photo.",
  },
  {
    label: "Composition",
    text: "Recompose: the product centred and larger in the frame with calm space around it for the words; nothing new added.",
  },
  {
    label: "Remove an object",
    text: "Remove the [name the object] from the picture and fill the place naturally; everything else stays exactly as it is.",
  },
  {
    label: "Product correction",
    text: "Make the product match its photo exactly: shape, colours, label and lid as photographed, whole and undistorted; keep the scene.",
  },
  {
    label: "Blend with scene",
    text: "Light the product with the scene's own light: same direction, hardness and colour as the surroundings, real highlights and reflections on its materials, one shadow matching the scene's shadows plus a soft contact shadow at its base, the same grain and colour grade as the background, no cutout edges. Keep the product, the composition and the framing exactly.",
  },
  {
    label: "More brand colour",
    text: "Push the props, surfaces and light toward the brand palette; the product keeps its own exact colours.",
  },
  {
    label: "Cleaner background",
    text: "Simplify the background: fewer objects, no readable text, softer depth of field; keep the place and the light.",
  },
  {
    label: "Leave headline space",
    text: "Re-compose so roughly a third of the frame is a calm, low-detail, low-contrast area where a headline can sit; the product and the subject stay unchanged.",
  },
  {
    label: "Match product",
    text: "Match the product's shape, colours, label and packaging exactly to image 1; no restyling.",
  },
  {
    label: "Remove text",
    text: "Remove every letter, number, logo, sticker or watermark drawn in the image; keep the product's own printed packaging as in image 1.",
  },
  {
    label: "Brighter",
    text: "Make the scene brighter with soft natural light; keep the product colours accurate.",
  },
  {
    label: "Closer",
    text: "Move the camera closer so the product fills more of the frame; keep the scene and the light.",
  },
];

/**
 * A reference picture for the edit: attached under the instruction, it goes to the engine with the
 * current picture, and the instruction says what to take from it. It stays on the post for its
 * next takes too, until taken off.
 */
export function EditReference({ batchId, post, note, disabled, onChanged }: { batchId: string; post: Post; note: string; disabled: boolean; onChanged: () => Promise<void> | void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const ref = post.reference;
  async function attach(file: File) {
    setBusy(true);
    try {
      const form = new FormData();
      form.set("batch", batchId);
      form.set("index", String(post.index));
      form.set("note", note.trim());
      // The browser redraws the picture first (a phone photo, a huge PNG): the server reads a plain PNG or JPEG.
      const ready = await rasterize(file);
      form.set("file", ready, ready.name);
      await postForm("/api/studio/posts/reference", form);
      await onChanged();
      toast.success("Reference attached: the next edit of this picture takes it.");
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not attach the reference.");
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    try {
      await del(`/api/studio/posts/reference?batch=${encodeURIComponent(batchId)}&index=${post.index}`);
      await onChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not take the reference off.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="edit-ref-row">
      <input
        ref={input}
        type="file"
        accept="image/*"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (f) void attach(f);
        }}
      />
      {ref ? (
        <>
          <img src={referenceThumb(batchId, post.index, ref.at)} alt="" />
          <span className="edit-ref-text">
            <strong>Reference attached{ref.name ? ` · ${ref.name}` : ""}</strong>
            <small>The edit takes from it what the instruction says (a background, a light, a mood). It stays on this post for its next takes until you take it off.</small>
          </span>
          <button type="button" className="text-button" disabled={disabled || busy} onClick={() => input.current?.click()}>
            {busy ? <Orb size={12} /> : <ImagePlus size={13} />} Change
          </button>
          <button type="button" className="text-button" disabled={disabled || busy} onClick={() => void remove()}>
            <X size={13} /> Take off
          </button>
        </>
      ) : (
        <>
          <button type="button" className="text-button" disabled={disabled || busy} onClick={() => input.current?.click()} title="A picture the edit takes from: a background, a light, a mood. Say in the instruction what to take from it.">
            {busy ? <Orb size={12} /> : <ImagePlus size={13} />} Attach a reference for this edit
          </button>
          <small className="revision-note">A background, a light or a mood to take from; say in the instruction what to take.</small>
        </>
      )}
    </div>
  );
}
