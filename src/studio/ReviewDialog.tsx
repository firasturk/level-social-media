import { useEffect, useRef, useState, type ReactNode } from "react";
import { Aperture, Bookmark, ChevronLeft, ChevronRight, Download, FolderDown, RefreshCw, ScanLine, Type } from "lucide-react";
import "./text/text-studio.css";
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
import { toast } from "sonner";
import { askConfirm } from "@/lib/confirm";
import { postForm } from "@/api";
import { EditReference, REVISION_PRESETS } from "./editTools";
import { areaWords } from "@shared/photo-adjust";
import VoiceInput, { appendDictation } from "@/components/VoiceInput";
import { POST_TYPE_INFO, POST_TYPES, type Post } from "@shared/posts";
import { LANGUAGE_LABELS, languageWithSource, type ClientLanguage } from "@shared/language";
import { TYPO_LABELS } from "@shared/typography";

/** The four groups of the post editor, in the order the team works: the idea, its picture, the words, the earlier versions. */
const GROUPS = [
  { id: "idea", label: "Idea" },
  { id: "image", label: "Image" },
  { id: "words", label: "Words & design" },
  { id: "versions", label: "Versions" },
] as const;
export type Group = (typeof GROUPS)[number]["id"];

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
  /** The month, for the reference picture attached to the post for its edits and takes. */
  batchId?: string;
  /** The month changed on the server (a reference attached or taken off): read it again. */
  onMonthChanged?: () => Promise<void> | void;
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
  /** The OCR check of the picture and the artwork (a panel of its own), and the Drive reference picker. */
  ocrPanel?: ReactNode;
  drivePicker?: ReactNode;
  /** The Photo lab (Freepik's real-photo tools on the picture or a Drive photo), a panel of its own. */
  photoLab?: ReactNode;
  /** Freepik stock assets (search, licence, use as the post's reference), a panel of its own. */
  freepik?: ReactNode;
  /** The client's feedback on this post, read into reviewable changes. */
  feedbackPanel?: ReactNode;
  onAnimate?: () => void;
  onVideo?: () => void;
  /** The month's earlier versions (the MonthVersions panel). */
  versions?: ReactNode;
  /** This post's video versions, with the one the client reviews (the VideoVersions panel). */
  videoVersions?: ReactNode;
  /** This post's takes, newest first, from the server. */
  takes?: Take[];
  /** The art director looks at the post as it will be published (words drawn on): its finding, and the moves it proposes. */
  onCheckWords?: (propose: boolean) => Promise<{ note: string; ok: boolean; proposal: { ov?: Post["ov"]; changes: string[] } | null; applied?: string[] }>;
  /** Writes the caption from the picture (a text call) and returns it. */
  onWriteCaption?: () => Promise<string | null>;
  /** An earlier take back on the post (the current picture stays listed). */
  onUseTake?: (key: string) => Promise<void>;
  /** Who accepted it, when someone did. */
  acceptedBy?: string;
  lineage: "current" | "older" | "unknown" | "none";
  /** The brand kit's content language and the month's override, so the post's own override can say what it replaces. */
  brandLanguage?: ClientLanguage;
  monthLanguage?: ClientLanguage;
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
  onTextStudio,
  onPhotoStudio,
}: {
  /** Present for a post of a month: the dialog becomes the four-group editor. */
  editor?: PostEditorTools;
  /** Opens the Text studio on this post's words and layers (no picture is made); absent when the image is not a post. */
  onTextStudio?: () => void;
  /** Opens the Photo studio (the full-screen picture workspace) on this post, on its Edit or Versions panel. */
  onPhotoStudio?: (panel: "edit" | "versions") => void;
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
  /** The words check: running, its finding, and the moves it proposes until applied or left. */
  const [checking, setChecking] = useState(false);
  const [checkResult, setCheckResult] = useState<{ note: string; ok: boolean; proposal: { ov?: Post["ov"]; changes: string[] } | null; applied?: string[] } | null>(null);
  const [writingCaption, setWritingCaption] = useState(false);
  const [autoApply, setAutoApply] = useState<boolean>(() => {
    try {
      return localStorage.getItem("lsm-words-auto") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => setCheckResult(null), [editor?.post.index, task?.output]);
  /** An area marked on the picture to guide the edit (fractions of the picture). The engine redraws the whole picture: this is guidance in words, not a hard mask. */
  const [marking, setMarking] = useState(false);
  const [area, setArea] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const drag = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    setArea(null);
    setMarking(false);
  }, [task?.id, task?.output]);
  async function checkWords() {
    if (!editor?.onCheckWords) return;
    setChecking(true);
    try {
      setCheckResult(await editor.onCheckWords(!autoApply));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setChecking(false);
    }
  }
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
  /** The language this post inherits (the month's, else the brand kit's) when it sets none of its own. */
  const inherited = languageWithSource(editor?.brandLanguage, editor?.monthLanguage);
  /**
   * "Make another version" is a fresh picture from the saved idea (not an edit of this one): the
   * scope, the source and the cost are said before anything is made.
   */
  const remake = async () => {
    if (!onRemake) return;
    if (editor) {
      const slide = editor.post.group ? ` (slide ${editor.post.group.slide} of ${editor.post.group.of})` : "";
      const ok = await askConfirm(`Make another version of post ${editor.post.index}${slide}? A fresh picture is made from the saved idea and shot, not from the current picture. One paid picture${cost}. Only this post changes; the current picture stays under Versions.`, { ok: `Make another version${cost}`, danger: false, cancel: "Not now" });
      if (!ok) return;
    }
    leave(onRemake);
  };
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
            {editor.drivePicker && (
              <details className="editor-drive">
                <summary>Reference from the client's Drive</summary>
                {editor.drivePicker}
              </details>
            )}
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
              <textarea rows={3} dir="auto" value={field("brief") ?? ""} onChange={(e) => set("brief", e.target.value)} disabled={busy} />
            </label>
            <div className="revision-voice">
              <VoiceInput label="Dictate the idea" onText={(t) => set("brief", appendDictation(field("brief") ?? "", t))} disabled={busy} />
            </div>
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
                  onClick={() => void remake()}
                  title="A fresh picture of the saved idea (asked first, with the cost); the picture it replaces stays under Versions"
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
              <textarea rows={3} dir="auto" value={field("caption") ?? ""} onChange={(e) => set("caption", e.target.value)} disabled={busy} />
            </label>
            <div className="revision-voice">
              <VoiceInput label="Dictate the caption" onText={(t) => set("caption", appendDictation(field("caption") ?? "", t))} disabled={busy} />
              {editor.onWriteCaption && (
                <button
                  type="button"
                  className="cta secondary small"
                  disabled={busy || writingCaption}
                  title="Write the caption from the picture (a text call, billed by the connected text provider)"
                  onClick={async () => {
                    setWritingCaption(true);
                    try {
                      const c = await editor.onWriteCaption!();
                      if (c) set("caption", c);
                    } catch (e) {
                      toast.error((e as Error).message);
                    } finally {
                      setWritingCaption(false);
                    }
                  }}
                >
                  {writingCaption ? "Writing…" : "Write the caption from the picture"}
                </button>
              )}
            </div>
            <label className="field-label">
              Hashtags
              <input value={field("hashtags") ?? ""} onChange={(e) => set("hashtags", e.target.value)} disabled={busy} />
            </label>
            <label className="field-label">
              Language for this post
              <select value={field("language") ?? ""} onChange={(e) => set("language", (e.target.value || undefined) as Post["language"])} disabled={busy}>
                <option value="">
                  Follow {inherited.source === "month" ? "the month" : "the brand kit"} ({LANGUAGE_LABELS[inherited.language]})
                </option>
                {(Object.keys(LANGUAGE_LABELS) as ClientLanguage[]).map((l) => (
                  <option key={l} value={l}>
                    {LANGUAGE_LABELS[l]}
                  </option>
                ))}
              </select>
            </label>
            <small className="revision-note">The language the caption writer, the Text studio's layouts and their default fonts use for this post. Nothing is translated: the words stay as you wrote them.</small>
            <div className="editor-flat">
              <b>Layers and the picture</b>
              <ul>
                <li>The headline, the second line, the logo, their position, size and layout are layers drawn over the saved picture. Changing them is free: no picture is made.</li>
                {field("ov")?.typo && (
                  <li>
                    The typography style on this post ("{TYPO_LABELS[field("ov")!.typo!.style]}") is drawn by the automatic layout, not a layer you can grab. The Text studio turns the words into layers and sets the typography aside; "Back to the automatic layout" in the studio brings it back.
                  </li>
                )}
                <li>Letters the engine drew inside the photo itself are part of the picture, not a layer: they cannot be moved or retyped here. "Edit this picture" with the "Remove text" preset takes them out (one paid picture).</li>
              </ul>
            </div>
            {editor.onCheckWords && task?.output && (
              <div className="editor-proposal-wrap">
                <div className="editor-actions">
                  <button type="button" className="secondary" disabled={busy || checking || dirty} onClick={() => void checkWords()} title="The art director looks at the post as it will be published: do the words cover the product, do they read? A text and vision call, or the demo fixture.">
                    {checking ? <Orb size={14} /> : null} Check the words
                  </button>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={autoApply}
                      onChange={(e) => {
                        setAutoApply(e.target.checked);
                        try {
                          localStorage.setItem("lsm-words-auto", e.target.checked ? "1" : "0");
                        } catch {
                          /* private mode */
                        }
                      }}
                    />
                    Apply its moves by itself
                  </label>
                </div>
                {editor.post.textCheck && !checkResult && <small className="editor-accepted">Last check: {editor.post.textCheck.note}</small>}
                {checkResult && (
                  <div className="editor-proposal">
                    <span>{checkResult.note}</span>
                    {checkResult.applied?.length ? <ul>{checkResult.applied.map((c, i) => <li key={i}>Applied: {c}</li>)}</ul> : null}
                    {checkResult.proposal && (
                      <>
                        <ul>
                          {checkResult.proposal.changes.map((c, i) => (
                            <li key={i}>{c}</li>
                          ))}
                        </ul>
                        <span className="editor-proposal-actions">
                          <button
                            type="button"
                            className="primary"
                            disabled={busy}
                            onClick={async () => {
                              await editor.onSavePost({ ov: checkResult.proposal!.ov });
                              setCheckResult({ ...checkResult, proposal: null, applied: checkResult.proposal!.changes });
                            }}
                          >
                            Apply the moves
                          </button>
                          <button type="button" className="secondary" onClick={() => setCheckResult({ ...checkResult, proposal: null })}>
                            Leave the words as they are
                          </button>
                        </span>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
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
        {editor && group === "idea" && editor.feedbackPanel && (
          <div className="editor-group editor-feedback" role="region" aria-label="Client feedback">
            <details>
              <summary>Client feedback on this post</summary>
              {editor.feedbackPanel}
            </details>
          </div>
        )}
        {editor && group === "versions" && (
          <div className="editor-group" role="tabpanel">
            {onPhotoStudio && task?.output && (
              <button type="button" className="editor-open-photo-studio" onClick={() => onPhotoStudio("versions")} title="Every take of this post large, compared on one canvas, with the picture tools around it">
                <Aperture size={15} /> Open in the Photo studio
              </button>
            )}
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
            {editor.videoVersions}
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
            {editor && onPhotoStudio && task?.output && (
              <button type="button" className="editor-open-photo-studio" onClick={() => onPhotoStudio("edit")} title="The full-screen picture workspace: the AI edit, free adjustments (crop, light, colour), the Photo lab, stock assets, every version and the writing check, with the picture large">
                <Aperture size={15} /> Open the Photo studio <small>· the picture large, every tool in its own panel</small>
              </button>
            )}
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
              {onTextStudio && (
                <button type="button" className="editor-text-studio" title="Text studio" aria-label="Text studio" onClick={onTextStudio}>
                  <Type size={14} /> Text studio
                </button>
              )}
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
              {task && marking && (
                <div
                  className="mark-area"
                  role="application"
                  aria-label="Drag to mark an area of the picture"
                  onPointerDown={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    drag.current = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
                    setArea({ x: drag.current.x, y: drag.current.y, w: 0, h: 0 });
                    e.currentTarget.setPointerCapture(e.pointerId);
                  }}
                  onPointerMove={(e) => {
                    if (!drag.current) return;
                    const r = e.currentTarget.getBoundingClientRect();
                    const x = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
                    const y = Math.max(0, Math.min(1, (e.clientY - r.top) / r.height));
                    setArea({ x: Math.min(x, drag.current.x), y: Math.min(y, drag.current.y), w: Math.abs(x - drag.current.x), h: Math.abs(y - drag.current.y) });
                  }}
                  onPointerUp={() => {
                    drag.current = null;
                  }}
                >
                  {area && area.w > 0.01 && <div className="mark-box" style={{ left: `${area.x * 100}%`, top: `${area.y * 100}%`, width: `${area.w * 100}%`, height: `${area.h * 100}%` }} />}
                  <span className="mark-hint">{area && area.w > 0.01 ? "Marked: it goes into the instruction in words. Not a mask; the whole picture is redrawn." : "Drag to mark the area to change. It guides the instruction; it is not a mask."}</span>
                </div>
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
                      <button type="button" className="secondary" disabled={busy || inFlight} onClick={() => void remake()} title="Make another version: a fresh picture of the same idea (asked first, with the cost); this one stays under Versions">
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
            {editor?.ocrPanel && task?.output && (
              <details className="editor-ocr">
                <summary>Writing check (OCR)</summary>
                {editor.ocrPanel}
              </details>
            )}
            {editor?.photoLab && (
              <details className="editor-photolab">
                <summary>Photo lab (Freepik)</summary>
                {editor.photoLab}
              </details>
            )}
            {editor?.freepik && (
              <details className="editor-freepik">
                <summary>Freepik assets</summary>
                {editor.freepik}
              </details>
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
            {editor && task?.output && (() => {
              const takes = editor.takes ?? [];
              const made = takes.filter((t) => t.status === "made");
              const cur = made.find((t) => t.current);
              const n = cur ? made.length - made.indexOf(cur) : made.length;
              return (
                <>
                  {made.length > 0 && (
                    <p className="take-line">
                      Take {n} of {made.length}
                      {cur?.cost ? ` · ${formatUsd(cur.cost)}` : ""}
                      {cur?.created ? ` · made ${new Date(cur.created).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}` : ""}
                      {cur?.note ? ` · ${cur.note}` : ""}
                    </p>
                  )}
                  <span className="field-label">What do you want to do?</span>
                  <div className="editor-choices">
                    <button type="button" className="editor-choice" onClick={() => editRef.current?.focus()} title="The current picture is changed as your note says; the rest is kept by instruction">
                      <b>Edit this picture</b>
                      <span>Change something in the current photo from a note: the background, an object, the light. Starts from this picture.</span>
                      <em>about {formatUsd(editor.perPicture)} · one picture</em>
                    </button>
                    {onRemake && (
                      <button type="button" className="editor-choice" disabled={busy || inFlight} onClick={() => void remake()} title="A fresh picture from the saved idea; you are asked first">
                        <b>Make another version</b>
                        <span>A fresh picture of the same idea, from the idea and shot rather than this picture. The current one is kept under Versions.</span>
                        <em>about {formatUsd(editor.perPicture)} · one picture</em>
                      </button>
                    )}
                    <button type="button" className="editor-choice" onClick={() => setGroup("words")} title="Nothing is generated: the words and layers are drawn over the saved picture">
                      <b>Edit words &amp; layout</b>
                      <span>Headline, second line, logo, position, size and layout. Drawn over the photo as layers; the photo is never remade.</span>
                      <em className="free">Free · no picture is made</em>
                    </button>
                  </div>
                </>
              );
            })()}
            <label className="field-label" htmlFor="revision">
              Edit this picture
            </label>
            {editor && task && (
              <div className="edit-scope">
                {task.output && <img className="edit-scope-thumb" src={resultUrl} alt="The picture this edit starts from" />}
                <p>
                  <b>Scope:</b> post {editor.post.index}
                  {editor.post.group ? `, ${editor.post.group.kind} slide ${editor.post.group.slide} of ${editor.post.group.of}` : ""} only. <b>Source:</b> the current picture
                  {task.updated ? ` (${new Date(task.updated).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })})` : ""}
                  {editor.lineage === "older" ? ", made for an earlier idea" : editor.lineage === "unknown" ? ", lineage unknown" : ""}
                  {editor.post.reference ? ", with the attached reference" : ""}. <b>What changes:</b> what the instruction says; the rest is kept by instruction. The picture it replaces stays under Versions; the words and layers are redrawn over the new picture.
                </p>
              </div>
            )}
            <div className="edit-actions-row">
              <button type="button" className={`text-button ${marking ? "on" : ""}`} disabled={busy || !task?.output} onClick={() => { setMarking((m) => !m); if (view === "compare") setView("result"); }} title="Drag a box on the picture: it is put into the instruction in words (where and how big). It guides the engine; it is not a mask, and the whole picture is redrawn.">
                {marking ? "Stop marking" : "Mark an area"}
              </button>
              {area && area.w > 0.01 && (
                <button type="button" className="text-button" onClick={() => setEdit((e) => (e.trim() ? `${e.trim()} ${areaWords(area)}` : areaWords(area)))}>
                  Use the marked area in the instruction
                </button>
              )}
              {area && area.w > 0.01 && (
                <button type="button" className="text-button" onClick={() => setArea(null)}>
                  Clear
                </button>
              )}
              <small className="revision-note">This engine redraws the whole picture from this one: a marked area guides the instruction, it is not a hard mask. The product is kept by instruction, not pixel-locked; for a pixel-exact product use Exact product.</small>
            </div>
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
              <VoiceInput label="Dictate the change" onText={(t) => setEdit((e) => appendDictation(e, t))} disabled={busy} />
            </div>
            {editor?.batchId && <EditReference batchId={editor.batchId} post={editor.post} note={edit} disabled={busy || inFlight} onChanged={() => editor.onMonthChanged?.()} />}
            <button
              className="primary"
              onClick={async () => {
                const text = edit.trim() || (editor?.post.reference ? "Use the attached reference for this picture." : "");
                if (!text) return;
                if (editor) {
                  const ok = await askConfirm(`Edit post ${editor.post.index}'s picture${editor.post.group ? ` (slide ${editor.post.group.slide} of ${editor.post.group.of})` : ""}: one paid picture${cost}. Only this post changes; the current picture stays under Versions.`, { ok: `Edit this picture${cost}`, danger: false, cancel: "Not now" });
                  if (!ok) return;
                  // The instruction is also the note on the attached reference, so the engine does with it exactly what was asked.
                  if (editor.batchId && editor.post.reference && edit.trim()) {
                    const form = new FormData();
                    form.set("batch", editor.batchId);
                    form.set("index", String(editor.post.index));
                    form.set("note", edit.trim());
                    await postForm("/api/studio/posts/reference", form).catch(() => undefined);
                  }
                }
                await onRevise(text);
                setEdit("");
                setArea(null);
              }}
              disabled={busy || inFlight || !(edit.trim() || editor?.post.reference)}
              title="The current picture is changed as the instruction says: one paid picture"
            >
              {busy ? <Orb size={17} /> : <RefreshCw size={17} />}
              {inFlight ? "Edit in progress…" : `Edit this picture${cost}`}
            </button>
            {onRemake && editor && (
              <button type="button" className="secondary" disabled={busy || inFlight} onClick={() => void remake()} title="A fresh picture of the same idea, asked first with the cost; this one stays under Versions">
                Make another version{cost}
              </button>
            )}
            {editor && (
              <button type="button" className="secondary" disabled={busy} onClick={() => setGroup("words")} title="Headline, second line, logo, position, size and layout: layers over the saved picture, saved free; no picture is made">
                Edit words &amp; layout · free
              </button>
            )}
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
