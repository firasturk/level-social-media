import { Suspense, useEffect, useRef, useState } from "react";
import { lazyScreen } from "@/lib/lazy";
const VideoEditor = lazyScreen(() => import("@/video-editor/ui/VideoEditor"));
import type { StudioPanel } from "@/video-editor/ui/studio/types";
import TypographyControls from "./TypographyControls";
import type { TypographyProps } from "./TypographyControls";
import { toast } from "sonner";
import { ENHANCE_NOTE, fixNote } from "@shared/qa";
import { post, postForm } from "@/api";
import { PostChangeBox, PostReferenceBox } from "./PostTools";
import PostCardCompact, { type EditorGroup } from "./PostCardCompact";
import { applyStyleToPosts, designFromLegacy, type ApplyRole } from "./text/model";
import type { Layer, TextDesign } from "@shared/layers";
import "./text/text-studio.css";
import {
  Clapperboard,
  Download,
  Film,
  AlertTriangle,
  CalendarDays,
  Check,
  Package,
  Palette,
  RotateCcw,
  Users,
  Images,
  Eye,
  FileText,
  Grid3x3,
  ImagePlus,
  Lightbulb,
  PenLine,
  RefreshCw,
  Sparkles,
  Trash2,
  Type,
  Wand2,
  X, TriangleAlert, Plus } from "lucide-react";
import { Orb } from "@/components/Orb";
import TextStudio, { type EditorResult } from "./text/TextStudio";
import AnimateDialog from "./AnimateDialog";
import VideoDialog from "./VideoDialog";
import PublishDialog, { PublishPill } from "./PublishDialog";
import { usePublications } from "./publish";
import { publicationFor } from "@shared/publish";
import type { Ambassador, Client, QA, Source, Task } from "@shared/types";
import type { PostFlag } from "@shared/qa";
import StyleScreen, { styleThumb, useStyleInfo } from "./StyleGallery";
import type { OverlaySpec } from "@shared/overlay";
import type { Approval } from "@shared/config";
import { occasionsOf, pickedOccasions, type MonthOccasions } from "@shared/occasions";
import OverlayPreview from "./OverlayPreview";
import { facesOf, renderOverlay } from "@/lib/overlay";
import VideoOnCard from "./VideoOnCard";
import { inFlight, videoSummary, type VideoSummary } from "./videoApi";
import {
  decodeEntities,
  MAX_POST_COUNT,
  offerReady,
  type PostOffer,
  POST_TYPE_INFO,
  POST_TYPES,
  monthLabel,
  type Post,
  type PostType,
  type Format, olderIdea, type RevisionConfig } from "@shared/posts";
import { STATUS_LABEL } from "./constants";
import type { SaveStatus as SaveState } from "@shared/save-status";
import SaveStatus from "./SaveStatus";
import { confirmScope, scopeLabel, scopeNote } from "@shared/scope";
import { formatUsd } from "@shared/pricing";
import { askConfirm } from "@/lib/confirm";
import { isMediaPost } from "@shared/posts";
import type { StyleItem } from "@shared/styles";
import { CombineDialog, restyleInstruction, SelectionBar } from "./MediaSelection";
import { takeNewCards } from "./mediaApi";
import "./media-intake.css";
import CardSession from "./CardSession";
import { getSession, registerMonth, useSessionNotices, type WordsResult } from "./editing-session";
import { clientHold } from "@shared/client-hold";

/** The month of a client: its products, the plan of posts and their images. */
export default function PlanView({
  client,
  month,
  onMonth,
  grids,
  gridId,
  onGrid,
  onNewGrid,
  plan,
  postCount,
  format,
  tasks,
  sources,
  running,
  busy,
  exporting,
  sourceUrl,
  outputUrl,
  overlay,
  logoSrc,
  showOverlay,
  onShowOverlay,
  themeRefs,
  gridRef,
  revision,
  requested,
  onGridIdeas,
  fileBase,
  onUploadProducts,
  onGenerateIdeas,
  onNewIdea,
  onPostCount,
  cast,
  onSavePlan,
  palette,
  onClientsChanged,
  onGeneratePosts,
  onOpen,
  onExport,
  onExportPdf,
  typography,
  onFix,
  onRestorePicture,
  onAccept,
  compact = false,
  toolbar = true,
  onEdit,
  onPhotoStudio,
  onDeletePlan,
  saveStatus,
  onRetrySave,
  perPicture = 0,
  paused,
  onResume,
  themeChanged,
  approvals = {},
  onRewrite,
  onStyles,
  monthOccasions,
  onRefit,
  rewriting = [],
  notes = "",
  batchId = null,
  onRefresh,
  outputThumb,
  wordsRequest,
  monthLanguage,
  admin = false,
  shared = false,
}: {
  /** The viewer is an admin (combining cards into one video is the Video editor's admins-only step). */
  admin?: boolean;
  /** The month's client review link is out: what it shows is the client's version of each post. */
  shared?: boolean;
  /** Another screen (the review dialog) asks for the Text studio on a post: a new token opens it. */
  wordsRequest?: { index: number; at: number } | null;
  /** The month's content language when it overrides the brand kit's (config.language); the Text studio follows it. */
  monthLanguage?: "ar" | "en" | "both";
  /** The picture at card size (a smaller copy the server keeps); the full picture opens in the dialogs. */
  outputThumb?: (t: Task) => string;
  /** The month's notes for the ideas writer (kept in the side panel). */
  notes?: string;
  /** The month's batch id (the video dialog talks to its routes). */
  batchId?: string | null;
  /** The month read again after a card changed it on the server (a reference attached). */
  onRefresh?: () => Promise<void>;
  client: Client;
  month: string;
  onMonth: (m: string) => void;
  /** The grids of this client's month (several when the team started a fresh one). */
  grids?: { id: string; name: string }[];
  gridId?: string | null;
  onGrid?: (id: string) => void;
  onNewGrid?: () => Promise<void>;
  plan: Post[];
  postCount: number;
  format: Format;
  tasks: Task[];
  sources: Source[];
  running: boolean;
  /** An action is in flight (ideas, upload, generate). */
  busy: string;
  exporting: boolean;
  sourceUrl: (id: string) => string;
  outputUrl: (t: Task) => string;
  /** The client's overlay spec and logo, drawn over generated posts in the preview and the export. */
  overlay: OverlaySpec;
  logoSrc: string | null;
  showOverlay: boolean;
  onShowOverlay: (on: boolean) => void;
  /** The theme's reference photos, offered as "reference grids" to plan the month from. */
  themeRefs: { id: string; name: string | null }[];
  /** The reference the month follows in grid mode, when any. */
  gridRef: string | null;
  /** The month's revision stamps (plannedAt, gridAt): a picture made for an earlier revision is due again. */
  revision: RevisionConfig | null;
  /** The post editor asks for one of this view's own screens (the Text studio, Animate, Video) on a post. */
  requested?: { kind: "text" | "animate" | "video" | "edit-video" | "video-studio"; index: number; at: number; videoId?: string } | null;
  onGridIdeas: (refId: string, notes: string) => void;
  /** Base of exported file names (client slug + month). */
  fileBase: string;
  /** The theme (reference, colours, props, shots) was edited after the ideas were written. */
  themeChanged: boolean;
  /** The client's answers on the approval link, by post index. */
  approvals?: Record<string, Approval>;
  /** Saves the plan, then writes this post's idea again for its (new) type; no image is made. */
  onRewrite: (index: number, plan: Post[]) => void;
  /** The card's product or people changed: the post's words and idea are written again for what is on the card. */
  onRefit?: (indexes: number[]) => Promise<void>;
  /** The posts whose words are being written again now. */
  rewriting?: number[];
  /** Gallery styles for posts, each written for its post's product (null takes it off). */
  onStyles: (assign: { index: number; style: string | null }[]) => Promise<void>;
  /** The occasions the month posts (names, custom ones, uploaded portraits). */
  monthOccasions?: MonthOccasions;
  /** Why generation stopped (the engine's message), when the month is paused. */
  paused: string | null;
  onResume: () => void;
  onUploadProducts: (files: File[]) => void;
  onGenerateIdeas: (notes: string) => void;
  /** A fresh idea for one post, then that post is generated again. */
  onNewIdea: (index: number) => void;
  /** The month's brand ambassadors, which a post can show. */
  cast: Ambassador[];
  /** The number of posts the month gets, whatever the number of products uploaded. */
  onPostCount: (n: number) => void;
  onSavePlan: (plan: Post[]) => void | Promise<void>;
  /** The month's colours, offered in the Text studio after the brand's. */
  palette?: { name: string; hex: string }[];
  onClientsChanged?: (clients: Client[]) => void;
  onGeneratePosts: (indexes?: number[], regenerate?: boolean) => void;
  onOpen: (t: Task) => void;
  onExport: () => void;
  /** The month as one long PDF page: cover, Instagram-style feed, a note per post, thank-you. */
  onExportPdf: () => void;
  /** The month's typography: its style menu and its on/off switch. */
  typography?: TypographyProps;
  /** Changes one post's picture as the review's note asks. */
  onFix?: (index: number, edit: string) => Promise<void>;
  /** Puts an earlier picture back on a post (after a Regenerate). */
  onRestorePicture?: (index: number, key: string) => Promise<void>;
  /** The simplified card (the four-stage workflow): Edit opens the post editor on a group. */
  compact?: boolean;
  /** False folds the month toolbar away (the Studio board's More menu opens it). */
  toolbar?: boolean;
  onEdit?: (index: number, group?: EditorGroup) => void;
  /** The Photo studio (the full-screen picture workspace) on a post with a picture; the card's "Edit picture" opens it. */
  onPhotoStudio?: (index: number, panel?: "edit" | "versions") => void;
  /** The team accepts a flagged post as it is. */
  onAccept?: (index: number) => Promise<void>;
  onDeletePlan: () => void;
  /** The plan's autosave, shown above the cards, with a retry when it failed. */
  saveStatus?: SaveState;
  onRetrySave?: () => void;
  /** The list price of one picture, for the card's make button (0 when not known). */
  perPicture?: number;
}) {
  const products = sources.filter((s) => (s.kind ?? "product") === "product");
  const occasions = occasionsOf(month);
  const occasionOn = (date?: string) => occasions.filter((o) => o.date === date).map((o) => o.name).join(", ");
  const fileInput = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<Post[]>(plan);
  const [dragging, setDragging] = useState(false);
  const [gridPicker, setGridPicker] = useState(false);
  const [editing, setEditing] = useState<number | null>(null);
  useEffect(() => {
    if (!requested) return;
    if (requested.kind === "text") setEditing(requested.index);
    else if (requested.kind === "animate") setAnimating(requested.index);
    else if (requested.kind === "edit-video") setVideoEditing({ index: requested.index, videoId: requested.videoId ?? null, panel: "edit" });
    else if (requested.kind === "video-studio") openVideoEditor(requested.index);
    else setVideoFor(requested.index);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requested?.at]);
  useEffect(() => {
    if (wordsRequest) setEditing(wordsRequest.index);
  }, [wordsRequest]);
  const [animating, setAnimating] = useState<number | null>(null);
  const [videoFor, setVideoFor] = useState<number | null>(null);
  /**
   * The Video studio, open on a post, the version it starts from (null: the client's version, else the
   * newest finished clip) and the panel (none: Generate when the post has a clip, Presets when it has none).
   */
  const [videoEditing, setVideoEditing] = useState<{ index: number; videoId: string | null; panel?: StudioPanel } | null>(null);
  const openVideoEditor = (index: number, videoId?: string | null, panel?: StudioPanel) => {
    const s = videos[String(index)];
    setVideoFor(null);
    // The clip the card's editing session last showed, else the client's version, else the newest finished clip.
    setVideoEditing({ index, videoId: videoId ?? getSession(batchId, index)?.videoId ?? s?.client?.id ?? s?.done?.id ?? null, panel: panel ?? (videoId ? "edit" : undefined) });
  };
  /**
   * The editing sessions of the month's cards (what the studios carry between them): the cards
   * re-render when one changes; the month lends the sessions its words saver and its refresh.
   */
  useSessionNotices(batchId);
  const holdOf = (index: number) => clientHold({ approvals, shareToken: shared ? "shared" : undefined }, index);
  /** The picture the studios work on for a post: a version picked under Versions, else the card's. */
  const pictureOf = (index: number, t: Task) => getSession(batchId, index)?.picture?.url ?? outputUrl(t);
  const sessionHooks = useRef<{ saveWords: (index: number, r: WordsResult) => Promise<void>; refresh: () => Promise<void> } | null>(null);
  sessionHooks.current = {
    saveWords: async (index, r) => {
      const next = draftRef.current.map((x) => (x.index === index ? { ...x, headline: r.headline || undefined, subline: r.subline || undefined, ov: r.ov } : x));
      draftRef.current = next;
      setDraft(next);
      await onSavePlan(next);
    },
    refresh: async () => {
      await onRefresh?.();
      await loadVideos();
    },
  };
  useEffect(() => {
    if (!batchId) return;
    return registerMonth(batchId, { saveWords: (i, r) => sessionHooks.current!.saveWords(i, r), refresh: () => sessionHooks.current!.refresh() });
  }, [batchId]);
  // Publishing to Instagram: which post's dialog is open, and the month's publications for the pills.
  const [publishFor, setPublishFor] = useState<number | null>(null);
  const { list: publications, refresh: refreshPublications } = usePublications(batchId);
  // The month's video versions, one line per post (the client's version, the newest clip): read with
  // the month, when the video dialog changes something, and every few seconds while a clip is being made.
  const [videos, setVideos] = useState<VideoSummary["posts"]>({});
  const loadVideos = () => (batchId ? videoSummary(batchId).then((r) => setVideos(r.posts)).catch(() => undefined) : Promise.resolve());
  useEffect(() => {
    setVideos({});
    void loadVideos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId]);
  // New cards (clips added from Start, a combined video) bring their versions: read them again.
  const postsCount = plan.length;
  const seenCount = useRef(postsCount);
  useEffect(() => {
    if (seenCount.current === postsCount) return;
    seenCount.current = postsCount;
    void loadVideos();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [postsCount]);
  const videosPending = Object.values(videos).some((v) => inFlight(v.latest));
  useEffect(() => {
    if (!videosPending) return;
    const t = setInterval(() => void loadVideos(), 8000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videosPending]);
  // The plan arrives as a new array on every refresh tick while images generate; the draft only
  // follows it when its content actually changed, so typing is never wiped mid-edit.
  const planKey = JSON.stringify(plan);
  // A saved plan coming back never wipes what is still being typed: a post the designer changed
  // since the last copy from the server keeps their edits; every other post follows the server.
  const serverPlan = useRef(plan);
  useEffect(() => {
    const prev = serverPlan.current;
    serverPlan.current = plan;
    setDraft((d) => {
      if (d.length !== prev.length || plan.length !== prev.length) return plan;
      return plan.map((sp, i) => {
        const mine = JSON.stringify(d[i]);
        return mine !== JSON.stringify(prev[i]) && mine !== JSON.stringify(sp) && d[i]?.index === sp.index ? d[i] : sp;
      });
    });
  }, [planKey]); // eslint-disable-line react-hooks/exhaustive-deps
  /** A style chosen in the gallery for a post, shown on the card until "Apply style" writes it for the product. */
  const [pendingStyle, setPendingStyle] = useState<Map<number, string>>(new Map());
  const [applying, setApplying] = useState<number | null>(null);
  const styles = useStyleInfo([...draft.map((x) => x.style), ...pendingStyle.values()]);
  const styleOf = (id: string) => styles.get(id);
  const [picking, setPicking] = useState<number | null>(null);
  const dirty = JSON.stringify(draft) !== planKey;
  const draftRef = useRef(draft);
  draftRef.current = draft;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const planRef = useRef(plan);
  planRef.current = plan;

  /* ── Choosing cards for one step: a style, the Text studio one by one, one video (docs/direct-to-studio.md) ── */
  const [selecting, setSelecting] = useState(false);
  const [chosen, setChosen] = useState<number[]>([]);
  const [chosenRoute, setChosenRoute] = useState<"images" | "video" | null>(null);
  const [styleFor, setStyleFor] = useState<number[] | null>(null);
  const [combineOpen, setCombineOpen] = useState(false);
  /** The chosen cards still waiting for the Text studio, after the one open now. */
  const [textQueue, setTextQueue] = useState<number[]>([]);
  // Cards just made from Start (Edit images, Create or edit video) arrive chosen, ready for the next step; nothing runs by itself.
  useEffect(() => {
    const fresh = takeNewCards(batchId);
    if (!fresh) return;
    setSelecting(true);
    setChosen(fresh.indexes);
    setChosenRoute(fresh.route);
  }, [batchId, plan.length]);
  const chosenNow = chosen.filter((i) => draft.some((x) => x.index === i));
  const toggleChosen = (i: number) => setChosen((c) => (c.includes(i) ? c.filter((x) => x !== i) : [...c, i]));
  const stopChoosing = () => {
    setSelecting(false);
    setChosen([]);
    setChosenRoute(null);
  };
  /** A gallery style saved on exactly the chosen cards, after one confirm that names them; no picture is made. */
  async function styleChosen(style: StyleItem, indexes: number[]) {
    const targets = indexes.map((i) => draftRef.current.find((x) => x.index === i)).filter((x): x is Post => !!x);
    if (!targets.length) return;
    const media = targets.filter(isMediaPost);
    const others = targets.filter((x) => !isMediaPost(x));
    const n = targets.length;
    const label = scopeLabel({ kind: "selection", indexes: targets.map((x) => x.index) });
    const rest = plan.length - n;
    const ok = await askConfirm(
      `Save the style “${style.title}” on ${label}? It is saved on each card now: no picture is made and nothing is paid.${media.length ? ` Restyling each picture is then its own step on its card (Restyle${perPicture ? `, about ${formatUsd(perPicture)} each` : ""}), confirmed one picture at a time.` : ""}${others.length ? ` ${others.length === 1 ? "One planned post gets" : `${others.length} planned posts get`} its idea and shot written in the style; making ${others.length === 1 ? "its picture" : "their pictures"} stays a separate step with its cost.` : ""}${rest > 0 ? ` The month's other ${rest} post${rest === 1 ? " stays" : "s stay"} as ${rest === 1 ? "it is" : "they are"}.` : ""}`,
      { ok: `Save on ${n} card${n === 1 ? "" : "s"}`, danger: false, cancel: "Not now" },
    );
    if (!ok) return;
    try {
      if (media.length) {
        const ids = new Set(media.map((x) => x.index));
        const next = draftRef.current.map((x) => (ids.has(x.index) ? { ...x, style: style.id } : x));
        draftRef.current = next;
        setDraft(next);
        await onSavePlan(next);
      }
      if (others.length) await onStyles(others.map((x) => ({ index: x.index, style: style.id })));
      toast.success(`Style “${style.title}” saved on ${label}. Nothing was made.`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  /** One media card's picture restyled in its saved style: the Photo studio's AI edit, one paid picture, confirmed here. */
  async function restyle(p: Post, t: Task) {
    const st = p.style ? styleOf(p.style) : undefined;
    if (!st || !batchId) return;
    const target = { kind: "post" as const, index: p.index, title: p.title };
    const scope = confirmScope({ target, effect: "edit-image", cost: perPicture || undefined, untouched: plan.length > 1 ? `the month's other ${plan.length - 1} post${plan.length === 2 ? "" : "s"}` : undefined });
    const ok = await askConfirm(`${scope.message} The picture takes the light, colours and mood of “${st.title}”; its subject stays.`, { ok: scope.ok, danger: false, cancel: "Not now" });
    if (!ok) return;
    try {
      await post("/api/studio/revise", { batch: batchId, id: t.id, edit: restyleInstruction(st) });
      const next = draftRef.current.map((x) => (x.index === p.index && x.media ? { ...x, media: { ...x.media, styled: st.id } } : x));
      draftRef.current = next;
      setDraft(next);
      await onSavePlan(next);
      await onRefresh?.();
      toast.success(`Post ${p.index} is being restyled. The picture before stays under Versions.`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  /** Edits save themselves when the designer clicks out of a field; a text edit can be undone from the toast. */
  function autosave() {
    if (!dirtyRef.current) return;
    const before = planRef.current;
    const next = draftRef.current;
    void saveDraft().then(() => refitPending());
    const texts: (keyof Post)[] = ["headline", "subline", "caption", "hashtags", "title", "brief"];
    const changed = next.filter((p) => {
      const was = before.find((x) => x.index === p.index);
      return was && texts.some((k) => (was[k] ?? "") !== (p[k] ?? ""));
    });
    if (changed.length)
      toast("Saved", {
        description: `Post ${changed.map((p) => p.index).join(", ")} text changed.`,
        action: { label: "Undo", onClick: () => { setDraft(before); onSavePlan(before); } },
        duration: 6000,
      });
  }
  /** Which cards show every field (the picture, the words and the status show always). */
  // Every detail is on the card, always: the designer edits without opening anything.
  const showDetails = () => true;
  const [fixing, setFixing] = useState<number | null>(null);
  const [restoring, setRestoring] = useState<number | null>(null);
  const prevKey = (t: Task) => `lsm-prev-output:${t.id}`;
  const prevOf = (t: Task | null): string | null => {
    if (!t?.output) return null;
    try {
      const k = localStorage.getItem(prevKey(t));
      return k && k !== t.output ? k : null;
    } catch {
      return null;
    }
  };
  /** Unsaved edits are saved first, so a Regenerate right after an edit uses the edit. */
  async function saveThen(run: () => void) {
    if (dirtyRef.current) await saveDraft();
    // A product changed and Regenerate was clicked at once: the words are written first, then the picture.
    await refitPending();
    run();
  }
  /** Regenerate keeps the picture it replaces one click away. */
  function regenerate(t: Task | null, index: number) {
    try {
      if (t?.output) localStorage.setItem(prevKey(t), t.output);
    } catch {
      /* private mode */
    }
    void saveThen(() => onGeneratePosts([index], true));
    toast("Regenerating", { description: `Post ${index}: the previous picture stays one click away on the card (Previous picture).`, duration: 6000 });
  }
  const [accepting, setAccepting] = useState<number | null>(null);
  /** The making state in words: a realism pass has its own. */
  const makingLabel = (t: Task | null) => {
    const edit = (t as { edit?: string | null } | null)?.edit ?? "";
    if (/photographed, not generated/.test(edit)) return "Making the people look real…";
    if (edit.startsWith("FRESH TAKE:")) return "Making it again without the problems…";
    return t?.status === "processing" ? "Generating…" : paused ? "Paused" : "Queued";
  };
  const taskOf = (index: number) => tasks.find((t) => t.post === index) ?? null;
  /** Who on the team accepted the picture as it is (from the review record), or "". */
  const acceptedBy = (t: Task | null): string => {
    try {
      const qa = t?.qa ? (JSON.parse(t.qa) as { acceptedBy?: string; notes?: string }) : null;
      return qa?.acceptedBy ?? (qa?.notes?.startsWith("Accepted by ") ? qa.notes.slice(12).replace(/\.$/, "") : "");
    } catch {
      return "";
    }
  };
  const generated = plan.filter((p) => !!taskOf(p.index)?.output).length;
  // A post is due when it has no image, failed, or was generated before the plan was rewritten
  // (new ideas or a new reference grid), so Generate stays available after a re-plan.
  const due = plan.filter((p) => {
    const t = taskOf(p.index);
    if (!t || t.status === "failed") return true;
    if (t.status === "processing" || t.status === "queued") return false;
    return olderIdea(t, p, revision);
  });
  const pending = due.length;
  const stale = due.some((p) => !!taskOf(p.index)?.output);

  /** The posts whose product or people changed on the card since the last save: their words are rewritten on save. */
  const refitDue = useRef<Set<number>>(new Set());
  function patch(index: number, p: Partial<Post>) {
    setDraft((d) =>
      d.map((x) => {
        if (x.index !== index) return x;
        const next = { ...x, ...p };
        const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
        const productChanged = ("product" in p && !same(x.product, p.product)) || ("products" in p && !same(x.products, p.products)) || ("people" in p && !same(x.people, p.people));
        const briefChanged = "brief" in p && !same(x.brief, p.brief);
        // A new product, a new cast or a new idea: the old shot no longer describes the post.
        if (productChanged || briefChanged) {
          next.scene = undefined;
          next.handShot = undefined;
        }
        if (productChanged) refitDue.current.add(index);
        return next;
      }),
    );
  }
  /** Saves the draft; the posts sent then take the server's copy, so a field the server adds never keeps a card "unsaved". */
  async function saveDraft(): Promise<void> {
    const sent = draftRef.current;
    await onSavePlan(sent);
    const saved = planRef.current;
    setDraft((d) => d.map((x, i) => (JSON.stringify(x) === JSON.stringify(sent[i]) && saved[i]?.index === x.index ? saved[i] : x)));
  }
  /** Saves the draft, then writes the words again for the cards whose product or people changed. */
  async function refitPending() {
    const due = [...refitDue.current];
    refitDue.current.clear();
    if (due.length && onRefit) await onRefit(due);
  }
  /** The post leaves the month on the server, which moves the later posts' pictures up with them. */
  async function removePost(index: number) {
    if (!batchId) return;
    try {
      await post("/api/studio/posts/remove", { batch: batchId, index });
      await onRefresh?.();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not remove the post.");
    }
  }
  function addPost() {
    const next: Post = {
      index: draft.length + 1,
      type: "lifestyle",
      title: `Post ${draft.length + 1}`,
      brief: "",
      caption: "",
      hashtags: "",
    };
    const all = [...draft, next];
    setDraft(all);
    onSavePlan(all);
  }

  const dropProps = {
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const files = Array.from(e.dataTransfer.files).filter(
        (f) => f.type.startsWith("image/") || /\.(heic|heif|avif|tiff?|bmp)$/i.test(f.name),
      );
      if (files.length) onUploadProducts(files);
    },
  };

  return (
    <section className={`plan ${dragging ? "dragging" : ""}`} {...dropProps}>
      {styleFor !== null && (
        <StyleScreen
          open
          onClose={() => setStyleFor(null)}
          forClient={{ id: client.id, name: client.name }}
          pick={{
            mode: "post",
            label: `${styleFor.length} chosen card${styleFor.length === 1 ? "" : "s"} (posts ${styleFor.map((i) => String(i).padStart(2, "0")).join(", ")})`,
            onPick: (_ids: string[], items: StyleItem[]) => {
              const targets = styleFor;
              setStyleFor(null);
              if (items[0]) void styleChosen(items[0], targets);
            },
          }}
        />
      )}
      {combineOpen && batchId && (
        <CombineDialog
          open
          batchId={batchId}
          cards={chosenNow.map((i) => {
            const x = draft.find((d) => d.index === i)!;
            const t = taskOf(i);
            const s = videos[String(i)];
            return { index: i, title: x.title, thumb: t?.output ? (outputThumb ?? outputUrl)(t) : null, picture: t?.output ? outputUrl(t) : null, hasClip: !!(s?.client || s?.done) };
          })}
          onClose={() => setCombineOpen(false)}
          onCombined={async (a) => {
            setCombineOpen(false);
            stopChoosing();
            await onRefresh?.();
            await loadVideos();
            setVideoEditing({ index: a.target, videoId: null, panel: "edit" });
          }}
        />
      )}
      <StyleScreen
        open={picking !== null}
        onClose={() => setPicking(null)}
        forClient={{ id: client.id, name: client.name }}
        pick={{
          mode: "post",
          label: picking !== null ? `Post ${String(picking).padStart(2, "0")}` : undefined,
          tab: picking !== null && draft.find((x) => x.index === picking)?.people?.length ? "lifestyle" : undefined,
          onPick: (ids: string[]) => {
            if (picking === null || !ids[0]) return;
            const [index, id] = [picking, ids[0]];
            setPendingStyle((m) => new Map(m).set(index, id));
            setPicking(null);
          },
        }}
      />
      <input
        id="plan-upload-products"
        ref={fileInput}
        type="file"
        accept="image/*,.heic,.heif,.avif,.tif,.tiff,.bmp"
        multiple
        hidden
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onUploadProducts(files);
          e.target.value = "";
        }}
      />

      <div className={`plan-toolbar ${toolbar ? "" : "folded"}`}>
        <div className="plan-month">
          <label htmlFor="month">Month</label>
          <input
            id="month"
            type="month"
            value={month}
            onChange={(e) => e.target.value && onMonth(e.target.value)}
          />
          {grids && grids.length > 1 && onGrid && (
            <>
              <label htmlFor="plan-grid">Grid</label>
              <select id="plan-grid" value={gridId ?? ""} onChange={(e) => e.target.value && onGrid(e.target.value)} title="This month holds several grids: pick the one to work on">
                {grids.map((g, i) => (
                  <option key={g.id} value={g.id}>
                    {g.name.replace(/^.*· \d{4}-\d{2}(?: · )?/, "") || `grid ${grids.length - i}`}
                  </option>
                ))}
              </select>
            </>
          )}
          {onNewGrid && (
            <button type="button" className="text-button" disabled={running} onClick={() => void onNewGrid()} title="Start another grid in this same month; the grids already made stay with their posts, pictures and client links">
              <Plus size={13} /> New grid
            </button>
          )}
          <label htmlFor="plan-post-count">Posts</label>
          <input
            id="plan-post-count"
            className="plan-post-count"
            type="number"
            min={1}
            max={MAX_POST_COUNT}
            value={postCount}
            disabled={running}
            title="How many posts this month gets. Generate ideas plans exactly this many, however many products are uploaded."
            onChange={(e) =>
              onPostCount(Math.max(1, Math.min(MAX_POST_COUNT, Number(e.target.value) || 1)))
            }
          />
          <span className="plan-count">
            {plan.length ? `${generated}/${plan.length} generated` : "planned"}
          </span>
        </div>
        <div className="plan-actions">
          <button
            className="secondary"
            onClick={() => fileInput.current?.click()}
            disabled={busy === "upload"}
          >
            {busy === "upload" ? <Orb size={15} /> : <ImagePlus size={15} />}
            Upload products
          </button>
          <button
            className="secondary"
            onClick={() => onGenerateIdeas(notes)}
            disabled={!!busy || running}
            title="The text model plans the month from the brand kit, the theme and the products"
          >
            {busy === "ideas" ? <Orb size={15} /> : <Lightbulb size={15} />}
            {plan.length ? "Regenerate ideas" : "Generate ideas"}
          </button>
          <button
            className={`secondary ${gridRef ? "toggle on" : ""}`}
            onClick={() => setGridPicker((v) => !v)}
            disabled={!!busy || running}
            title="Plan the month from one reference image that shows a whole feed grid"
          >
            {busy === "grid" ? <Orb size={15} /> : <Grid3x3 size={15} />}
            From reference grid
          </button>
          <button
            className="primary"
            onClick={() =>
              pending
                ? onGeneratePosts(
                    due.map((p) => p.index),
                    stale,
                  )
                : onGeneratePosts(undefined, true)
            }
            disabled={!!busy || running || !plan.length}
            title={
              !plan.length
                ? "Generate ideas first, then the posts"
                : pending
                  ? stale
                    ? "The plan changed since these posts were made: they are generated again"
                    : ""
                  : "Every post has an image; this makes all of them again"
            }
          >
            {running ? <Orb size={15} /> : <Wand2 size={15} />}
            {running
              ? "Generating…"
              : !plan.length
                ? "Generate posts"
                : pending
                  ? `${stale ? "Regenerate" : "Generate"} ${pending} posts`
                  : "Regenerate all"}
          </button>
          <button
            type="button"
            className={`secondary toggle ${showOverlay ? "on" : ""}`}
            onClick={() => onShowOverlay(!showOverlay)}
            title="Show the headline and logo drawn over the posts"
            aria-pressed={showOverlay}
          >
            <Type size={15} />
            Overlay
          </button>
          <button className="secondary" onClick={onExport} disabled={!generated || exporting}>
            {exporting ? <Orb size={15} /> : <Download size={15} />}
            Export
          </button>
          {typography && <TypographyControls {...typography} disabled={!generated} />}
          <button
            className="secondary"
            onClick={onExportPdf}
            disabled={!generated || exporting}
            title="One long PDF page: cover with the logo, the month as an Instagram feed, a note per post, thank-you"
          >
            <FileText size={15} />
            Feed PDF
          </button>
          <button
            className="icon-button"
            onClick={onDeletePlan}
            title="Delete this month"
            aria-label="Delete this month"
            disabled={running}
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      {themeChanged && plan.length > 0 && !running && (
        <div className="plan-alert" role="status">
          <AlertTriangle size={16} />
          <div>
            <strong>The theme changed after these ideas were written.</strong> The posts still follow the
            old reference, colours or props. Regenerate ideas so they follow the theme as it is now.
          </div>
          <button type="button" className="primary" onClick={() => onGenerateIdeas(notes)} disabled={!!busy}>
            Regenerate ideas
          </button>
        </div>
      )}
      {paused && (
        <div className="plan-alert" role="alert">
          <AlertTriangle size={16} />
          <div>
            <strong>Generation stopped.</strong> {paused}
          </div>
          <button type="button" className="primary" onClick={onResume} disabled={!!busy}>
            Resume
          </button>
        </div>
      )}

      {gridPicker && (
        <div className="grid-picker">
          <div className="grid-picker-head">
            <strong>Pick the reference grid</strong>
            <span>
              A theme reference that shows a whole feed (for example a Pinterest pin of 9 posts). The month is planned tile by tile in that world, with this client's products and colours.
            </span>
            <button type="button" className="icon-button" aria-label="Close" onClick={() => setGridPicker(false)}>
              <X size={14} />
            </button>
          </div>
          {themeRefs.length ? (
            <div className="grid-picker-refs">
              {themeRefs.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  className={`grid-ref ${gridRef === r.id ? "active" : ""}`}
                  onClick={() => {
                    setGridPicker(false);
                    onGridIdeas(r.id, notes);
                  }}
                  title={r.name ?? "reference"}
                >
                  <img src={`/api/studio/references/${r.id}/file`} alt={r.name ?? ""} loading="lazy" />
                </button>
              ))}
            </div>
          ) : (
            <div className="prompt-tip">Add a reference to the theme first (Theme → Pinterest or Add photos).</div>
          )}
        </div>
      )}
      {!plan.length ? (
        <div className="plan-empty">
          <img src="/guide/plan-empty.jpg" alt="" onError={(e) => (e.currentTarget.style.display = "none")} />
          <h3>{monthLabel(month)} for {client.name}</h3>
          <ol>
            <li>
              <strong>Upload products</strong>
              <span>The product photos the posts can use (optional for lifestyle, tip and quote posts).</span>
            </li>
            <li>
              <strong>Generate ideas</strong>
              <span>{postCount} post ideas in the client's tone: type, visual brief, caption and hashtags. Edit anything.</span>
            </li>
            <li>
              <strong>Generate posts</strong>
              <span>One image per idea in the client's palette and theme. Review, revise, export with captions.</span>
            </li>
          </ol>
        </div>
      ) : (
        <>
          <div className={`posts-head ${toolbar ? "" : "quiet"}`} id="month-posts">
            <strong>Posts</strong>
            {toolbar ? <span>Four posts a row. Edit any text; it saves when you click out. Pick a style, then Apply style; Generate makes the picture.</span> : <span>Edits save when you click out of a field.</span>}
            {saveStatus && <SaveStatus status={saveStatus} onRetry={onRetrySave} />}
            {dirty && (
              <span className="posts-save">
                <button className="primary" onClick={() => void saveDraft().then(() => refitPending())}>
                  Save changes
                </button>
                <button className="text-button" onClick={() => setDraft(plan)}>
                  Discard
                </button>
              </span>
            )}
            {compact && !selecting && (
              <button type="button" className="cta secondary small posts-choose" onClick={() => setSelecting(true)} title="Tick cards to apply a style to them, open them in the Text studio one by one, or combine them into one video">
                <Check size={14} /> Choose cards
              </button>
            )}
          </div>
          {compact && selecting && (
            <SelectionBar
              count={chosenNow.length}
              route={chosenRoute}
              admin={admin}
              textable={chosenNow.filter((i) => draft.find((x) => x.index === i)?.overlay !== false && !!taskOf(i)?.output).length}
              onStyle={() => setStyleFor(chosenNow)}
              onText={() => {
                const list = chosenNow.filter((i) => draft.find((x) => x.index === i)?.overlay !== false && !!taskOf(i)?.output);
                if (!list.length) return;
                setTextQueue(list.slice(1));
                setEditing(list[0]);
              }}
              onCombine={() => setCombineOpen(true)}
              onClear={() => setChosen([])}
              onDone={stopChoosing}
            />
          )}
          <div className={`post-grid f-${format.replace(":", "x")}`} onBlur={autosave}>
            {draft.map((p) => {
              const t = taskOf(p.index);
              const img = t?.output ? (outputThumb ?? outputUrl)(t) : null;
              const inFlight = !!t && (t.status === "queued" || t.status === "processing");
              const product = products.find(
                (s) => displayName(s.name).toLowerCase() === (p.product ?? "").toLowerCase(),
              );
              if (compact && onEdit) {
                const flags = t?.output && !inFlight ? (reviewFlags(t) ?? []) : [];
                const state = inFlight
                  ? { cls: "making", icon: <Orb variant="generate" size={12} />, text: makingLabel(t) }
                  : t?.status === "failed"
                    ? { cls: "failed", icon: <AlertTriangle size={12} />, text: "Failed" }
                    : t?.output
                      ? (() => {
                          const accepted = acceptedBy(t);
                          if (olderIdea(t, p, revision)) return { cls: "idea", icon: <Lightbulb size={12} />, text: "Older idea" };
                          // The team's own acceptance of the picture; the client's approval is a separate chip under the title.
                          if (accepted) return { cls: "ok", icon: <Check size={12} />, text: `Accepted by the team · ${accepted}` };
                          return { cls: "ok", icon: <Check size={12} />, text: STATUS_LABEL[t.status] ?? t.status };
                        })()
                      : { cls: "idea", icon: <Lightbulb size={12} />, text: "Idea" };
                const saved = plan.find((x) => x.index === p.index);
                const cardDirty = !!saved && JSON.stringify(saved) !== JSON.stringify(p);
                const stale = !!t?.output && !inFlight && olderIdea(t, p, revision);
                const target = p.group ? { kind: "slide" as const, index: p.index, slide: p.group.slide, of: p.group.of, title: p.title } : { kind: "post" as const, index: p.index, title: p.title };
                const cannotMake = inFlight || running || !p.brief.trim() || (p.type === "offer" && !offerReady(p.offer));
                /** A card made from the client's own file: never generated; its one paid step is restyling it in its saved style, confirmed. */
                const mediaCard = isMediaPost(p);
                const restyleDue = mediaCard && !!p.style && p.media?.styled !== p.style && !!t?.output && !inFlight;
                /** The card's primary action when the picture is not there yet, failed, or belongs to an older idea: make it, with its scope and cost said first. */
                const primary = mediaCard
                  ? restyleDue
                    ? {
                        label: `Restyle${perPicture ? ` · about ${formatUsd(perPicture)}` : ""}`,
                        title: `Edits this picture into the look of “${styleOf(p.style!)?.title ?? "its style"}”: one paid picture, asked first; the picture before stays under Versions. ${scopeNote(target, plan.length)}`,
                        disabled: running || !styleOf(p.style!),
                        onClick: () => void restyle(p, t!),
                      }
                    : undefined
                  : !t?.output || t.status === "failed" || stale
                  ? {
                      label: `${stale ? "Make it again" : t?.status === "failed" ? "Try again" : "Make the picture"}${perPicture ? ` · about ${formatUsd(perPicture)}` : ""}`,
                      title: `${stale ? "The idea, product or direction changed after this picture was made: another version is made for the new idea; this one stays under Versions." : t?.status === "failed" ? "Makes this post's picture again after the failure." : "Makes this post's first picture."} ${scopeNote(target, plan.length)}`,
                      disabled: cannotMake,
                      onClick: async () => {
                        const scope = confirmScope({ target, effect: stale ? "new-version" : "first-image", cost: perPicture || undefined, untouched: plan.length > 1 ? `the month's other ${plan.length - 1} post${plan.length === 2 ? "" : "s"}` : undefined });
                        const ok = await askConfirm(scope.message, { ok: scope.ok, danger: false, cancel: "Not now" });
                        if (!ok) return;
                        if (stale) regenerate(t, p.index);
                        else void saveThen(() => onGeneratePosts([p.index], t?.status === "failed"));
                      },
                    }
                  : undefined;
                const menu = mediaCard
                  ? [
                      p.style
                        ? { label: "Take the style off", onClick: () => void onSavePlan(draftRef.current.map((x) => (x.index === p.index ? { ...x, style: undefined } : x))), disabled: !!busy, title: "The picture stays as it is; only the saved style is taken off" }
                        : { label: "Pick a style", onClick: () => setStyleFor([p.index]), disabled: !!busy, title: "Saves a gallery style on this card; restyling the picture is a separate step you confirm, with its cost" },
                      ...(t?.output && !inFlight
                        ? [
                            { label: "Open the Text studio", onClick: () => setEditing(p.index), disabled: p.overlay === false, title: "The words and layers on this picture; no picture is made" },
                            { label: "Video from this picture", onClick: () => openVideoEditor(p.index), title: "The Video studio: this card's clip or picture, edits and versions; generating a clip stays a separate step with its cost" },
                            { label: "Publish to Instagram…", onClick: () => setPublishFor(p.index), disabled: !batchId, title: "Publishes this post's picture and caption to the connected Instagram account; nothing in the month changes" },
                          ]
                        : []),
                      ...(onRestorePicture && !inFlight && prevOf(t)
                        ? [{ label: "Previous picture", onClick: () => { const was = t!.output!; setRestoring(p.index); void onRestorePicture(p.index, prevOf(t)!).then(() => { try { localStorage.setItem(prevKey(t!), was); } catch { /* private mode */ } }).finally(() => setRestoring(null)); }, disabled: restoring !== null || running }]
                        : []),
                      { label: "Versions", onClick: () => onEdit(p.index, "versions") },
                      { label: "Remove this post", onClick: () => void removePost(p.index), disabled: inFlight, danger: true },
                    ]
                  : [
                  ...(t?.output && !primary
                    ? [{
                        label: "Make another version",
                        onClick: async () => {
                          const scope = confirmScope({ target, effect: "new-version", cost: perPicture || undefined, untouched: plan.length > 1 ? `the month's other ${plan.length - 1} post${plan.length === 2 ? "" : "s"}` : undefined });
                          const ok = await askConfirm(scope.message, { ok: scope.ok, danger: false, cancel: "Keep this picture" });
                          if (ok) regenerate(t, p.index);
                        },
                        disabled: inFlight || running || (p.type === "offer" && !offerReady(p.offer)),
                        title: `A clearly different take on the same idea; this picture stays under Versions. ${scopeNote(target, plan.length)}`,
                      }]
                    : []),
                  { label: "Write a new idea", onClick: () => onNewIdea(p.index), disabled: inFlight || running || busy === "reidea", title: "Changes the plan: a fresh idea for this post, then its picture is made again. Only this post changes." },
                  ...(p.type !== "greeting"
                    ? p.style
                      ? [
                          { label: "Change the style", onClick: () => setPicking(p.index), disabled: !!busy },
                          { label: "Take the style off", onClick: () => void onStyles([{ index: p.index, style: null }]), disabled: !!busy },
                        ]
                      : [{ label: "Pick a style", onClick: () => setPicking(p.index), disabled: !!busy }]
                    : []),
                  ...(t?.output && !inFlight && onFix
                    ? [
                        { label: "Enhance (higher quality)", onClick: () => { setFixing(p.index); void onFix(p.index, ENHANCE_NOTE).finally(() => setFixing(null)); }, disabled: fixing !== null || running || !!busy, title: `Edits this post's existing picture at a higher quality; the picture before stays under Versions. ${scopeNote(target, plan.length)}` },
                        { label: "Open the Text studio", onClick: () => setEditing(p.index), disabled: p.overlay === false, title: "The words and layers on this picture; no picture is made" },
                        { label: "Animate the text", onClick: () => setAnimating(p.index), disabled: !(p.headline || p.subline) || p.overlay === false, title: "A video of this post's words moving over its picture; the picture itself does not change" },
                        { label: "Video from this picture", onClick: () => openVideoEditor(p.index), title: "The Video studio: presets with their reference videos, a clip made from this post's picture, edits and versions; the picture stays as it is" },
                        { label: "Publish to Instagram…", onClick: () => setPublishFor(p.index), disabled: !batchId, title: "Publishes this post's picture and caption to the connected Instagram account; nothing in the month changes" },
                      ]
                    : []),
                  ...(onRestorePicture && !inFlight && prevOf(t)
                    ? [{ label: "Previous picture", onClick: () => { const was = t!.output!; setRestoring(p.index); void onRestorePicture(p.index, prevOf(t)!).then(() => { try { localStorage.setItem(prevKey(t!), was); } catch { /* private mode */ } }).finally(() => setRestoring(null)); }, disabled: restoring !== null || running }]
                    : []),
                  { label: "Reference picture and versions", onClick: () => onEdit(p.index, "versions") },
                  { label: "Remove this post", onClick: () => void removePost(p.index), disabled: inFlight, danger: true },
                ];
                const chosenAt = chosenNow.indexOf(p.index);
                return (
                  <article key={p.index} id={`post-card-${p.index}`} className={`post-card design-card studio-card compact ${t?.status ?? "idea"} ${p.style ? "styled" : ""} type-${p.type} ${t?.output && !inFlight ? (flags.length ? "qa-warn" : "qa-ok") : ""} ${chosenAt >= 0 ? "selected" : ""}`}>
                    <PostCardCompact
                      post={p}
                      task={t}
                      inFlight={inFlight}
                      state={state}
                      flags={flags}
                      approval={approvals[String(p.index)]}
                      styleTitle={p.style ? (styleOf(p.style)?.title ?? "Gallery style") : null}
                      dayTitle={occasionOn(p.date) || undefined}
                      onEdit={(g) => onEdit(p.index, g)}
                      onPhotoStudio={onPhotoStudio && t?.output ? () => onPhotoStudio(p.index, "edit") : undefined}
                      onTextStudio={p.overlay !== false ? () => setEditing(p.index) : undefined}
                      onEditVideo={t?.output ? () => openVideoEditor(p.index) : undefined}
                      onFixReview={onFix ? () => { setFixing(p.index); void onFix(p.index, fixNote(reviewFlags(t!)!)).finally(() => setFixing(null)); } : undefined}
                      onAccept={onAccept ? () => { setAccepting(p.index); void onAccept(p.index).finally(() => setAccepting(null)); } : undefined}
                      fixing={fixing === p.index}
                      accepting={accepting === p.index}
                      disabled={running || !!busy}
                      menu={menu}
                      primary={primary}
                      select={selecting ? { on: chosenAt >= 0, n: chosenAt + 1, onToggle: () => toggleChosen(p.index) } : undefined}
                      media={
                        <>
                          {img && showOverlay && p.overlay !== false ? (
                            <OverlayPreview src={img} spec={overlay} text={{ headline: p.headline, subline: p.subline }} logoSrc={logoSrc} patch={p.ov} faces={facesOf(t?.qa)} width={720} alt={p.title} />
                          ) : img ? (
                            <img src={img} alt={p.title} loading="lazy" />
                          ) : (
                            <img className="post-placeholder" src={`/guide/${p.type}.jpg`} alt="" onError={(e) => (e.currentTarget.style.visibility = "hidden")} />
                          )}
                          {inFlight && (
                            <span className="post-progress">
                              <Orb size={18} />
                              {makingLabel(t)}
                            </span>
                          )}
                          {t?.status === "failed" && <span className="post-failed">Failed · {t.error}</span>}
                          {img && !inFlight && videos[String(p.index)] && <VideoOnCard summary={videos[String(p.index)]} />}
                          {product && !img && <img className="post-product-chip" src={sourceUrl(product.id)} alt="" />}
                        </>
                      }
                      extra={
                        <>
                          {batchId && (
                            <CardSession
                              session={getSession(batchId, p.index)}
                              open={(kind) => (kind === "photo" && onPhotoStudio && t?.output ? onPhotoStudio(p.index, "edit") : kind === "text" ? setEditing(p.index) : openVideoEditor(p.index))}
                              onSent={() => sessionHooks.current?.refresh()}
                            />
                          )}
                          {rewriting.includes(p.index) && (
                            <small className="pc-meta">
                              <Orb variant="caption" size={14} status={null} /> Writing the words and the idea again…
                            </small>
                          )}
                          {p.product && !product && p.type !== "offer" && <small className="pc-meta warn">No photo of {p.product} this month: Generate brings it from the gallery, or pick another product in Edit.</small>}
                          {mediaCard && p.media && (
                            <small className="pc-meta pc-media-tag" title={p.media.name}>
                              {p.media.kind === "video" ? <Clapperboard size={12} /> : <Images size={12} />}
                              {p.media.from === "combine" ? "Combined video" : p.media.kind === "video" ? "Your clip" : "Your picture"} · {p.media.from === "drive" ? "from the client's Drive" : p.media.from === "upload" ? "uploaded" : "from chosen cards"}
                              {p.style && p.media.styled === p.style ? " · restyled" : ""}
                            </small>
                          )}
                          {p.seenBefore && <small className="pc-meta">Seen before · {p.seenBefore}</small>}
                          <PublishPill publication={publicationFor(publications, plan, p.index)} />
                          {approvals[String(p.index)]?.status === "changes" && approvals[String(p.index)].note && (
                            <small className="pc-meta" dir="auto">
                              “{approvals[String(p.index)].note}”{approvals[String(p.index)].by ? ` · ${approvals[String(p.index)].by}` : ""}
                            </small>
                          )}
                          {cardDirty && (
                            <span className="pc-unsaved">
                              Unsaved changes ·{" "}
                              <button type="button" className="text-button" onClick={() => void saveDraft().then(() => refitPending())}>
                                Save
                              </button>{" "}
                              <button type="button" className="text-button" onClick={() => setDraft((d) => d.map((x) => (x.index === p.index ? saved! : x)))}>
                                Discard
                              </button>
                            </span>
                          )}
                          {!!t && !inFlight && olderIdea(t, p, revision) && !!onFix && (
                            <span className="pc-unsaved">
                              The idea changed after this picture ·{" "}
                              <button type="button" className="text-button" disabled={fixing !== null || running} onClick={() => { setFixing(p.index); void onFix(p.index, `Update the picture to match the idea as it is written now, keeping everything that still fits: ${(p.scene?.trim() || p.brief).slice(0, 700)}`).finally(() => setFixing(null)); }}>
                                Update the picture
                              </button>
                            </span>
                          )}
                        </>
                      }
                    />
                  </article>
                );
              }
              return (
                <article
                  key={p.index}
                  id={`post-card-${p.index}`}
                  className={`post-card design-card studio-card ${t?.status ?? "idea"} ${p.style ? "styled" : ""} type-${p.type} ${(() => {
                    // The review's verdict is the card's outline: red when something is to check, green when it passed.
                    const flags = t?.output && !inFlight ? reviewFlags(t) : null;
                    return flags ? (flags.length ? "qa-warn" : "qa-ok") : "";
                  })()}`}
                >
                  {p.type !== "greeting" && (
                    <div className={`post-style-row ${p.style ? "on" : ""} ${pendingStyle.has(p.index) ? "pending" : ""}`}>
                      <Palette size={14} />
                      {pendingStyle.has(p.index) ? (
                        <>
                          {styleOf(pendingStyle.get(p.index)!) && <img src={styleThumb(styleOf(pendingStyle.get(p.index)!)!)} alt="" />}
                          <span className="post-style-text">
                            <strong>{styleOf(pendingStyle.get(p.index)!)?.title ?? "Style chosen"}</strong>
                            <small>Not applied yet · applying writes the idea and shot, then asks before making the picture</small>
                          </span>
                          <button
                            type="button"
                            className="primary post-style-apply"
                            disabled={!!busy || applying === p.index}
                            onClick={() => {
                              const id = pendingStyle.get(p.index)!;
                              setApplying(p.index);
                              void onStyles([{ index: p.index, style: id }]).finally(() => {
                                setApplying(null);
                                setPendingStyle((m) => {
                                  const n = new Map(m);
                                  n.delete(p.index);
                                  return n;
                                });
                              });
                            }}
                          >
                            {applying === p.index ? <Orb size={13} /> : <Check size={13} />} Apply style
                          </button>
                          <button
                            type="button"
                            className="icon-button"
                            aria-label="Cancel"
                            title="Keep the post as it is"
                            onClick={() =>
                              setPendingStyle((m) => {
                                const n = new Map(m);
                                n.delete(p.index);
                                return n;
                              })
                            }
                          >
                            <X size={12} />
                          </button>
                        </>
                      ) : p.style ? (
                        <>
                          {styleOf(p.style) && <img src={styleThumb(styleOf(p.style)!)} alt="" />}
                          <span className="post-style-text">
                            <strong>{styleOf(p.style)?.title ?? "Gallery style"}</strong>
                            <small>Style applied · the post follows it</small>
                          </span>
                          <button type="button" className="text-button" onClick={() => setPicking(p.index)} disabled={!!busy}>
                            Change
                          </button>
                          <button type="button" className="icon-button" onClick={() => void onStyles([{ index: p.index, style: null }])} aria-label="Take the style off" title="Take the style off">
                            <X size={12} />
                          </button>
                        </>
                      ) : (
                        <>
                          <span className="post-style-text">
                            <strong>No style</strong>
                            <small>The post follows the month's theme</small>
                          </span>
                          <button type="button" className="secondary post-style-pick" onClick={() => setPicking(p.index)} disabled={!!busy}>
                            <Images size={13} /> Pick a style
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  {rewriting.includes(p.index) && (
                    <div className="post-rewriting">
                      <Orb variant="caption" size={22} status={null} /> Writing the words and the idea again for what is on the card…
                    </div>
                  )}
                  <div className="post-media" onClick={() => t?.output && onOpen(t)}>
                    {(() => {
                      const flags = t?.output && !inFlight ? reviewFlags(t) : null;
                      const state = inFlight
                        ? { cls: "making", icon: <Orb variant="generate" size={12} />, text: makingLabel(t) }
                        : t?.status === "failed"
                          ? { cls: "failed", icon: <AlertTriangle size={12} />, text: "Failed" }
                          : flags?.length
                            ? null
                            : t?.output
                              ? (() => {
                                  // An internal acceptance (the team) is named apart from the client's approval; an
                                  // older idea's picture says so; a picture made before lineage was kept says nothing.
                                  const accepted = acceptedBy(t);
                                  if (olderIdea(t, p, revision)) return { cls: "idea", icon: <Lightbulb size={12} />, text: "Older idea" };
                                  if (accepted) return { cls: "ok", icon: <Check size={12} />, text: `Accepted by ${accepted}` };
                                  return { cls: "ok", icon: <Check size={12} />, text: STATUS_LABEL[t.status] ?? t.status };
                                })()
                              : { cls: "idea", icon: <Lightbulb size={12} />, text: "Idea" };
                      return (
                        <header className="post-head">
                          <span className="post-num">{String(p.index).padStart(2, "0")}</span>
                          <span className="post-type-pill">{POST_TYPE_INFO[p.type]?.label ?? p.type}</span>
                          {p.group && (
                            <span className={`post-group ${p.group.kind}`} title={p.group.role ? `${p.group.kind}: ${p.group.role}` : p.group.kind}>
                              {p.group.kind === "carousel" ? "Carousel" : "Series"} {p.group.slide}/{p.group.of}
                              {p.group.role ? ` · ${p.group.role}` : ""}
                            </span>
                          )}
                          {p.date && (
                            <span className="post-day" title={occasionOn(p.date) || "Posting day"}>
                              <CalendarDays size={12} /> {p.date.slice(5).replace("-", "/")}
                            </span>
                          )}
                          {state && (
                            <span className={`post-state ${state.cls}`}>
                              {state.icon} {state.text}
                            </span>
                          )}
                          {t?.output && !inFlight && (
                            <span className="pc-head-tools" style={flags || !state ? { marginLeft: "auto" } : undefined}>
                              {p.overlay !== false && (
                                <button
                                  type="button"
                                  className="pc-text-studio"
                                  title="Text studio"
                                  aria-label="Text studio"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setEditing(p.index);
                                  }}
                                >
                                  <Type size={13} />
                                </button>
                              )}
                              <button
                                type="button"
                                className="pc-text-studio pc-edit-video"
                                title={videos[String(p.index)]?.done ? "Video studio: this post's clips, presets, edits and versions" : "Video studio: presets with their reference videos, a clip from this picture"}
                                aria-label="Video studio"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openVideoEditor(p.index);
                                }}
                              >
                                <Clapperboard size={13} />
                              </button>
                            </span>
                          )}
                        </header>
                      );
                    })()}
                    {img && showOverlay && p.overlay !== false ? (
                      <OverlayPreview
                        src={img}
                        spec={overlay}
                        text={{ headline: p.headline, subline: p.subline }}
                        logoSrc={logoSrc}
                        patch={p.ov}
                        faces={facesOf(t?.qa)}
                        width={720}
                        alt={p.title}
                      />
                    ) : img ? (
                      <img src={img} alt={p.title} loading="lazy" />
                    ) : (
                      <img
                        className="post-placeholder"
                        src={`/guide/${p.type}.jpg`}
                        alt=""
                        onError={(e) => (e.currentTarget.style.visibility = "hidden")}
                      />
                    )}
                    {inFlight && (
                      <span className="post-progress">
                        <Orb size={18} />
                        {makingLabel(t)}
                      </span>
                    )}
                    {t?.status === "failed" && <span className="post-failed">Failed · {t.error}</span>}
                    {product && !img && (
                      <img className="post-product-chip" src={sourceUrl(product.id)} alt="" />
                    )}
                    {approvals[String(p.index)] && (
                      <span
                        className={`post-approval ${approvals[String(p.index)].status}`}
                        title={approvals[String(p.index)].note || ""}
                      >
                        {approvals[String(p.index)].status === "approved" ? "Client approved" : "Client asks a change"}
                      </span>
                    )}
                    {t?.output && (
                      <span className="post-open">
                        <Eye size={14} /> Open
                      </span>
                    )}
                  </div>
                  {t?.output && !inFlight && (reviewFlags(t)?.length ?? 0) > 0 && (
                    <div className="text-finding warn post-finding">
                      <span className="text-finding-icon" aria-hidden>
                        <TriangleAlert size={15} />
                      </span>
                      <span className="text-finding-text">
                        <b>The review found something</b>
                        <ul className="text-finding-list">
                          {reviewFlags(t)!.map((f, n) => (
                            <li key={n}>{f.text}</li>
                          ))}
                        </ul>
                        {onFix && (
                          <span className="design-card-actions">
                            <button
                              type="button"
                              className="primary btn-pill"
                              disabled={fixing !== null || running}
                              onClick={() => {
                                setFixing(p.index);
                                void onFix(p.index, fixNote(reviewFlags(t)!)).finally(() => setFixing(null));
                              }}
                            >
                              {fixing === p.index ? <Orb size={13} /> : <Wand2 size={13} />} Edit this picture
                            </button>
                            {onAccept && (
                              <button
                                type="button"
                                className="secondary btn-pill"
                                disabled={accepting !== null}
                                title="Keep the picture as it is: the review's notes are cleared"
                                onClick={() => {
                                  setAccepting(p.index);
                                  void onAccept(p.index).finally(() => setAccepting(null));
                                }}
                              >
                                {accepting === p.index ? <Orb size={13} /> : <Check size={13} />} Accept as is
                              </button>
                            )}
                          </span>
                        )}
                      </span>
                    </div>
                  )}
                  {batchId && onFix && (
                    <PostReferenceBox
                      batchId={batchId}
                      index={p.index}
                      reference={p.reference}
                      hasPicture={!!t?.output && !inFlight}
                      disabled={inFlight || running || !!busy}
                      onMake={onFix}
                      onChanged={() => onRefresh?.()}
                    />
                  )}
                  {onFix && t?.output && !inFlight && <PostChangeBox index={p.index} disabled={running || !!busy} onChange={onFix} />}
                  {onFix && t?.output && !inFlight && (
                    <button
                      type="button"
                      className="btn-pill post-enhance"
                      disabled={fixing !== null || running || !!busy}
                      title="The same picture again at a higher quality: sharper detail, clean edges, nothing else changed"
                      onClick={() => {
                        setFixing(p.index);
                        void onFix(p.index, ENHANCE_NOTE).finally(() => setFixing(null));
                      }}
                    >
                      {fixing === p.index ? <Orb size={13} /> : <Sparkles size={13} />} Enhance
                    </button>
                  )}
                  <div className="post-fields">
                    {approvals[String(p.index)]?.status === "changes" && approvals[String(p.index)].note && (
                      <p className="post-approval-note" dir="auto">
                        “{approvals[String(p.index)].note}”
                      </p>
                    )}
                    {p.seenBefore && (
                      <p className="post-approval-note" title="Campaign memory: this idea reads like one the client already posted.">
                        Seen before · {p.seenBefore}
                      </p>
                    )}
                    {!approvals[String(p.index)] && p.clientNote && (
                      <p className="post-approval-note done" dir="auto" title={p.clientNote.summary || ""}>
                        Client asked “{p.clientNote.note}” · done{p.clientNote.summary ? `: ${p.clientNote.summary}` : ""}
                      </p>
                    )}
                    {p.product && !product && p.type !== "offer" && (
                      <p className="occasion-note warn">
                        <strong>{p.product}</strong> is not among this month's product photos. Generate brings it from the client's
                        gallery; if it is not there, upload it or pick another product.
                      </p>
                    )}
                    <section className="post-section">
                      <h4>
                        <Package size={13} /> Product
                      </h4>
                      <div className="post-row">
                        <select
                          value={p.type}
                          onChange={(e) => {
                            const type = e.target.value as PostType;
                            if (type === "offer") {
                              // An offer waits for its products, price and contents before anything is written.
                              patch(p.index, { type, offer: p.offer ?? { products: p.product ? [p.product] : [], price: "", details: "" } });
                              return;
                            }
                            const next = draft.map((x) => (x.index === p.index ? { ...x, type, offer: undefined } : x));
                            setDraft(next);
                            onRewrite(p.index, next);
                          }}
                          aria-label="Post type"
                          title="Changing the type writes this post again for that type"
                        >
                          {POST_TYPES.map((k) => (
                            <option key={k} value={k}>
                              {POST_TYPE_INFO[k].label}
                            </option>
                          ))}
                        </select>
                        <select
                          value={product ? displayName(product.name) : ""}
                          onChange={(e) => patch(p.index, { product: e.target.value || undefined })}
                          aria-label="Product"
                          className={product ? "" : "empty"}
                        >
                          <option value="">No product</option>
                          {products.map((s) => (
                            <option key={s.id} value={displayName(s.name)}>
                              {displayName(s.name)}
                            </option>
                          ))}
                        </select>
                      </div>
                      {p.product && (
                        <div className="post-extras">
                          <span>with</span>
                          {(p.products ?? []).map((n) => (
                            <button
                              key={n}
                              type="button"
                              className="chip"
                              title="Remove this product from the picture"
                              onClick={() =>
                                patch(p.index, { products: (p.products ?? []).filter((x) => x !== n) })
                              }
                            >
                              {n} ×
                            </button>
                          ))}
                          {(p.products ?? []).length < 3 && (
                            <select
                              value=""
                              aria-label="Add a product to the picture"
                              onChange={(e) => {
                                const n = e.target.value;
                                if (!n) return;
                                patch(p.index, { products: [...new Set([...(p.products ?? []), n])] });
                              }}
                            >
                              <option value="">+ product</option>
                              {products
                                .map((s) => displayName(s.name))
                                .filter((n) => n !== (p.product ?? "") && !(p.products ?? []).includes(n))
                                .map((n) => (
                                  <option key={n} value={n}>
                                    {n}
                                  </option>
                                ))}
                            </select>
                          )}
                        </div>
                      )}
                      {p.type === "offer" && (
                        <OfferForm
                          post={p}
                          products={products.map((x) => displayName(x.name))}
                          onChange={(offer) => patch(p.index, { offer })}
                          onWrite={() => onRewrite(p.index, draft)}
                          busy={busy === "reidea"}
                        />
                      )}
                      {p.type === "greeting" && (
                        <OccasionNote post={p} month={month} sel={monthOccasions} />
                      )}
                    </section>
                    {cast.length > 0 && (
                      <section className="post-section">
                        <h4>
                          <Users size={13} /> People
                        </h4>
                        <div className="post-extras post-people">
                          {(p.people ?? []).map((n) => {
                            const a = cast.find((x) => x.name === n);
                            return (
                              <button
                                key={n}
                                type="button"
                                className="chip"
                                title="Take this ambassador out of the picture"
                                onClick={() =>
                                  patch(p.index, {
                                    people: (p.people ?? []).filter((x) => x !== n),
                                  })
                                }
                              >
                                {a?.image && (
                                  <img src={`/api/studio/ambassadors/${a.id}/image?v=${a.updated}`} alt="" />
                                )}
                                {n} ×
                              </button>
                            );
                          })}
                          {(p.people ?? []).length < 3 && (
                            <select
                              value=""
                              aria-label="Add an ambassador to the picture"
                              onChange={(e) => {
                                const n = e.target.value;
                                if (!n) return;
                                patch(p.index, { people: [...new Set([...(p.people ?? []), n])] });
                              }}
                            >
                              <option value="">+ ambassador</option>
                              {cast
                                .filter((a) => !(p.people ?? []).includes(a.name))
                                .map((a) => (
                                  <option key={a.id} value={a.name}>
                                    {a.name}
                                  </option>
                                ))}
                            </select>
                          )}
                          {!(p.people ?? []).length && <small>No one in the picture</small>}
                        </div>
                      </section>
                    )}
                    <section className="post-section">
                      <h4>
                        <Type size={13} /> Words
                        <span className="post-section-tools">
                          <label className="post-overlay-toggle" title="Draw the headline and logo on this post">
                            <input
                              type="checkbox"
                              checked={p.overlay !== false}
                              onChange={(e) => patch(p.index, { overlay: e.target.checked ? undefined : false })}
                            />
                            Text on image
                          </label>
                          {overlay.scrim > 0 && (
                            <label className="post-overlay-toggle" title="The dark fade behind the headline">
                              <input
                                type="checkbox"
                                checked={p.ov?.fade !== false}
                                disabled={p.overlay === false}
                                onChange={(e) => patch(p.index, { ov: { ...(p.ov ?? {}), fade: e.target.checked ? undefined : false } })}
                              />
                              Fade
                            </label>
                          )}
                          {t?.output && p.overlay !== false && (
                            <>
                              <button
                                type="button"
                                className="icon-button"
                                aria-label="Edit text on the image"
                                title="Open the Text studio: type, fonts, colours, effects and layout on the picture"
                                onClick={() => setEditing(p.index)}
                              >
                                <PenLine size={13} />
                              </button>
                              <button
                                type="button"
                                className="icon-button"
                                aria-label="Animate this text"
                                title="Animate this text"
                                onClick={() => setAnimating(p.index)}
                                disabled={!(p.headline || p.subline)}
                              >
                                <Clapperboard size={13} />
                              </button>
                            </>
                          )}
                        </span>
                      </h4>
                      <div className="post-overlay-fields">
                        <input
                          value={p.headline ?? ""}
                          dir="auto"
                          onChange={(e) => patch(p.index, { headline: e.target.value })}
                          placeholder="Headline on the image"
                          aria-label="Headline"
                          disabled={p.overlay === false}
                        />
                        {overlay.subline.show !== false && (
                          <input
                            value={p.subline ?? ""}
                            dir="auto"
                            onChange={(e) => patch(p.index, { subline: e.target.value })}
                            placeholder="Second line"
                            aria-label="Second line"
                            disabled={p.overlay === false}
                          />
                        )}
                      </div>
                    </section>
                    {showDetails() && (
                      <section className="post-section post-details">
                        <h4>
                          <FileText size={13} /> Details
                        </h4>
                        {(() => {
                          let notes: string[] = [];
                          try {
                            notes = (t?.preflight ? (JSON.parse(t.preflight) as { notes?: string[] }).notes : undefined) ?? [];
                          } catch {
                            notes = [];
                          }
                          return notes.length ? <p className="post-preflight">Written again before paying: {notes.join("; ")}.</p> : null;
                        })()}
                        <label className="post-date">
                          <span>Posting day</span>
                          <input
                            type="date"
                            value={p.date ?? ""}
                            min={`${month}-01`}
                            max={`${month}-31`}
                            onChange={(e) => patch(p.index, { date: e.target.value || undefined })}
                          />
                          {occasionOn(p.date) && <em>{occasionOn(p.date)}</em>}
                        </label>
                        <input
                          className="post-title"
                          value={p.title}
                          onChange={(e) => patch(p.index, { title: e.target.value })}
                          placeholder="Title"
                          aria-label="Title"
                        />
                        <textarea
                          rows={3}
                          value={p.brief}
                          onChange={(e) => patch(p.index, { brief: e.target.value })}
                          placeholder="What the photograph shows: place, subject, light, mood, where the product is."
                          aria-label="Visual brief"
                        />
                        <div className="post-caption-fields">
                          <span className="post-field-label">Caption and hashtags</span>
                          <textarea
                            rows={3}
                            value={p.caption}
                            dir="auto"
                            onChange={(e) => patch(p.index, { caption: e.target.value })}
                            aria-label="Caption"
                          />
                          <input
                            value={p.hashtags}
                            onChange={(e) => patch(p.index, { hashtags: e.target.value })}
                            placeholder="#hashtags"
                            aria-label="Hashtags"
                          />
                        </div>
                      </section>
                    )}
                    {(() => {
                      const saved = plan.find((x) => x.index === p.index);
                      const cardDirty = !!saved && JSON.stringify(saved) !== JSON.stringify(p);
                      if (!cardDirty) return null;
                      // An edited idea or shot updates the finished picture as a revision of it, never a picture from scratch.
                      const briefChanged = !!saved && (saved.brief !== p.brief || (saved.scene ?? "") !== (p.scene ?? ""));
                      const updates = briefChanged && !!t?.output && !inFlight && !!onFix;
                      return (
                        <div className="post-save-row">
                          <span>Unsaved changes on this post</span>
                          <button type="button" className="text-button" onClick={() => setDraft((d) => d.map((x) => (x.index === p.index ? saved : x)))}>
                            Discard
                          </button>
                          <button
                            type="button"
                            className="primary"
                            title={updates ? "Saves the words and changes the picture to match them, keeping what still fits" : undefined}
                            onClick={() => {
                              const text = (p.scene?.trim() || p.brief).slice(0, 700);
                              void saveDraft()
                                .then(() => refitPending())
                                .then(() => (updates ? onFix!(p.index, `Update the picture to match the idea as it is written now, keeping everything that still fits: ${text}`) : undefined));
                            }}
                          >
                            <Check size={13} /> {updates ? "Save and update the picture" : "Save changes"}
                          </button>
                        </div>
                      );
                    })()}
                    {(() => {
                      // The idea was edited (and saved) after this picture was made: the picture is offered an update.
                      const stale = !!t && !inFlight && olderIdea(t, p, revision) && !!onFix;
                      if (!stale) return null;
                      const text = (p.scene?.trim() || p.brief).slice(0, 700);
                      return (
                        <div className="post-save-row post-idea-row">
                          <span>The idea changed after this picture was made.</span>
                          <button
                            type="button"
                            className="primary"
                            disabled={fixing !== null || running}
                            title="Changes the picture to match the idea as it is written now, keeping what still fits"
                            onClick={() => {
                              setFixing(p.index);
                              void onFix!(p.index, `Update the picture to match the idea as it is written now, keeping everything that still fits: ${text}`).finally(() => setFixing(null));
                            }}
                          >
                            {fixing === p.index ? <Orb size={13} /> : <Wand2 size={13} />} Update the picture
                          </button>
                        </div>
                      );
                    })()}
                    <div className="post-actions">
                      {t?.output ? (
                        <button
                          type="button"
                          className="primary post-main-action"
                          onClick={() => regenerate(t, p.index)}
                          disabled={inFlight || running || (p.type === "offer" && !offerReady(p.offer))}
                          title="A clearly different take on the same brief: new angle, set and placement"
                        >
                          <RefreshCw size={14} /> Regenerate
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="primary post-main-action"
                          onClick={() => void saveThen(() => onGeneratePosts([p.index], t?.status === "failed"))}
                          disabled={inFlight || running || !p.brief.trim() || (p.type === "offer" && !offerReady(p.offer))}
                          title={p.type === "offer" && !offerReady(p.offer) ? "Fill the offer first" : "Generate only this post"}
                        >
                          <Sparkles size={14} /> Generate
                        </button>
                      )}
                      <button
                        type="button"
                        className="secondary"
                        onClick={() => onNewIdea(p.index)}
                        disabled={inFlight || running || busy === "reidea"}
                        title="Write a different idea for this post (new scene, action and headline; same type and product), then generate it"
                      >
                        {busy === "reidea" ? <Orb size={13} /> : <Lightbulb size={13} />} New idea
                      </button>
                      {t?.output && (
                        <button
                          type="button"
                          className="secondary post-video"
                          onClick={() => setVideoFor(p.index)}
                          disabled={inFlight}
                          title="Turn this post into a 5-second ad clip on Higgsfield: an idea for the motion is written first"
                        >
                          <Film size={13} /> Video
                        </button>
                      )}
                      <span className="spacer" />
                      {onRestorePicture && !inFlight && prevOf(t) && (
                        <button
                          type="button"
                          className="icon-button"
                          disabled={restoring !== null || running}
                          aria-label="Previous picture"
                          title="Put the picture from before the last Regenerate back (the current one stays in Earlier versions)"
                          onClick={() => {
                            const was = t!.output!;
                            setRestoring(p.index);
                            void onRestorePicture(p.index, prevOf(t)!)
                              .then(() => { try { localStorage.setItem(prevKey(t!), was); } catch { /* private mode */ } })
                              .finally(() => setRestoring(null));
                          }}
                        >
                          {restoring === p.index ? <Orb size={13} /> : <RotateCcw size={13} />}
                        </button>
                      )}
                      <button
                        type="button"
                        className="icon-button danger"
                        aria-label="Remove post"
                        title="Remove this post from the month"
                        onClick={() => void removePost(p.index)}
                        disabled={inFlight}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
            <button type="button" className="post-add" onClick={addPost}>
              <ImagePlus size={18} />
              Add a post
            </button>
          </div>
        </>
      )}
      {(() => {
        const p = editing !== null ? draft.find((x) => x.index === editing) : null;
        const t = p ? taskOf(p.index) : null;
        if (!p || !t?.output) return null;
        // Chosen cards open one by one: closing this one opens the next, until none is left.
        const closeText = () => {
          const [next, ...rest] = textQueue;
          setTextQueue(rest);
          setEditing(next ?? null);
          if (next !== undefined) toast.message(`Next in the Text studio: post ${String(next).padStart(2, "0")}${rest.length ? ` (${rest.length} more after it)` : ""}.`);
        };
        return (
          <TextStudio
            key={p.index}
            open
            src={pictureOf(p.index, t)}
            hold={holdOf(p.index)}
            onVideoStudio={() => {
              setEditing(null);
              openVideoEditor(p.index);
            }}
            spec={overlay}
            logoSrc={logoSrc}
            headline={p.headline ?? ""}
            subline={p.subline ?? ""}
            patch={p.ov}
            faces={facesOf(t.qa)}
            brand={client}
            palette={palette}
            batchId={batchId ?? null}
            index={p.index}
            fileName={`${fileBase}_post-${String(p.index).padStart(2, "0")}`}
            onClientsChanged={onClientsChanged}
            onClose={closeText}
            onPhotoStudio={
              onPhotoStudio
                ? () => {
                    setTextQueue([]);
                    setEditing(null);
                    onPhotoStudio(p.index, "edit");
                  }
                : undefined
            }
            onSave={(r: EditorResult, keepOpen) => {
              const next = draftRef.current.map((x) =>
                x.index === p.index
                  ? { ...x, headline: r.headline || undefined, subline: r.subline || undefined, ov: r.ov }
                  : x,
              );
              draftRef.current = next;
              setDraft(next);
              onSavePlan(next);
              if (!keepOpen) closeText();
            }}
            assets={[
              ...products.map((s) => ({ name: displayName(s.name), src: sourceUrl(s.id), kind: "product" as const })),
              ...client.places.map((pl) => ({ name: pl.name, src: `/api/studio/clients/${client.id}/places/${pl.id}/file`, kind: "brand" as const })),
            ]}
            onUploadGraphic={
              batchId
                ? async (file: File) => {
                    const form = new FormData();
                    form.append("file", file);
                    const r = await postForm<{ url: string }>(`/api/studio/posts/graphic?batch=${encodeURIComponent(batchId)}`, form);
                    return r.url;
                  }
                : undefined
            }
            onApplyToAll={async (style: Partial<Layer>, role: ApplyRole) => {
              // One look for the month: the other posts' same-role layers take it; a post that was
              // never opened in the studio first gets its design from its own words. Only the
              // design data changes: no picture is touched and nothing is generated.
              const H = format === "1:1" ? 1080 : format === "9:16" ? 1920 : 1350;
              const made = (x: Post): TextDesign | null => {
                if (!taskOf(x.index)?.output) return null;
                if (role !== "logo" && !(x.headline || x.subline)) return null;
                return designFromLegacy(overlay, x.headline ?? "", x.subline ?? "", x.ov, null, 1080, H);
              };
              const r = applyStyleToPosts(draftRef.current, p.index, style, role, made);
              if (!r.changed) return 0;
              draftRef.current = r.plan;
              setDraft(r.plan);
              await onSavePlan(r.plan);
              return r.changed;
            }}
            monthLanguage={monthLanguage}
            postLanguage={p.language}
            onApplyLayoutToAll={async (make, _name, dryRun) => {
              // A layout for the month's other designs: each post with a picture gets the layout built
              // from its own words and language; pictures a designer added to a design stay. Only the
              // design data changes: no picture is touched and nothing is generated.
              const targets = draftRef.current.filter((x) => x.index !== p.index && !!taskOf(x.index)?.output && x.overlay !== false);
              if (dryRun || !targets.length) return targets.length;
              const next = draftRef.current.map((x) => {
                if (!targets.includes(x)) return x;
                const design = make({ headline: x.headline, subline: x.subline, design: x.ov?.design ?? null, language: x.language });
                const ov = { ...(x.ov ?? {}), design };
                // The automatic layout's own placement and typography give way to the layers, as in the studio.
                delete ov.dx;
                delete ov.dy;
                delete ov.scale;
                delete ov.position;
                delete ov.pin;
                delete ov.typo;
                delete ov.typoFor;
                return { ...x, ov };
              });
              draftRef.current = next;
              setDraft(next);
              await onSavePlan(next);
              return targets.length;
            }}
          />
        );
      })()}
      {(() => {
        const p = videoFor !== null ? draft.find((x) => x.index === videoFor) : null;
        const t = p ? taskOf(p.index) : null;
        if (!p || !t?.output || !batchId) return null;
        return (
          <VideoDialog
            open
            batchId={batchId}
            post={p}
            src={outputUrl(t)}
            fileBase={fileBase}
            // The post as it will be published, words and logo drawn by the browser: the clip's first frame when asked.
            composeArtwork={async () => {
              const canvas = await renderOverlay(outputUrl(t), overlay, { headline: p.headline, subline: p.subline }, p.overlay === false ? null : logoSrc, 1080, { patch: p.ov, faces: facesOf(t.qa) });
              return canvas.toDataURL("image/jpeg", 0.92);
            }}
            onChanged={() => void loadVideos()}
            onEditVideo={(id) => openVideoEditor(p.index, id)}
            onOpenStudio={() => openVideoEditor(p.index, null, "generate")}
            onClose={() => {
              setVideoFor(null);
              void loadVideos();
            }}
          />
        );
      })()}
      {(() => {
        const p = videoEditing !== null ? draft.find((x) => x.index === videoEditing.index) : null;
        const t = p ? taskOf(p.index) : null;
        if (!p || !batchId || !videoEditing) return null;
        return (
          <Suspense fallback={null}>
            <VideoEditor
              open
              post={{ batch: batchId, index: p.index, title: p.title }}
              initialVideoId={videoEditing.videoId}
              initialPanel={videoEditing.panel}
              pictureUrl={t?.output ? pictureOf(p.index, t) : null}
              // The post as it will be published, words and logo drawn by the browser: the clip's first frame when asked.
              composeArtwork={
                t?.output
                  ? async () => {
                      const canvas = await renderOverlay(pictureOf(p.index, t), overlay, { headline: p.headline, subline: p.subline }, p.overlay === false ? null : logoSrc, 1080, { patch: p.ov, faces: facesOf(t.qa) });
                      return canvas.toDataURL("image/jpeg", 0.92);
                    }
                  : undefined
              }
              approval={approvals[String(p.index)] ?? null}
              fileBase={`${fileBase}_post-${String(p.index).padStart(2, "0")}`}
              onExported={() => void loadVideos()}
              onChanged={() => void loadVideos()}
              onPhotoStudio={
                onPhotoStudio && t?.output
                  ? () => {
                      setVideoEditing(null);
                      onPhotoStudio(p.index, "edit");
                    }
                  : undefined
              }
              onTextStudio={
                p.overlay !== false
                  ? () => {
                      setVideoEditing(null);
                      setEditing(p.index);
                    }
                  : undefined
              }
              onClose={() => {
                setVideoEditing(null);
                void loadVideos();
              }}
            />
          </Suspense>
        );
      })()}
      {publishFor !== null && batchId && (
        <PublishDialog
          open
          batchId={batchId}
          clientId={client.id}
          index={publishFor}
          plan={plan}
          tasks={tasks}
          overlay={overlay}
          logoSrc={logoSrc}
          outputUrl={outputUrl}
          publications={publications}
          onClose={() => setPublishFor(null)}
          onChanged={refreshPublications}
        />
      )}
      {(() => {
        const p = animating !== null ? draft.find((x) => x.index === animating) : null;
        const t = p ? taskOf(p.index) : null;
        if (!p || !t?.output) return null;
        return (
          <AnimateDialog
            open
            src={outputUrl(t)}
            spec={overlay}
            logoSrc={logoSrc}
            headline={p.headline ?? ""}
            subline={p.subline ?? ""}
            patch={p.ov}
            fileBase={`${fileBase}_post${String(p.index).padStart(2, "0")}`}
            onClose={() => setAnimating(null)}
          />
        );
      })()}
    </section>
  );
}

/** Upload name without folder and extension: "Denim/cream-mug_01.jpg" -> "cream-mug_01". */
export function displayName(name: string): string {
  return decodeEntities((name.split("/").pop() ?? name).replace(/\.[^./]+$/, ""));
}

/** An offer is the designer's: its products, its price and what it includes, all required. */
function OfferForm({
  post,
  products,
  onChange,
  onWrite,
  busy,
}: {
  post: Post;
  products: string[];
  onChange: (o: PostOffer) => void;
  onWrite: () => void;
  busy: boolean;
}) {
  const o = post.offer ?? { products: [], price: "", details: "" };
  const ready = offerReady(o);
  return (
    <div className={`offer-form ${ready ? "ready" : ""}`}>
      <strong>The offer</strong>
      <div className="offer-products">
        {products.map((n) => {
          const on = o.products.includes(n);
          return (
            <button
              key={n}
              type="button"
              className={`chip ${on ? "on" : ""}`}
              onClick={() => onChange({ ...o, products: on ? o.products.filter((x) => x !== n) : [...o.products, n] })}
            >
              {n}
            </button>
          );
        })}
        {!products.length && <small>Upload the offer's products first.</small>}
      </div>
      <input dir="auto" value={o.price} placeholder="Price as it appears: 15 JD, ٢ علب بـ ١٥ دينار" onChange={(e) => onChange({ ...o, price: e.target.value })} />
      <textarea dir="auto" rows={2} value={o.details} placeholder="What is in the offer, conditions and dates" onChange={(e) => onChange({ ...o, details: e.target.value })} />
      {ready ? (
        <button type="button" className="secondary" onClick={onWrite} disabled={busy}>
          {busy ? <Orb size={13} /> : <Lightbulb size={13} />} Write the offer post
        </button>
      ) : (
        <small className="offer-warning">Pick the products, write the price and what the offer includes. The post is not generated until then.</small>
      )}
    </div>
  );
}

/** A greeting post names its occasion; a royal day asks for the official portrait. */
function OccasionNote({ post, month, sel }: { post: Post; month: string; sel?: MonthOccasions }) {
  const o = pickedOccasions(month, sel).find((x) => x.id === post.occasion) ?? occasionsOf(month).find((x) => x.id === post.occasion);
  if (!o) return null;
  const missing = o.portrait && !sel?.photos?.[o.id];
  return (
    <p className={`occasion-note ${missing ? "warn" : ""}`}>
      <strong>{o.name}</strong>
      {missing ? " · upload the official portrait (Start journey → Posts)" : o.portrait ? " · official portrait framed on the design" : ""}
    </p>
  );
}

/** The automatic review's findings on a post image, or null when it was not reviewed. */
function reviewFlags(t: Task): PostFlag[] | null {
  if (!t.qa) return null;
  try {
    const qa = JSON.parse(t.qa) as QA;
    return qa.automated && qa.flags ? qa.flags : null;
  } catch {
    return null;
  }
}
