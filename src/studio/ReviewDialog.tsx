import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Bookmark,
  ChevronLeft,
  ChevronRight,
  Download,
  FolderDown,
  RefreshCw,
  ScanLine,
} from "lucide-react";
import { Orb } from "@/components/Orb";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { QA, Source, Take, Task } from "@shared/types";
import { fixNote } from "@shared/qa";
import Zoomable from "./Zoomable";
import CompareSlider from "./CompareSlider";
import { formatUsd } from "@shared/pricing";
import VoiceInput from "@/components/VoiceInput";
import { POST_TYPE_INFO, POST_TYPES, type Post } from "@shared/posts";

/** The four groups of the post editor, in the order the team works: the idea, its picture, the words, the earlier versions. */
const GROUPS = [
  { id: "idea", label: "Idea" },
  { id: "image", label: "Image" },
  { id: "words", label: "Words & design" },
  { id: "versions", label: "Versions" },
] as const;
export type Group = (typeof GROUPS)[number]["id"];

/** One-click revision instructions; each appends to the edit box. */
const REVISION_PRESETS: { label: string; text: string }[] = [
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

interface StoredBrief {
  scene?: string;
  pose?: string;
  light?: string;
  faceMode?: string;
  subject?: string;
}

interface StoredPlan {
  np: true;
  framing?: string;
  handsInPockets?: boolean;
  backView?: boolean;
  scene?: string;
  poseNotes?: string;
}

/** The task's stored brief: a skill brief, a No prompt plan, or nothing when absent or unreadable. */
function parseBrief(raw: string | null | undefined): StoredBrief | StoredPlan | null {
  if (!raw) return null;
  try {
    const d = JSON.parse(raw) as unknown;
    if (!d || typeof d !== "object") return null;
    return d as StoredBrief | StoredPlan;
  } catch {
    return null;
  }
}

/** The post editor's four groups over a month of posts: everything the card offers, in one place. */
export interface PostEditorTools {
  post: Post;
  /** The month's product photos, for the product choice (upload names). */
  products: { id: string; name: string }[];
  /** The month's cast, by name, for the people choice. */
  cast: string[];
  /** About what one picture costs on this month's engine, or 0 when not known. */
  perPicture: number;
  onSavePost: (patch: Partial<Post>) => Promise<void> | void;
  /** "Edit this picture" with a note: the current photo changed, not remade. */
  onEdit: (note: string) => Promise<void>;
  /** The team accepts the picture as it is. */
  onAccept?: () => Promise<void>;
  /** A fresh idea written for the post (free), then its picture is made. */
  onNewIdea?: () => void;
  /** A post without a picture yet: its picture made from the plan (the budget check and cost apply). */
  onMake?: () => void;
  /** The group the editor opens on. */
  initialGroup?: Group;
  /** The picture from before the last regenerate. */
  onPrevious?: () => Promise<void>;
  onOpenText?: () => void;
  onAnimate?: () => void;
  onVideo?: () => void;
  /** The month's earlier versions (the MonthVersions panel). */
  versions?: ReactNode;
  /** This post's takes, newest first, from the server. */
  takes?: Take[];
  /** An earlier take back on the post (the current picture stays listed). */
  onUseTake?: (key: string) => Promise<void>;
  /** Who accepted it, when someone did. */
  acceptedBy?: string;
  lineage: "current" | "older" | "unknown" | "none";
}

export default function ReviewDialog({
  task,
  source,
  busy,
  originalUrl,
  resultUrl,
  position,
  onClose,
  onRevise,
  onDownload,
  onDownloadSet,
  onSaveLook,
  onRemake,
  onPrev,
  onNext,
  editor,
}: {
  /** Present for a post of a month: the dialog becomes the four-group editor. */
  editor?: PostEditorTools;
  task: Task | null;
  source: Source | null;
  busy: boolean;
  originalUrl: string;
  resultUrl: string;
  position?: { index: number; total: number };
  onClose: () => void;
  onRevise: (edit: string) => Promise<void>;
  /** Save this one result to the computer; absent while there is no result yet. */
  onDownload?: () => void;
  /** Save every generated image of this product set as one ZIP; absent when the image is not in a set. */
  onDownloadSet?: () => void;
  /** Save this image's skill prompt as a reusable look; absent outside skill campaigns. */
  onSaveLook?: () => void;
  /** A post made again from its brief (a new picture, not an edit of this one). */
  onRemake?: () => void;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  const [view, setView] = useState<"compare" | "result" | "original">("compare");
  /** An earlier take put beside the current picture in the compare view (null: the product photo). */
  const [compareWith, setCompareWith] = useState<Take | null>(null);
  useEffect(() => setCompareWith(null), [task?.id, task?.output]);
  const [edit, setEdit] = useState("");
  const [group, setGroup] = useState<Group>(editor?.initialGroup ?? "image");
  useEffect(() => setGroup(editor?.initialGroup ?? (task?.output ? "image" : "idea")), [editor?.post.index, editor?.initialGroup, task?.id, task?.output]);
  /** The post's fields as typed here; saved as a whole on Save. */
  const [draft, setDraft] = useState<Partial<Post>>({});
  useEffect(() => setDraft({}), [editor?.post.index, task?.id]);
  const field = <K extends keyof Post>(k: K): Post[K] | undefined => (k in draft ? (draft[k] as Post[K]) : editor?.post[k]);
  const set = <K extends keyof Post>(k: K, v: Post[K] | undefined) => setDraft((d) => ({ ...d, [k]: v }));
  const dirty = Object.keys(draft).length > 0;
  const cost = editor?.perPicture ? ` · about ${formatUsd(editor.perPicture)}` : "";
  /** Unsaved fields are saved as one patch; nothing is saved while nothing changed. */
  const saveDraft = async () => {
    if (!editor || !dirty) return;
    const patch = { ...draft };
    const post = editor.post;
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
    const productChanged = ("product" in patch && !same(post.product, patch.product)) || ("people" in patch && !same(post.people, patch.people));
    const briefChanged = "brief" in patch && !same(post.brief, patch.brief);
    // A new product, a new cast or a new idea: the old shot no longer describes the post (as on the card).
    if ((productChanged || briefChanged) && !("scene" in patch)) {
      patch.scene = undefined;
      patch.handShot = undefined;
    }
    // A shot written here is the designer's own: the shots writer leaves it alone.
    if ("scene" in patch && patch.scene?.trim()) patch.handShot = true;
    await editor.onSavePost(patch);
    setDraft({});
  };
  /** Leaving the post (next, previous, close) keeps what was typed, like the cards do. */
  const leave = (then?: () => void) => {
    void (dirty ? saveDraft() : Promise.resolve()).then(() => then?.());
  };
  const editRef = useRef<HTMLTextAreaElement>(null);
  const qa = task?.qa ? (JSON.parse(task.qa) as QA) : null;
  // The stored brief is a written skill brief in the skill approaches, or the No prompt plan
  // (background, pose, framing). Anything unreadable is simply not shown.
  const stored = parseBrief(task?.brief);
  const brief = stored && !("np" in stored) ? stored : null;
  const plan = stored && "np" in stored ? stored : null;
  const fabric = task?.card === 6;
  const inFlight = !!task && (task.status === "processing" || task.status === "queued");

  // Keyboard: R revise, arrows navigate, 1/2/3 switch views. Ignored while typing.
  useEffect(() => {
    if (!task) return;
    const onKey = (e: KeyboardEvent) => {
      const typing =
        (e.target as HTMLElement)?.tagName === "TEXTAREA" ||
        (e.target as HTMLElement)?.tagName === "INPUT";
      if (typing) return;
      if (e.key === "ArrowLeft" && onPrev) leave(onPrev);
      else if (e.key === "ArrowRight" && onNext) leave(onNext);
      else if (e.key === "r" || e.key === "R") editRef.current?.focus();
      else if (e.key === "1") setView("compare");
      else if (e.key === "2") setView("result");
      else if (e.key === "3") setView("original");
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // `leave` saves what was typed before moving on; it reads the draft as it is when a key is pressed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task, onPrev, onNext, busy, dirty]);

  useEffect(() => setEdit(""), [task?.id]);

  return (
    <Dialog
      open={!!task || !!editor}
      onOpenChange={(open) => {
        if (!open) {
          setEdit("");
          leave(onClose);
        }
      }}
    >
      <DialogContent className={`review-dialog ${editor ? "post-editor" : ""}`}>
        <DialogHeader>
          <DialogTitle>
            {editor ? `Post ${editor.post.index} · ${editor.post.title || POST_TYPE_INFO[editor.post.type]?.label || "post"}` : source?.name}
            {position && (
              <span className="review-position">
                {position.index + 1} / {position.total}
              </span>
            )}
          </DialogTitle>
          <DialogDescription>
            {editor
              ? "The idea, the picture, the words and the earlier versions of this post. Keys: ← → next post · R edit the picture."
              : "Drag the slider to compare. Keys: ← → next image · R revise · 1/2/3 views."}
          </DialogDescription>
        </DialogHeader>
        {editor && (
          <div className="editor-groups" role="tablist" aria-label="Post editor">
            {GROUPS.map((g) => (
              <button
                key={g.id}
                type="button"
                role="tab"
                aria-selected={group === g.id}
                className={group === g.id ? "chosen" : ""}
                onClick={() => setGroup(g.id)}
              >
                {g.label}
              </button>
            ))}
            {dirty && <span className="editor-unsaved">Unsaved changes</span>}
          </div>
        )}
        {editor && group === "idea" && (
          <div className="editor-group" role="tabpanel">
            <div className="editor-row">
              <label className="field-label">
                Type
                <select value={field("type")} onChange={(e) => set("type", e.target.value as Post["type"])} disabled={busy}>
                  {POST_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {POST_TYPE_INFO[t].label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field-label">
                Date
                <input type="date" value={field("date") ?? ""} onChange={(e) => set("date", e.target.value || undefined)} disabled={busy} />
              </label>
              <label className="field-label">
                Product
                <select value={field("product") ?? ""} onChange={(e) => set("product", e.target.value || undefined)} disabled={busy}>
                  <option value="">No product</option>
                  {editor.products.map((pr) => (
                    <option key={pr.id} value={pr.name}>
                      {pr.name}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label className="field-label">
              Title
              <input value={field("title") ?? ""} onChange={(e) => set("title", e.target.value)} disabled={busy} />
            </label>
            <label className="field-label">
              Idea: what the photograph shows
              <textarea rows={3} value={field("brief") ?? ""} onChange={(e) => set("brief", e.target.value)} disabled={busy} />
            </label>
            <label className="field-label">
              Shot: the scene written for this product (empty: written again from the month's look)
              <textarea rows={3} value={field("scene") ?? ""} onChange={(e) => set("scene", e.target.value || undefined)} disabled={busy} />
            </label>
            {editor.cast.length > 0 && (
              <div className="editor-people">
                <span className="field-label">People in the picture</span>
                {editor.cast.map((name) => {
                  const people = field("people") ?? [];
                  const on = people.includes(name);
                  return (
                    <label key={name} className="check-row">
                      <input
                        type="checkbox"
                        checked={on}
                        disabled={busy}
                        onChange={(e) => {
                          const next = e.target.checked ? [...people, name] : people.filter((n) => n !== name);
                          set("people", next.length ? next : undefined);
                        }}
                      />
                      {name}
                    </label>
                  );
                })}
              </div>
            )}
            <div className="editor-actions">
              <button type="button" className="primary" disabled={busy || !dirty} onClick={() => void saveDraft()}>
                Save
              </button>
              {onRemake && (
                <button
                  type="button"
                  className="secondary"
                  disabled={busy || inFlight}
                  onClick={() => leave(onRemake)}
                  title="A fresh picture of the saved idea; the picture it replaces stays under Versions"
                >
                  Save and make another version{cost}
                </button>
              )}
              {editor.onNewIdea && (
                <button type="button" className="secondary" disabled={busy || inFlight} onClick={() => leave(editor.onNewIdea)} title="A new idea written for this post (free); its picture is made after">
                  Write a new idea
                </button>
              )}
            </div>
            <span className="revision-note">
              Saving the idea never remakes the picture by itself. A saved idea newer than its picture shows as "Older idea" on the card until the picture is edited or made again.
            </span>
          </div>
        )}
        {editor && group === "words" && (
          <div className="editor-group" role="tabpanel">
            <div className="editor-row">
              <label className="field-label">
                Headline: drawn on the picture
                <input value={field("headline") ?? ""} onChange={(e) => set("headline", e.target.value || undefined)} disabled={busy} />
              </label>
              <label className="field-label">
                Second line
                <input value={field("subline") ?? ""} onChange={(e) => set("subline", e.target.value || undefined)} disabled={busy} />
              </label>
            </div>
            <label className="check-row">
              <input type="checkbox" checked={field("overlay") !== false} disabled={busy} onChange={(e) => set("overlay", e.target.checked ? undefined : false)} />
              Text on the image (off: a text-free picture; the caption still posts)
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={field("ov")?.fade !== false}
                disabled={busy}
                onChange={(e) => set("ov", { ...(field("ov") ?? {}), fade: e.target.checked ? undefined : false })}
              />
              Dark fade behind the words
            </label>
            <label className="field-label">
              Caption: posted with the picture, not drawn on it
              <textarea rows={3} value={field("caption") ?? ""} onChange={(e) => set("caption", e.target.value)} disabled={busy} />
            </label>
            <label className="field-label">
              Hashtags
              <input value={field("hashtags") ?? ""} onChange={(e) => set("hashtags", e.target.value)} disabled={busy} />
            </label>
            <div className="editor-actions">
              <button type="button" className="primary" disabled={busy || !dirty} onClick={() => void saveDraft()}>
                Save
              </button>
              {editor.onOpenText && (
                <button type="button" className="secondary" disabled={busy || !task?.output} onClick={() => leave(editor.onOpenText)} title="Place and style the words on the picture">
                  Open the Text studio
                </button>
              )}
              {editor.onAnimate && (
                <button type="button" className="secondary" disabled={busy || !task?.output} onClick={() => leave(editor.onAnimate)} title="An animated version of the words on this picture">
                  Animate
                </button>
              )}
              {editor.onVideo && (
                <button type="button" className="secondary" disabled={busy || !task?.output} onClick={() => leave(editor.onVideo)} title="A short video from this picture (engine credits)">
                  Video
                </button>
              )}
            </div>
            <span className="revision-note">Words and the caption are saved free. The Text studio redraws the words on the saved picture; Animate and Video use the engine.</span>
          </div>
        )}
        {editor && group === "versions" && (
          <div className="editor-group" role="tabpanel">
            <p className="editor-lineage">
              {editor.lineage === "current" && "This picture was made for the idea as it is now."}
              {editor.lineage === "older" && "This picture was made for an earlier version of the idea. Edit this picture to bring it up to date, or make another version."}
              {editor.lineage === "unknown" && "Made before the studio kept track of which idea each picture was made for (lineage unknown). It stays usable as it is."}
              {editor.lineage === "none" && "No picture yet for this post."}
              {editor.acceptedBy && ` Accepted by ${editor.acceptedBy}.`}
            </p>
            {editor.onPrevious && (
              <button type="button" className="secondary" disabled={busy || inFlight} onClick={() => void editor.onPrevious!()} title="The picture from before the last remake, back on the post">
                Previous picture
              </button>
            )}
            {editor.takes && editor.takes.length > 0 && (
              <div className="takes">
                <span className="field-label">This post's takes · {editor.takes.length}</span>
                <ul className="takes-list">
                  {editor.takes.map((tk) => (
                    <li key={tk.id} className={`${tk.status} ${tk.current ? "current" : ""}`}>
                      {tk.image ? <img src={tk.image} alt="" loading="lazy" /> : <span className="take-blank" aria-hidden />}
                      <span className="take-text">
                        <b>
                          {tk.status === "failed" ? "Failed" : tk.current ? "Current picture" : "Earlier take"}
                          {tk.cost > 0 ? ` · ${formatUsd(tk.cost)}` : tk.status === "failed" ? " · nothing charged" : ""}
                        </b>
                        <small>
                          {new Date(tk.created).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}
                          {tk.note ? ` · ${tk.note}` : ""}
                        </small>
                        {tk.status === "failed" && tk.cost > 0 && <small>The cost the engine reported for the attempt; it may still be billed.</small>}
                      </span>
                      {tk.status === "made" && !tk.current && tk.key && (
                        <span className="take-actions">
                          <button type="button" className="text-button" disabled={busy} onClick={() => { setCompareWith(tk); setGroup("image"); setView("compare"); }}>
                            Compare
                          </button>
                          {editor.onUseTake && (
                            <button type="button" className="text-button" disabled={busy || inFlight} onClick={() => void editor.onUseTake!(tk.key!)}>
                              Use this picture
                            </button>
                          )}
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {editor.versions}
          </div>
        )}
        {editor && !task && group === "image" && (
          <div className="editor-group" role="tabpanel">
            <p className="editor-lineage">No picture yet for this post. It is made from the idea, the shot and the month's look; the cost is shown before anything is made.</p>
            {editor.onMake && (
              <button type="button" className="primary" disabled={busy} onClick={editor.onMake}>
                Make the picture{cost}
              </button>
            )}
          </div>
        )}
        <div className="review-layout" hidden={!task || (!!editor && group !== "image")}>
          <div>
            <div className="comparison-bar">
              <button
                className={view === "compare" ? "chosen" : ""}
                onClick={() => setView("compare")}
              >
                {compareWith ? "Earlier take · now" : "Compare"}
              </button>
              {compareWith && (
                <button type="button" className="text-button" onClick={() => setCompareWith(null)} title="Back to the product photo beside the picture">
                  Product photo
                </button>
              )}
              <button
                className={view === "result" ? "chosen" : ""}
                onClick={() => setView("result")}
              >
                AI result
              </button>
              <button
                className={view === "original" ? "chosen" : ""}
                onClick={() => setView("original")}
              >
                Original
              </button>
              <span className="nav-arrows">
                <button onClick={() => leave(onPrev)} disabled={!onPrev} aria-label="Previous image">
                  <ChevronLeft size={16} />
                </button>
                <button onClick={() => leave(onNext)} disabled={!onNext} aria-label="Next image">
                  <ChevronRight size={16} />
                </button>
              </span>
            </div>
            <div className="review-photo">
              {task && view === "compare" && (
                <CompareSlider
                  before={compareWith?.image ?? originalUrl}
                  after={resultUrl}
                  alt="Generated product photo"
                />
              )}
              {task && view !== "compare" && (
                <Zoomable
                  src={view === "original" ? originalUrl : resultUrl}
                  alt={view === "original" ? "Original product photo" : "Generated product photo"}
                  overlay={<div className="center-line" />}
                />
              )}
            </div>
          </div>
          <div className="revision-panel">
            <div className="qa-heading">
              <ScanLine size={18} />
              <strong>Image review</strong>
            </div>
            {qa?.flags && (
              <div className={`post-review ${qa.flags.length ? "warn" : "pass"}`}>
                <strong>{qa.flags.length ? "Automatic review: check these" : "Automatic review passed"}</strong>
                {qa.flags.length ? (
                  <ul>
                    {qa.flags.map((f, i) => (
                      <li key={i}>{f.text}</li>
                    ))}
                  </ul>
                ) : (
                  <span>{qa.notes}</span>
                )}
                {qa.flags.length > 0 && (
                  <div className="post-review-actions">
                    <button
                      type="button"
                      className="primary"
                      disabled={busy || inFlight}
                      onClick={() => void onRevise(fixNote(qa.flags!))}
                      title="Edit this picture: the current photo is changed to take out what the review found"
                    >
                      <RefreshCw size={15} /> Edit this picture
                    </button>
                    {onRemake && (
                      <button type="button" className="secondary" disabled={busy || inFlight} onClick={onRemake} title="Make another version: a fresh picture of the same idea; this one stays under Versions">
                        Make another version{cost}
                      </button>
                    )}
                    {editor?.onAccept && !editor.acceptedBy && (
                      <button type="button" className="secondary" disabled={busy || inFlight} onClick={() => void editor.onAccept!()} title="The team accepts the picture as it is; the client's approval is separate">
                        Accept as it is
                      </button>
                    )}
                  </div>
                )}
                {editor?.acceptedBy && <span className="editor-accepted">Accepted by {editor.acceptedBy} (team). The client's approval is separate.</span>}
              </div>
            )}
            {qa && !qa.flags && (
              <div className="qa-strip">
                <span className={`qa-chip ${fabric ? "" : qa.centered ? "pass" : "warn"}`}>
                  Alignment:{" "}
                  {fabric
                    ? "n/a"
                    : !qa.automated
                      ? "manual"
                      : qa.found
                        ? `${Number(qa.offset).toFixed(1)}% off`
                        : "check"}
                </span>
                <span className={`qa-chip ${qa.productConcern ? "warn" : "pass"}`}>
                  Fidelity:{" "}
                  {!qa.automated ? "manual" : qa.productConcern ? "check differences" : "ok"}
                </span>
                {qa.automated &&
                  qa.sameFace !== undefined &&
                  task &&
                  task.card > 1 &&
                  task.card < 6 && (
                    <span className={`qa-chip ${qa.sameFace ? "pass" : "warn"}`}>
                      Face: {qa.sameFace ? "same" : "different"}
                    </span>
                  )}
                {task && task.cost > 0 && (
                  <span className="qa-chip">≈ ${task.cost.toFixed(2)}</span>
                )}
                {qa.notes && <span className="qa-notes-inline">{qa.notes}</span>}
              </div>
            )}
            {plan && (
              <div className="brief-box">
                <strong>No prompt plan</strong>
                <span>
                  Framing: {(plan.framing ?? "full body").replace("_", " ").toLowerCase()}
                  {plan.backView ? " · back view" : ""}
                  {plan.handsInPockets ? " · hands in pockets" : ""}
                </span>
                {plan.scene && <span>Scene: {plan.scene}</span>}
                {plan.poseNotes && <span>Pose: {plan.poseNotes}</span>}
              </div>
            )}
            {brief && (
              <div className="brief-box">
                <strong>Skill brief</strong>
                <span>
                  {brief.subject}
                  {brief.faceMode ? ` · ${brief.faceMode.replace("_", " ").toLowerCase()}` : ""}
                </span>
                <span>Scene: {brief.scene}</span>
                <span>Pose: {brief.pose}</span>
                <span>Light: {brief.light}</span>
              </div>
            )}
            {task?.prompt && (
              <details className="prompt-details">
                <summary>Prompt used</summary>
                <pre>{task.prompt}</pre>
              </details>
            )}
            {task?.error && <p className="image-error">{task.error}</p>}

            {inFlight && (
              <p className="revision-progress">
                <Orb size={15} />
                {task?.status === "queued"
                  ? "A new version of this image is queued. "
                  : "A new version of this image is being generated. "}
                The current result stays until it arrives; with Economy mode this can take a while.
              </p>
            )}
            <label className="field-label" htmlFor="revision">
              Edit this result
            </label>
            <div className="preset-chips">
              {REVISION_PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  disabled={busy}
                  onClick={() => setEdit((e) => (e ? `${e} ${p.text}` : p.text))}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <textarea
              id="revision"
              ref={editRef}
              rows={4}
              dir="auto"
              placeholder="e.g. Keep the outfit unchanged. Move the model to the exact centre and use a brighter urban background."
              value={edit}
              onChange={(e) => setEdit(e.target.value)}
              disabled={busy}
            />
            <div className="revision-voice">
              <VoiceInput label="Dictate the change" onText={(t) => setEdit((e) => (e.trim() ? `${e.trim()} ${t}` : t))} disabled={busy} />
            </div>
            <button
              className="primary"
              onClick={() => onRevise(edit).then(() => setEdit(""))}
              disabled={busy || !edit.trim() || inFlight}
            >
              {busy ? <Orb size={17} /> : <RefreshCw size={17} />}
              {inFlight ? "Revision in progress…" : "Generate revision"}
            </button>
            <button
              className="secondary"
              onClick={onDownload}
              disabled={!onDownload}
              title="Save this AI result to your computer"
            >
              <Download size={17} />
              Download this image
            </button>
            {onDownloadSet && (
              <button className="secondary" onClick={onDownloadSet} disabled={busy}>
                <FolderDown size={17} />
                Download the set
              </button>
            )}
            {onSaveLook && (
              <button
                className="secondary"
                onClick={onSaveLook}
                disabled={busy}
                title="Keep this prompt to reuse the same scene, pose and light on other photos"
              >
                <Bookmark size={17} />
                Save prompt as a look
              </button>
            )}
            <span className="revision-note">
              {editor
                ? `Each edit is one more paid picture${cost}. The picture it replaces stays under Versions.`
                : "Each revision is one more paid generation. Your original stays untouched."}
            </span>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
