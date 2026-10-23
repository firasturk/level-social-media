/**
 * The four-stage workflow: Start (one way to begin), Direction (what shapes the pictures), Plan
 * (the plan before anything is paid for), Studio (the month's posts, outside this screen). It
 * replaces the nine-screen journey for admins when the flag is on, over the same month data and
 * the same server routes; nothing here costs money until the plan's own button is pressed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowRight, BadgeCheck, Menu,Check, ChevronDown, ChevronUp, FileText, FolderOpen, Grid3x3, ImagePlus, Images, MessageSquareText, Moon, Play, Sparkles, Sun, TriangleAlert, Upload, UserRound, Wand2, X, Zap } from "lucide-react";
import { pickedOccasions } from "@shared/occasions";
import { referenceThumb } from "./PostTools";
import { FreepikDialog } from "./FreepikPanel";
import LevelLogo from "@/components/LevelLogo";
import { AutoplayVideo } from "@/components/AutoplayVideo";
import MediaIntake, { ROUTE_TEXT } from "./MediaIntake";
import { latestClip, rememberNewCards, type IntakeAnswer, type MediaRoute, type StartClip } from "./mediaApi";
import "./media-intake.css";
import { Orb } from "@/components/Orb";
import { get, post, postForm } from "@/api";
import VoiceInput from "@/components/VoiceInput";
import type { StyleItem } from "@shared/styles";
import { rasterize } from "@/lib/image";
import { askConfirm } from "@/lib/confirm";
import type { Ambassador, Client, Source, Task, Theme, User } from "@shared/types";
import { displayName } from "./PlanView";
import type { Config } from "@shared/config";
import { lineageUnknown, monthLabel, olderIdea, planShape, POST_TYPE_INFO, type Format, type Post } from "@shared/posts";
import { blocking, monthIssues, sceneContext, type MonthIssue } from "@shared/issues";
import { draftLabel, type PlanDraft } from "@shared/draft";
import { CONFLICT_LABELS, precedenceLine, type Conflict, type GuideLayer } from "@shared/conflicts";
import { monthCounts, picturesLine, shapeLine } from "@shared/counts";
import { confirmScope, effectLine, scopeNote } from "@shared/scope";
import type { SaveStatus as SaveState } from "@shared/save-status";
import SaveStatus from "./SaveStatus";
import { formatUsd, rateFor } from "@shared/pricing";
import StyleScreen, { styleThumb } from "./StyleGallery";
import GridPreview, { kindsLine, type GridInfo } from "./GridPreview";
import CampaignSizeCard from "./CampaignSizeCard";
import { gridMismatch } from "@shared/grid-preview";
import { monthNumbers, sizeBriefLine, withoutSizeLine, type CampaignSize } from "@shared/campaign-size";
import ReferenceLibrary from "./ReferenceLibrary";
import IdeasChat from "./IdeasChat";
import BrandChip from "./BrandChip";
import { RelevantRules } from "./MemoryPanel";
import Working from "@/components/Working";
import TestGrid from "./TestGrid";
import ProductChoice, { PostProductCell, productOf } from "./ProductChoice";
import ProductSwap from "./ProductSwap";
import { askInput } from "@/lib/confirm";
import type { OverlaySpec } from "@shared/overlay";
import Ambassadors, { MAX_CAST } from "./Ambassadors";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { defaultPaletteSource, gridColours, PALETTE_SOURCE_LABELS, PALETTE_SOURCES, paletteSourceLine, resolvePalette, savedPaletteSource, type PaletteSource } from "@shared/palette-source";

/**
 * How the month is led. The Start screen offers four: a brief, a grid, and the two direct routes
 * (the client's own pictures or clips straight onto Studio cards). "refs" (the theme's references
 * lead) and "style" (one post from a gallery style) are no longer Start cards: the theme's
 * references live in Direction, styles on the Studio cards and the style gallery.
 */
type Way = "brief" | "grid" | "refs" | "style" | "images" | "video";
type StartWay = "brief" | "grid" | "images" | "video";
type Stage = 0 | 1 | 2;

/** The four ways to start: one card design each (a picture, a title, one line, the same buttons). */
const WAYS: { key: StartWay; title: string; desc: string; direct?: boolean }[] = [
  { key: "brief", title: "Quick Campaign", desc: "Turn a brief into a campaign, typed or spoken." },
  { key: "grid", title: "Follow a grid", desc: "Plan a campaign from a grid, one post per tile." },
  { key: "images", title: "Edit images", desc: "Choose one or more images. Edit, style and add text.", direct: true },
  { key: "video", title: "Create or edit video", desc: "Choose images or clips. Create and edit your video.", direct: true },
];

/** Every way's name, the two that are no longer Start cards included (a month can still be led by them). */
const WAY_TITLES: Record<Way, string> = {
  brief: "Quick Campaign",
  grid: "Follow a grid",
  refs: "Theme references",
  style: "One post from a style",
  images: "Edit images",
  video: "Create or edit video",
};
const isDirect = (w: Way): w is "images" | "video" => w === "images" || w === "video";

const LEADS: Record<Way, { title: string; text: string; meet: string; add: string[] }> = {
  brief: {
    title: "Your request leads",
    text: "The posts, the products on each, the carousel, the colours and the text on the pictures come from what you ask for. A reference picture is recreated on its post. Nothing is made until you confirm the plan.",
    meet: "If you add a grid later, its tile sets each post's composition and your brief keeps the words and colours. Theme references only set the light and palette.",
    add: ["Theme references for the mood", "A grid for the layout", "Pictures pinned to single posts"],
  },
  grid: {
    title: "The grid leads this month",
    text: "One tile per post, in the grid's order, with its text tiles and fonts. The products are matched to the tiles from the Drive folder.",
    meet: "If you add a brief, the tile still wins the composition; the brief supplies the words, the products and the colours.",
    add: ["A brief for the words", "Theme references for the mood", "Pictures pinned to single posts"],
  },
  refs: {
    title: "Theme references lead the look",
    text: "Their light, palette, props and camera shape every post. Their objects are never copied; the products are yours.",
    meet: "If you add a grid, its tile wins the composition and the references keep the mood. A brief adds the words and the carousel.",
    add: ["A brief for the words", "A grid for the layout", "Pictures pinned to single posts"],
  },
  style: {
    title: "One post, one look",
    text: "A style from the gallery writes the post's idea and shot. It is saved on the post first; making the picture is the step you confirm, with its cost shown.",
    meet: "The style wins over a grid tile or a theme reference on that post. A picture pinned to the post still wins over the style.",
    add: ["Your product photo on that post", "A caption written for it", "More posts later, from the Studio"],
  },
  images: {
    title: "Direct to Studio: your pictures",
    text: "Pick pictures from the client's Drive or this computer, or both. Each one becomes its own card in the Studio, ready for the Photo studio, the Text studio and styles. No brief, theme or product is asked for, and nothing is generated.",
    meet: "The month's other posts stay exactly as they are; the new cards come after them. Styling or editing a picture with AI is a separate step you confirm on its card, with its cost.",
    add: ["A style on chosen cards", "Words in the Text studio", "A video from a picture"],
  },
  video: {
    title: "Direct to Studio: your clips and pictures",
    text: "Pick clips and pictures from the client's Drive or this computer. Each one becomes its own card first; then choose the cards to combine into one video in the Video editor.",
    meet: "Pictures are never turned into video by themselves: making a clip with AI stays a confirmed step in the Video editor's Generate panel.",
    add: ["Combine chosen cards into one video", "Music and cuts in the Video editor", "Words in the Text studio"],
  },
};

export interface FlowPreview {
  posts: {
    index: number;
    title: string;
    status: "ready" | "made" | "making" | "blocked";
    kind?: "picture" | "text-tile";
    paid?: boolean;
    why?: string;
    reference?: string;
    images?: { role: string; key: string }[];
    highestImage?: number;
    existing?: boolean;
    changes?: string[];
    /** The reading made from the Plan for this post, when it still applies. */
    preflight?: { notes: string[]; dropped: boolean; at: number; shot: string } | null;
    guide?: GuideLayer[];
    conflicts?: Conflict[];
  }[];
  planned: number;
  paid: number;
  blocked: { index: number; why?: string }[];
  notes: string[];
  issues: MonthIssue[];
  estimate: { model: string; size: string; perImage: number; total: number; maximum: number; known: boolean; retakes: number };
  spend: { approved: number; reserved: number; remaining: number };
}

export interface FlowProps {
  /** The stage to open on (a rail button in the Studio); otherwise where the month is. */
  initialStage?: Stage;
  /** The month's cast (the chosen ambassadors), and the client's whole roster (for the brand chip and the Models row). */
  cast: Ambassador[];
  ambassadors: Ambassador[];
  /** The cast saved on the month (config.ambassadors, the same route as the classic journey), and the roster after an add, edit or removal. */
  onCast: (ids: string[]) => void;
  onAmbassadorsChanged: (list: Ambassador[]) => void;
  /** Opens the brand kit (the Studio's brand panel), outside the flow. */
  onBrandKit: () => void;
  /** The theme's references (for the card pictures), the preview flag, and a fresh grid in the month. */
  themeRefs: { id: string }[];
  previewMode: boolean;
  /** Day or night, switchable from the workflow's top bar too. */
  theme: "light" | "dark";
  onToggleTheme: () => void;
  onNewGrid: () => Promise<void>;
  user: User;
  client: Client | null;
  /** Every active client and the month, switchable from the top bar. */
  clients: { id: string; name: string }[];
  onClient: (id: string) => void;
  onMonth: (m: string) => void;
  month: string;
  batchId: string | null;
  config: Config | null;
  plan: Post[];
  tasks: Task[];
  products: Source[];
  sourceUrl: (id: string) => string;
  outputThumb: (t: Task) => string;
  themes: Theme[];
  themeId: string;
  onTheme: (id: string) => void;
  onThemesChanged: (themes: Theme[]) => void;
  format: Format;
  model: string;
  /** The engine's display name ("Gemini 3 Pro Image"), when the models list is loaded. */
  modelName?: string;
  size: string;
  postCount: number;
  previousMonth: string | null;
  onContinue: () => Promise<void>;
  ensurePlan: () => Promise<string>;
  refresh: () => Promise<void>;
  onUpload: (files: File[]) => Promise<void>;
  onGrid: (id: string) => void;
  /** Plans the month from a library grid (its ref is "style:<id>"), tile by tile; `count` is the post count chosen on Start (the grid's or the month's). */
  onGridIdeas: (ref: string, notes: string, count?: number) => Promise<void>;
  /** The campaign's size (posts, carousels, separators, slides) and whether the designer set it on this month. */
  campaignSize: CampaignSize;
  sizeSet: boolean;
  /** Saves the size and the format on the month (kept for the month created next when there is none). */
  onSize: (size: CampaignSize, format: Format) => Promise<void>;
  /** Makes one post's picture (the style's target), nothing else. */
  onGenerateOne: (index: number) => Promise<void>;
  /** The themes read again (their reference counts) after references change. */
  reloadThemes: () => Promise<void>;
  /** The client's overlay and logo, for the test grid's words. */
  overlay: OverlaySpec;
  logoSrc: string | null;
  /** The month's standing rules for the words (config.notes). */
  onNotes: (notes: string) => void;
  /** Makes these posts' pictures again (the budget handshake asks with the cost). */
  onMakePosts: (indexes: number[]) => Promise<void>;
  /** N more posts written in the month's world, the current ones untouched. */
  onAddPosts: (n: number) => Promise<void>;
  onGenerateIdeas: (force?: boolean, notes?: string, append?: boolean) => Promise<boolean>;
  onStyles: (assign: { index: number; style: string | null }[]) => Promise<void>;
  onSavePlan: (plan: Post[]) => void | Promise<void>;
  /** Makes the ready pictures; `retakes` false turns the automatic retake off for the month. */
  onGenerate: (retakes: boolean) => Promise<void>;
  onTest: (index: number) => Promise<void>;
  engineReady: boolean;
  onDone: (focus?: number) => void;
  /** Leaves the workflow for the app's menu (Months, Styles, Video editor, Admin). */
  onMenu?: () => void;
  /** The plan's autosave (edits on this screen save when a field is left), with a retry when it failed. */
  saveStatus?: SaveState;
  onRetrySave?: () => void;
  /** The month is still opening: its counts are not known yet, not zero. */
  loadingMonth?: boolean;
}

const STAGES = ["Start", "Direction", "Plan", "Studio"];

/** The Studio's "Make N remaining" opens the month's own plan: a remembered one-post way in is forgotten first. */
export function forgetFlowWay(batchId: string | null | undefined) {
  try {
    sessionStorage.removeItem(`lsm-flow-way:${batchId ?? "new"}`);
  } catch {
    /* private mode */
  }
}

/** A short stable fingerprint of a text (what the month's shots were written from; the Journey uses the same). */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return `${text.length.toString(36)}-${h.toString(36)}`;
}

/** The one button design of the four ways to start: one height, one shape, a filled primary and a quiet secondary. */
function Cta({ kind = "primary", icon, children, ...rest }: { kind?: "primary" | "secondary"; icon?: React.ReactNode } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button type="button" {...rest} className={`cta ${kind} ${rest.className ?? ""}`}>
      {icon}
      {children}
    </button>
  );
}

export default function Flow(p: FlowProps) {
  const [stage, setStage] = useState<Stage>(() => p.initialStage ?? (p.plan.length ? 2 : p.config?.campaign || p.config?.gridRef ? 1 : 0));
  /** The way in and the style's post survive a trip to the Studio and back (this tab only), so the Plan keeps its scope. */
  const wayKey = `lsm-flow-way:${p.batchId ?? "new"}`;
  const remembered = useMemo(() => {
    try {
      const raw = sessionStorage.getItem(wayKey);
      return raw ? (JSON.parse(raw) as { way?: Way; styleTarget?: number | "next" | null }) : null;
    } catch {
      return null;
    }
  }, [wayKey]);
  const [way, setWay] = useState<Way>(() => remembered?.way ?? (p.config?.gridRef ? "grid" : p.config?.campaign ? "brief" : "brief"));
  const client = p.client;
  const theme = p.themes.find((t) => t.id === p.themeId) ?? null;
  const shape = planShape(p.plan);
  /** The Freepik picker on the Direction board: a stock picture pinned to one post as its reference (never a theme reference). */
  const [freepikOpen, setFreepikOpen] = useState(false);
  const perPicture = rateFor(p.model)?.[(p.size as "1K" | "2K" | "4K") ?? "2K"] ?? 0;

  /* ── Start: the brief, the grid, the references, the style ── */
  const briefKey = `lsm-brief-draft:${p.batchId ?? "new"}`;
  /** The brief as the designer wrote it (the size paragraph added for the planner is not shown). */
  const savedBrief = withoutSizeLine(p.config?.campaign?.text ?? "");
  const [briefText, setBriefText] = useState(() => {
    try {
      return localStorage.getItem(briefKey) ?? savedBrief;
    } catch {
      return savedBrief;
    }
  });
  const [briefFiles, setBriefFiles] = useState<File[]>([]);
  const [planning, setPlanning] = useState(false);
  /** The planner's draft, reviewed before the month changes; null when there is none open. */
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [draftBusy, setDraftBusy] = useState(false);
  useEffect(() => {
    // The words typed are kept in this browser until the draft is applied or the text is cleared.
    try {
      if (briefText.trim()) localStorage.setItem(briefKey, briefText);
      else localStorage.removeItem(briefKey);
    } catch {
      /* private mode */
    }
  }, [briefText, briefKey]);
  useEffect(() => {
    if (!p.batchId) return;
    let live = true;
    get<{ draft: PlanDraft | null }>(`/api/studio/posts/drafts?batch=${encodeURIComponent(p.batchId)}`)
      .then((r) => live && setDraft(r.draft))
      .catch(() => live && setDraft(null));
    return () => {
      live = false;
    };
  }, [p.batchId]);
  const [picking, setPicking] = useState<"grid" | "style" | null>(null);
  const [startStyle, setStartStyle] = useState<StyleItem | null>(null);
  /** The post the style is for: one of the plan's posts, or the first post of the plan written next. */
  /** No post is chosen for a style by itself: with posts in the month the team picks one; without, the first post of the plan written next. */
  const [styleTarget, setStyleTarget] = useState<number | "next" | null>(() => (remembered?.styleTarget !== undefined && p.plan.length ? remembered.styleTarget : p.plan.length ? null : "next"));
  // The month's posts can arrive after this screen opened: "the first post of the plan written next" then no longer applies, the team picks one.
  useEffect(() => {
    if (p.plan.length && styleTarget === "next") setStyleTarget(null);
    if (!p.plan.length && styleTarget !== "next") setStyleTarget("next");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.plan.length > 0]);
  useEffect(() => {
    try {
      sessionStorage.setItem(wayKey, JSON.stringify({ way, styleTarget }));
    } catch {
      /* private mode */
    }
  }, [wayKey, way, styleTarget]);
  const [moving, setMoving] = useState(false);
  const [newGridBusy, setNewGridBusy] = useState(false);
  const briefUnsent = briefText.trim().length >= 20 && briefText.trim() !== savedBrief;
  /** The three numbers of the month as it is saved (what the Start board shows beside any new request). */
  const numbers = monthNumbers(p.plan, p.campaignSize, p.tasks.filter((t) => t.post && t.output).map((t) => t.post!));
  /** Quick Campaign on a month that has posts: new posts are added, unless the month's posts are to be replaced. */
  const [briefScope, setBriefScope] = useState<"add" | "replace">("add");
  const campaignRefs = p.config?.campaign?.styles?.length ?? 0;
  /** The grid picked from the library but not applied yet, and the one the month follows. */
  const [pickedGrid, setPickedGrid] = useState<StyleItem | null>(null);
  const [monthGrid, setMonthGrid] = useState<StyleItem | null>(null);
  const [gridInfo, setGridInfo] = useState<Record<string, GridInfo>>({});
  const currentGridId = p.config?.gridRef?.startsWith("style:") ? p.config.gridRef.slice(6) : null;
  useEffect(() => {
    if (!currentGridId) {
      setMonthGrid(null);
      return;
    }
    void get<{ styles: StyleItem[] }>(`/api/studio/styles/lookup?ids=${encodeURIComponent(currentGridId)}`)
      .then((r) => setMonthGrid(r.styles[0] ?? null))
      .catch(() => setMonthGrid(null));
  }, [currentGridId]);
  const shownGrid = pickedGrid ?? monthGrid;
  useEffect(() => {
    const id = shownGrid?.id;
    if (!id || gridInfo[id]) return;
    void get<GridInfo>(`/api/studio/styles/${encodeURIComponent(id)}/grid`)
      .then((g) => setGridInfo((m) => ({ ...m, [id]: g })))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownGrid?.id]);
  /** The grid read tile by tile for the preview (one text call, kept for everyone); once per grid unless asked again. */
  const [gridReading, setGridReading] = useState<string | null>(null);
  const [gridReadError, setGridReadError] = useState<Record<string, string>>({});
  const gridReadAsked = useRef(new Set<string>());
  const analyseGrid = useCallback(async (id: string, again = false) => {
    gridReadAsked.current.add(id);
    setGridReading(id);
    setGridReadError((m) => ({ ...m, [id]: "" }));
    try {
      const g = await post<GridInfo>(`/api/studio/styles/${encodeURIComponent(id)}/grid-read${again ? "?again=1" : ""}`);
      setGridInfo((m) => ({ ...m, [id]: g }));
    } catch (e) {
      setGridReadError((m) => ({ ...m, [id]: (e as Error).message }));
    } finally {
      setGridReading((r) => (r === id ? null : r));
    }
  }, []);
  useEffect(() => {
    const id = shownGrid?.id;
    const g = id ? gridInfo[id] : null;
    if (!id || !g || g.read || gridReadAsked.current.has(id)) return;
    void analyseGrid(id);
  }, [shownGrid?.id, gridInfo, analyseGrid]);
  /** The post count chosen when the grid's tiles and the month's posts differ (null until chosen). */
  const [gridCount, setGridCount] = useState<number | null>(null);
  useEffect(() => setGridCount(null), [shownGrid?.id]);
  const gridPending = !!pickedGrid && pickedGrid.id !== currentGridId;
  const gridMonth = !!p.config?.gridRef && p.plan.some((x) => x.tile);
  const needsScene = !!theme?.shots.length || gridMonth;
  const shotsSig = hash(`v3|${p.themeId}|${p.config?.gridRef ?? ""}|${(theme?.shots ?? []).join("|")}|${JSON.stringify(p.plan.map((x) => [x.index, x.type, x.product, x.products, x.occasion, x.people, x.brief, x.offer?.products, x.tile]))}|${JSON.stringify(theme?.palette ?? [])}|${theme?.props ?? ""}`);
  const [writingShots, setWritingShots] = useState(false);
  /** Each post's shot written for its product (the Journey's "Write the shots"), when the month has a look to write from. */
  async function writeShots(force = false, fresh = false): Promise<void> {
    if (!p.batchId) return;
    // Right after the plan was written, the props here are still the old ones: the server decides.
    if (!fresh) {
      if (!p.plan.length || (!needsScene && !p.plan.some((x) => x.style))) return;
      if (!force && p.config?.shotsFor === shotsSig && p.plan.every((x) => x.scene)) return;
    }
    setWritingShots(true);
    try {
      await post("/api/studio/posts/shots", { batch: p.batchId, sig: shotsSig });
      await p.refresh();
    } catch (e) {
      // A month without a look to write from (no pins read, no grid) simply has no shots: the idea alone makes the picture.
      if (!fresh) toast.error(`Shots: ${(e as Error).message}`);
    } finally {
      setWritingShots(false);
    }
  }
  const [reading, setReading] = useState(false);
  /** The theme's pins read into shots and a palette (a text and vision call, or the demo fixture). */
  async function readPins() {
    if (!theme) return;
    setReading(true);
    try {
      const r = await post<{ themes: Theme[] }>(`/api/studio/posts/themes/${theme.id}/analyze`);
      p.onThemesChanged(r.themes);
      toast.success("Pins read: the shots and the visual language follow them.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setReading(false);
    }
  }
  /** The picked grid applied: the month planned from it, tile by tile (an existing plan is kept as a version). */
  async function applyGrid(): Promise<boolean> {
    if (!pickedGrid) return true;
    const g = gridInfo[pickedGrid.id];
    const tiles = g?.tiles || pickedGrid.tiles;
    const mismatch = tiles ? gridMismatch(g?.read && g.tileList?.length ? g.tileList : tiles, p.campaignSize.posts) : null;
    // The grid's tiles and the month's posts differ: the choice is made on the preview, never quietly here.
    if (mismatch && gridCount === null) {
      toast.error(`The grid has ${mismatch.grid} posts and the month asks for ${mismatch.requested}: choose "Use the grid's ${mismatch.grid}" or "Adapt to my ${mismatch.requested}" first.`, { duration: 8000 });
      return false;
    }
    const count = mismatch ? gridCount! : tiles || undefined;
    {
      const n = count ?? tiles;
      const scope = `The whole grid is planned: ${n ? `${n} post${n === 1 ? "" : "s"}${mismatch ? (count === mismatch.grid ? " (the grid's own count)" : ` adapted from its ${mismatch.grid} tiles`) : ", one per tile"}` : "one post per tile"}${g?.read ? ` (${kindsLine(g)})` : ""}. Single tiles cannot be picked on their own yet; from the Plan, one picture can be made as a test before the rest.`;
      const ok = await askConfirm(
        p.plan.length
          ? `Follow "${pickedGrid.title}"? ${scope} The month's ${p.plan.length} current post${p.plan.length === 1 ? "" : "s"} are planned again from its tiles: their compositions, text tiles and fonts change; pictures already made stay until they are made again, and the current plan is kept under Versions.`
          : `Follow "${pickedGrid.title}"? ${scope} Nothing is made until the plan is confirmed.`,
        { ok: "Follow this grid", danger: false, cancel: p.plan.length ? "Keep the current posts" : "Not now" },
      );
      if (!ok) return false;
    }
    try {
      await p.onGridIdeas(`style:${pickedGrid.id}`, "", count);
      setPickedGrid(null);
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    }
  }

  async function planBrief(): Promise<boolean> {
    const id = await p.ensurePlan();
    if (briefText.trim().length < 20) {
      toast.error("Say a little more first: what the posts show, how many, and any text on them.");
      return false;
    }
    setPlanning(true);
    try {
      const form = new FormData();
      form.set("batch", id);
      // The size set on Start goes with the brief when the brief is the whole month; posts added
      // to a month keep their own count (the request says how many).
      const whole = !p.plan.length || briefScope === "replace";
      form.set("brief", whole && p.sizeSet ? `${briefText.trim()}\n\n${sizeBriefLine(p.campaignSize, p.format)}` : briefText);
      for (const f of briefFiles.slice(0, 12)) {
        const ready = await rasterize(f);
        form.append("file", ready, ready.name);
      }
      // A month with posts keeps them and adds the new ones, unless they are to be replaced (kept as a version).
      if (!p.plan.length || briefScope === "replace") form.set("only", "1");
      // The planner writes a draft: the month changes only when the draft is applied below.
      const r = await postForm<{ draft: PlanDraft }>("/api/studio/posts/campaign/draft", form);
      setDraft(r.draft);
      toast.success(`Draft ready: ${r.draft.posts.length} post${r.draft.posts.length === 1 ? "" : "s"} to review. Nothing in the month changed yet.`, { duration: 8000 });
      setBriefFiles([]);
      return true;
    } catch (e) {
      toast.error((e as Error).message, { duration: 10000 });
      return false;
    } finally {
      setPlanning(false);
    }
  }

  async function applyDraft(): Promise<boolean> {
    if (!draft) return false;
    setDraftBusy(true);
    try {
      const r = await post<{ added: number }>(`/api/studio/posts/drafts/${encodeURIComponent(draft.id)}/apply`, {});
      await p.refresh();
      setDraft(null);
      try {
        localStorage.removeItem(briefKey);
      } catch {
        /* private mode */
      }
      toast.success(draft.mode === "replace" ? `The month is now the draft's ${r.added} post${r.added === 1 ? "" : "s"}; the earlier posts are under Versions.` : `${r.added} new post${r.added === 1 ? "" : "s"} added; the others are untouched.`, { duration: 8000 });
      return true;
    } catch (e) {
      toast.error((e as Error).message, { duration: 10000 });
      return false;
    } finally {
      setDraftBusy(false);
    }
  }

  async function discardDraft() {
    if (!draft) return;
    setDraftBusy(true);
    try {
      await post(`/api/studio/posts/drafts/${encodeURIComponent(draft.id)}/discard`, {});
      setDraft(null);
      toast.message("Draft discarded. The month is as it was.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setDraftBusy(false);
    }
  }

  async function toDirection() {
    setMoving(true);
    try {
      await p.ensurePlan();
      // An open draft is applied only by its own button: moving on never applies it quietly.
      if (way === "brief" && draft) {
        toast.message("Apply or discard the draft first; the month does not change until you do.");
        return;
      }
      if (way === "brief" && briefUnsent) {
        await planBrief();
        return;
      }
      if (way === "grid" && gridPending && !(await applyGrid())) return;
      setStage(1);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setMoving(false);
    }
  }

  async function toPlan() {
    setMoving(true);
    try {
      await p.ensurePlan();
      if (way === "grid" && gridPending && !(await applyGrid())) return;
      if (!p.plan.length) {
        if (way === "brief" && briefUnsent && !(await planBrief())) return;
        else if (way !== "brief" || !p.config?.campaign) {
          const ok = await p.onGenerateIdeas();
          if (!ok) return;
        }
      }
      if (startStyle) {
        // The style goes on the post chosen for it; "next" is the first post of the plan just written. No post is picked quietly.
        if (styleTarget === null) {
          toast.error("Choose the post the style goes on first.");
          return;
        }
        const index = styleTarget === "next" ? (p.plan[0]?.index ?? 1) : styleTarget;
        await p.onStyles([{ index, style: startStyle.id }]);
        setStyleTarget(index);
        setStartStyle(null);
      }
      // Each post's shot is written for its product before the plan is read, so the plan shows what the engine gets.
      await writeShots(false, true);
      setStage(2);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setMoving(false);
    }
  }

  /* ── Plan: the preview of the run ── */
  const [preview, setPreview] = useState<FlowPreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [retakes, setRetakes] = useState(() => p.config?.autoRetakes !== false);
  const [reading2, setReading2] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [rewriting, setRewriting] = useState(false);
  /** The art director's reading of the ready posts, from the Plan: what it would take out or leave out, before paying. */
  async function readScenes(indexes?: number[]) {
    if (!p.batchId) return;
    setReading2(true);
    try {
      const r = await post<{ read: { index: number; notes: string[]; dropped: boolean }[] }>("/api/studio/posts/plan-preflight", { batch: p.batchId, indexes });
      await loadPreview();
      const changed = r.read.filter((x) => x.notes.length);
      toast.success(changed.length ? `${r.read.length} post${r.read.length === 1 ? "" : "s"} read: ${changed.length} changed before paying (see each post).` : `${r.read.length} post${r.read.length === 1 ? "" : "s"} read: nothing to take out.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setReading2(false);
    }
  }
  async function keepReference(index: number, keep: boolean) {
    await p.onSavePlan(p.plan.map((y) => (y.index === index ? { ...y, keepRef: keep || undefined } : y)));
    await readScenes([index]);
  }
  const [open, setOpen] = useState<number | null>(null);
  /** The post whose product image is being chosen or replaced from the Plan's product column. */
  const [swapTarget, setSwapTarget] = useState<Post | null>(null);
  const planKey = JSON.stringify(p.plan.map((x) => [x.index, x.ideaAt, x.product, x.reference?.at, x.style]));
  const loadPreview = useCallback(async () => {
    if (!p.batchId) return;
    setPreviewBusy(true);
    try {
      setPreview(await post<FlowPreview>("/api/studio/posts/plan-preview", { batch: p.batchId }));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPreviewBusy(false);
    }
  }, [p.batchId]);
  useEffect(() => {
    if (stage === 2 && p.plan.length) void loadPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage, planKey, p.batchId]);

  const issues = useMemo(
    () =>
      monthIssues({
        config: p.config,
        client: client ? { logo: client.logo, tone: client.tone, colors: client.colors, service: client.service } : null,
        theme: theme ? { references: theme.references, shots: theme.shots, analysed: theme.analysed, latestRef: theme.latestRef, palette: theme.palette } : null,
        products: p.products.map((s) => displayName(s.name)),
        cast: p.cast.map((a) => ({ name: a.name, gender: a.gender, image: a.image, description: a.description, modest: a.modest })),
        scene: sceneContext({ config: p.config, theme, products: p.products, client }),
        // Only a month that leads with theme references needs pins on the theme: on the other ways in, the theme is optional and raises nothing.
        themeOptional: way !== "refs",
      }),
    [p.config, client, theme, p.products, p.cast, way],
  );
  /** The month in numbers, counted the same way as the Studio and the Start screen. */
  const counts = useMemo(() => monthCounts(p.plan, p.tasks, p.config), [p.plan, p.tasks, p.config]);
  /** The one post of the "One post from a style" way, when it is in the month: its scope, never the month's. */
  const onePost = way === "style" && typeof styleTarget === "number" && p.plan.some((x) => x.index === styleTarget) ? styleTarget : null;
  const outcomeOf = (index: number) => preview?.posts.find((x) => x.index === index);
  const ready = preview?.posts.filter((x) => x.status === "ready") ?? [];
  const readyPictures = ready.filter((x) => x.paid).length;
  const readyTiles = ready.filter((x) => !x.paid).length;
  const made = preview?.posts.filter((x) => x.status === "made").length ?? 0;
  // On the one-post way in, only that post's blockers and notes are shown; the month's other posts are not this operation.
  const blockedList = (preview?.blocked ?? []).filter((b) => onePost === null || b.index === onePost);
  const estimate = preview?.estimate;
  const total = estimate ? estimate.total : readyPictures * perPicture;
  const maximum = retakes ? total * (1 + (estimate?.retakes ?? 1)) : total;
  // A blocked post is listed once, from the preview; the same finding from the issues list is left out.
  const blockedIdx = new Set(blockedList.map((b) => b.index));
  const attention = [...blocking(issues), ...issues.filter((x) => x.warn)].filter((x) => !(x.post && blockedIdx.has(x.post))).filter((x) => onePost === null || !x.post || x.post === onePost);
  const taskOf = (index: number) => p.tasks.find((t) => t.post === index) ?? null;

  /* ── Direction: colours ── */
  /** The sources: the brand kit's colours, the followed grid's reading (null until read), and what the month saved. */
  const brandColours = useMemo(() => client?.colors ?? [], [client]);
  const gridFollowed = !!currentGridId;
  const monthGridInfo = currentGridId ? gridInfo[currentGridId] : null;
  const gridPalette = useMemo(() => (monthGridInfo?.read ? gridColours(monthGridInfo.tileList, monthGridInfo.world) : null), [monthGridInfo]);
  /** What the saved month says: a source, "theme" for a month saved on a theme palette before sources existed, or null. */
  const savedSource = savedPaletteSource(p.config, theme?.palette);
  /** A source picked but not saved yet (the grid still to be read, or no month yet). */
  const [sourceDraft, setSourceDraft] = useState<PaletteSource | null>(null);
  useEffect(() => setSourceDraft(null), [p.batchId]);
  const colourSource: PaletteSource = sourceDraft ?? (savedSource && savedSource !== "theme" ? savedSource : defaultPaletteSource(brandColours, gridFollowed));
  const manualColours = useMemo(() => p.config?.palette ?? [], [p.config?.palette]);
  const resolved = resolvePalette({ source: colourSource, brand: brandColours, grid: gridPalette, manual: manualColours, gridFollowed });
  /** The colours the posts get now: the month's saved ones; an older theme's until a source is chosen; else the brand's. */
  const palette = p.config?.palette?.length ? p.config.palette : savedSource === "theme" ? (theme?.palette ?? []) : brandColours;
  const paletteFrom = paletteSourceLine(savedSource, p.config);
  /** The saved colours fell behind their source (the brand kit or the grid's reading changed). */
  const paletteStale = !!p.config?.palette?.length && savedSource === colourSource && colourSource !== "manual" && !resolved.needsGridRead && resolved.palette.length > 0 && JSON.stringify(resolved.palette.map((c) => c.hex)) !== JSON.stringify(p.config.palette.map((c) => c.hex));
  const [editColours, setEditColours] = useState(false);
  const [colourDraft, setColourDraft] = useState<{ name: string; hex: string }[]>([]);
  const [savingColours, setSavingColours] = useState(false);
  const [refsOpen, setRefsOpen] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  /** The month's colours saved with their source; a month's colours never touch a theme. */
  async function saveColours(from: PaletteSource, colours: { name: string; hex: string }[]) {
    setSavingColours(true);
    try {
      const id = await p.ensurePlan();
      await post<{ palette: { name: string; hex: string }[]; from: string | null }>("/api/studio/posts/palette", {
        batch: id,
        palette: colours.filter((c) => /^#[0-9a-fA-F]{6}$/.test(c.hex)),
        from,
      });
      await p.refresh();
      setSourceDraft(null);
      setEditColours(false);
      toast.success(from === "manual" ? "Colours saved for this month." : `Colours for this month: ${paletteSourceLine(from)}.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingColours(false);
    }
  }
  /** A source chosen on the card: saved at once when its colours are at hand; kept as a draft while the grid is still to be read. */
  async function chooseSource(src: PaletteSource) {
    if (src === "manual") {
      setSourceDraft("manual");
      setColourDraft(palette.length ? palette.map((c) => ({ ...c })) : [{ name: "", hex: "#888888" }]);
      setEditColours(true);
      return;
    }
    setEditColours(false);
    const r = resolvePalette({ source: src, brand: brandColours, grid: gridPalette, manual: manualColours, gridFollowed });
    if (r.needsGridRead || !r.palette.length) {
      setSourceDraft(src);
      return;
    }
    await saveColours(src, r.palette);
  }
  // The grid's reading arrived while its colours were the chosen source: the choice is saved now.
  useEffect(() => {
    if (!sourceDraft || sourceDraft === "manual" || !gridPalette?.length || savingColours) return;
    const r = resolvePalette({ source: sourceDraft, brand: brandColours, grid: gridPalette, manual: manualColours, gridFollowed });
    if (r.palette.length) void saveColours(sourceDraft, r.palette);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gridPalette]);
  /** The Models picker (the classic journey's ambassadors step, in a dialog). */
  const [modelsOpen, setModelsOpen] = useState(false);
  const castIds = p.cast.map((a) => a.id);
  const portrait = (a: Ambassador) => (a.image ? `/api/studio/ambassadors/${a.id}/image?v=${a.updated}` : null);
  const pinned = p.plan.filter((x) => x.reference?.key).length;
  /** Products the plan names that have no photo this month, and the posts waiting on them. */
  const missingProducts = useMemo(() => {
    const names = p.products.map((s) => displayName(s.name).toLowerCase());
    const has = (n: string | undefined | null) => !!n && !names.includes(n.toLowerCase());
    const missing = [...new Set(p.plan.flatMap((x) => [x.product, ...(x.products ?? [])]).filter((n): n is string => has(n)))];
    const posts = p.plan.filter((x) => [x.product, ...(x.products ?? [])].some(has)).map((x) => x.index);
    return { missing, posts };
  }, [p.products, p.plan]);
  const themeNote = p.config?.brief?.theme;

  const lead = LEADS[way];

  /** The pictures on the four cards: the client's saved pins, shuffled once a day on the server. */
  type DailyPick = { id: string; title: string; updated: number; tiles: number };
  const [daily, setDaily] = useState<{ brief: DailyPick[]; refs: DailyPick[]; style: DailyPick | null; grid: DailyPick | null } | null>(null);
  const clientId = client?.id ?? "";
  useEffect(() => {
    if (!clientId) return;
    let live = true;
    get<{ brief: DailyPick[]; refs: DailyPick[]; style: DailyPick | null; grid: DailyPick | null }>(`/api/studio/styles/start-pictures?client=${encodeURIComponent(clientId)}`)
      .then((r) => live && setDaily(r))
      .catch(() => live && setDaily(null));
    return () => {
      live = false;
    };
  }, [clientId]);

  /* ── Direct to Studio: Edit images and Create or edit video skip Direction and Plan ── */
  const admin = p.user.role === "admin";
  const [intake, setIntake] = useState<{ route: MediaRoute; tab: "drive" | "upload"; files?: File[] } | null>(null);
  const uploadPick = useRef<HTMLInputElement>(null);
  const uploadRoute = useRef<MediaRoute>("images");
  function openIntake(route: MediaRoute, tab: "drive" | "upload", files?: File[]) {
    setWay(route);
    setIntake({ route, tab, files });
  }
  /** "Upload files" opens this computer's file chooser at once; the files picked open the dialog's tray. */
  function pickUploads(route: MediaRoute) {
    uploadRoute.current = route;
    setWay(route);
    const el = uploadPick.current;
    if (!el) return;
    el.accept = ROUTE_TEXT[route].accept;
    el.click();
  }
  /** The cards are made: the Studio opens on them, with them chosen for the next explicit step. */
  async function intakeDone(a: IntakeAnswer, dest: { client: string; month: string }) {
    const route = intake?.route ?? (way === "video" ? "video" : "images");
    const made = a.created.map((x) => x.index);
    const all = [...new Set([...made, ...a.existing.map((x) => x.index)])];
    if (a.batch && all.length) rememberNewCards(a.batch, route, all);
    const list = (ns: number[]) => ns.map((n) => String(n).padStart(2, "0")).join(", ");
    if (made.length) toast.success(`${made.length} card${made.length === 1 ? "" : "s"} added (post${made.length === 1 ? "" : "s"} ${list(made)}).${a.existing.length ? ` ${a.existing.length} already in this month (post${a.existing.length === 1 ? "" : "s"} ${list([...new Set(a.existing.map((x) => x.index))])}).` : ""} Nothing was generated.`);
    else if (a.existing.length) toast.message(`Already in this month: post${a.existing.length === 1 ? "" : "s"} ${list([...new Set(a.existing.map((x) => x.index))])}. No card was added twice.`);
    setIntake(null);
    if (client && dest.client !== client.id) p.onClient(dest.client);
    if (dest.month !== p.month) p.onMonth(dest.month);
    await p.refresh();
    p.onDone(all[0]);
  }
  // A direct route has no Direction or Plan: when those stages open, the month's own lead is shown.
  useEffect(() => {
    if (stage > 0 && isDirect(way)) setWay(p.config?.gridRef ? "grid" : p.config?.campaign ? "brief" : "refs");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage]);
  /** The pictures on the two direct cards: the month's own pictures, else its product photos, else the client's pins. */
  const startPictures = [
    ...p.tasks.filter((t) => t.post && t.output).map((t) => p.outputThumb(t)),
    ...p.products.map((s) => p.sourceUrl(s.id)),
    ...(daily?.refs ?? []).map((s) => styleThumb(s)),
  ].slice(0, 4);
  /** The client's newest finished clip, moving on the video card. */
  const [startClip, setStartClip] = useState<StartClip | null>(null);
  useEffect(() => {
    if (!clientId) return;
    let live = true;
    latestClip(clientId)
      .then((c) => live && setStartClip(c))
      .catch(() => live && setStartClip(null));
    return () => {
      live = false;
    };
  }, [clientId]);

  return (
    <div className="journey flow" role="dialog" aria-modal="true" aria-label="Create content">
      <header className="journey-top">
        {p.onMenu && (
          <button type="button" className="flow-menu" onClick={p.onMenu} title="Months, Styles, Video editor, Admin" aria-label="Open the menu">
            <Menu size={16} />
          </button>
        )}
        <LevelLogo className="journey-logo" />
        <nav className="flow-rail" aria-label="Stages">
          {STAGES.map((s, i) => (
            <button key={s} type="button" className={`flow-stage ${i === stage ? "now" : i < stage ? "done" : ""}`} disabled={i > stage && !(i === 2 && p.plan.length) && i !== 3} onClick={() => (i === 3 ? p.onDone() : setStage(i as Stage))}>
              <span className="flow-stage-n">{i + 1}</span> {s}
            </button>
          ))}
        </nav>
        {p.saveStatus && <SaveStatus status={p.saveStatus} onRetry={p.onRetrySave} className="flow-save" />}
        <span className="journey-where flow-where">
          <select value={client?.id ?? ""} onChange={(e) => p.onClient(e.target.value)} aria-label="Client" title="The client you are working on">
            {!client && <option value="">Pick a client</option>}
            {p.clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
          <input type="month" value={p.month} onChange={(e) => e.target.value && p.onMonth(e.target.value)} aria-label="Month" title="The month you are working on" />
        </span>
        {p.previewMode && <span className="flow-sample-pill">Sample data (fictional)</span>}
        {client && <BrandChip client={client} ambassadors={p.ambassadors} onOpen={p.onBrandKit} />}
        <button type="button" className="flow-theme" onClick={p.onToggleTheme} title={p.theme === "dark" ? "Switch to light mode" : "Switch to dark mode"} aria-label={p.theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}>
          {p.theme === "dark" ? <Sun size={15} /> : <Moon size={15} />}
        </button>
        <span className="flow-avatar" title={p.user.name}>
          {(p.user.name || p.user.email || "?").trim().charAt(0).toUpperCase()}
        </span>
        <button type="button" className="text-button" onClick={() => p.onDone()}>
          Skip to the Studio
        </button>
      </header>

      <div className="journey-body">
        <div className="journey-step flow-step" key={stage}>
          {/* ───────────── 1 · Start ───────────── */}
          {stage === 0 && (
            <>
              <div className="journey-head">
                <div>
                  <h2>Create content</h2>
                  <p>Choose one way to start. A campaign or a grid goes through Direction and Plan; your own images and clips go straight to the Studio. Nothing costs money until you confirm it.</p>
                </div>
              </div>
              {p.plan.length > 0 && (
                <div className="flow-saved" role="status">
                  <span className="flow-pill ok">Saved plan</span>
                  <b>
                    {numbers.posts} post{numbers.posts === 1 ? "" : "s"} · {numbers.designs} design{numbers.designs === 1 ? "" : "s"} · {numbers.images} image{numbers.images === 1 ? "" : "s"} still to generate
                  </b>
                  <span className="flow-muted">
                    This month is already planned{p.config?.plannedAt ? ` (${new Date(p.config.plannedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short" })})` : ""}. What you start here adds to it or replaces it on purpose; the saved posts never change by themselves.
                  </span>
                  <button type="button" className="cta secondary small" onClick={() => setStage(2)}>
                    Open the plan
                  </button>
                </div>
              )}
              <div className="flow-ways four" role="group" aria-label="Start with">
                {WAYS.map((w) => (
                  <div key={w.key} className={`flow-way ${way === w.key ? "on" : ""}`} data-way={w.key} aria-current={way === w.key ? "true" : undefined}>
                    <span className="flow-way-check" aria-hidden>
                      <Check size={12} />
                    </span>
                    <span className="flow-way-art" aria-hidden onClick={() => (w.direct ? openIntake(w.key as "images" | "video", "drive") : setWay(w.key))}>
                      {w.direct && (
                        <span className="flow-way-tag">
                          <Zap size={11} /> Direct to Studio
                        </span>
                      )}
                      {w.key === "brief" && (
                        <span className="flow-art-brief">
                          <i className="bar long" />
                          <i className="bar" />
                          <i className="bar" />
                          <i className="bar short" />
                          <span className="flow-art-row">
                            {(daily?.brief.length ? daily.brief.map((s) => styleThumb(s)) : p.products.slice(0, 2).map((s) => p.sourceUrl(s.id))).map((src, i) => (
                              <img key={i} src={src} alt="" />
                            ))}
                            <span className="flow-art-plus">+</span>
                          </span>
                        </span>
                      )}
                      {w.key === "grid" &&
                        (shownGrid ? (
                          <img className="flow-art-full" src={styleThumb(shownGrid, true)} alt="" />
                        ) : daily?.grid ? (
                          <img className="flow-art-full" src={styleThumb(daily.grid, true)} alt="" />
                        ) : (
                          <span className="flow-art-grid">
                            {Array.from({ length: 9 }, (_, i) => {
                              const pic = p.products[i % Math.max(1, p.products.length)];
                              const tile = i === 1 ? "word" : i === 5 || i === 8 ? "colour" : "pic";
                              const colour = palette[(i === 5 ? 0 : 1) % Math.max(1, palette.length)]?.hex;
                              if (tile === "word") return <span key={i} className="flow-art-tile word" style={colour ? { background: colour } : undefined}>MENU</span>;
                              if (tile === "colour" || !pic) return <span key={i} className="flow-art-tile" style={colour ? { background: colour } : undefined} />;
                              return <img key={i} src={p.sourceUrl(pic.id)} alt="" />;
                            })}
                          </span>
                        ))}
                      {w.key === "images" && (
                        <span className="flow-art-images">
                          {startPictures[0] ? <img src={startPictures[0]} alt="" /> : <span className="flow-art-tile" />}
                          {[1, 2, 3].map((i) => (startPictures[i] ? <img key={i} src={startPictures[i]} alt="" /> : <span key={i} className="flow-art-tile" />))}
                          <span className="flow-art-plus">+</span>
                        </span>
                      )}
                      {w.key === "video" && (
                        <span className="flow-art-video">
                          <span className="flow-art-screen">
                            {startClip ? (
                              <AutoplayVideo src={startClip.url} poster={startClip.poster ?? startPictures[0] ?? null} mode="preview" bare label={`${client?.name ?? "The client"}'s latest clip`} />
                            ) : startPictures[0] ? (
                              <>
                                <img src={startPictures[0]} alt="" />
                                <span className="flow-art-play">
                                  <Play size={16} />
                                </span>
                              </>
                            ) : (
                              <span className="flow-art-play">
                                <Play size={16} />
                              </span>
                            )}
                          </span>
                          <span className="flow-art-strip">
                            {[0, 1, 2, 3].map((i) => (startPictures[i] ? <img key={i} src={startPictures[i]} alt="" /> : <i key={i} />))}
                            <i className="wave" />
                          </span>
                        </span>
                      )}
                    </span>
                    <button type="button" className="flow-way-title" onClick={() => (w.direct ? openIntake(w.key as "images" | "video", "drive") : setWay(w.key))}>
                      {w.title}
                    </button>
                    <span className="flow-way-desc">{w.desc}</span>
                    {w.direct ? (
                      <span className="flow-way-buttons two">
                        <Cta icon={<FolderOpen size={16} />} onClick={() => openIntake(w.key as "images" | "video", "drive")}>
                          <span>Choose from Drive</span>
                        </Cta>
                        <Cta kind="secondary" icon={<Upload size={16} />} onClick={() => pickUploads(w.key as "images" | "video")}>
                          <span>Upload files</span>
                        </Cta>
                      </span>
                    ) : (
                      <span className="flow-way-buttons">
                        {w.key === "brief" ? (
                          <Cta
                            icon={<FileText size={16} />}
                            onClick={() => {
                              setWay("brief");
                              setTimeout(() => {
                                const t = document.querySelector<HTMLTextAreaElement>(".flow-brief textarea");
                                t?.scrollIntoView({ behavior: "smooth", block: "center" });
                                t?.focus({ preventScroll: true });
                              }, 60);
                            }}
                          >
                            <span>Write a brief</span>
                          </Cta>
                        ) : (
                          <Cta
                            icon={<Grid3x3 size={16} />}
                            onClick={() => {
                              setWay("grid");
                              setPicking("grid");
                            }}
                          >
                            <span>Pick a grid</span>
                          </Cta>
                        )}
                      </span>
                    )}
                  </div>
                ))}
              </div>
              <p className="flow-start-steps" aria-hidden>
                {isDirect(way) ? (
                  <>
                    Select files <ArrowRight size={12} /> Open Studio cards <ArrowRight size={12} /> Edit
                  </>
                ) : (
                  <>
                    Start <ArrowRight size={12} /> Direction <ArrowRight size={12} /> Plan <ArrowRight size={12} /> Studio
                  </>
                )}
              </p>
              <input
                ref={uploadPick}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  const files = Array.from(e.target.files ?? []);
                  e.target.value = "";
                  if (files.length) openIntake(uploadRoute.current, "upload", files);
                }}
              />
              <div className="flow-two">
                <section className="journey-box flow-box">
                  <span className="flow-eyebrow">{lead.title}</span>
                  <p className="flow-text">{lead.text}</p>
                  <p className="flow-muted">{lead.meet}</p>
                  {way === "brief" && (
                    <div className="flow-brief">
                      {p.plan.length > 0 && (
                        <div className="flow-row-head flow-brief-head">
                          <span className="flow-eyebrow">New request · writes a draft you review first</span>
                          <span className="flow-pill">
                            Saved plan · {numbers.posts} post{numbers.posts === 1 ? "" : "s"} · {numbers.designs} design{numbers.designs === 1 ? "" : "s"} · untouched until a draft is applied
                          </span>
                        </div>
                      )}
                      <textarea
                        rows={5}
                        value={briefText}
                        onChange={(e) => setBriefText(e.target.value)}
                        dir="auto"
                        aria-label={p.plan.length ? "New request" : "Your request"}
                        placeholder="e.g. Create three posts for these drinks, follow this reference's lighting and composition, and leave space for an Arabic headline."
                      />
                      {p.plan.length > 0 && savedBrief && briefText.trim() === savedBrief && (
                        <small className="flow-muted">
                          This is the brief the saved plan was made from{p.config?.campaign?.at ? ` on ${new Date(p.config.campaign.at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}. It describes the saved posts, not a new draft: edit it or write a new request to plan more, and the saved posts change only when you apply the draft.
                        </small>
                      )}
                      <div className="flow-brief-tools">
                        <VoiceInput label="Dictate" onText={(t) => setBriefText((b) => (b.trim() ? `${b.trim()} ${t}` : t))} disabled={planning} />
                        <label className="cta secondary flow-file">
                          <ImagePlus size={16} /> {briefFiles.length ? `${briefFiles.length} reference picture${briefFiles.length === 1 ? "" : "s"}` : "Attach reference pictures"}
                          <input type="file" accept="image/*" multiple hidden onChange={(e) => setBriefFiles([...(e.target.files ?? [])].slice(0, 12))} />
                        </label>
                      </div>
                      {p.plan.length > 0 && (
                        <div className="flow-scope" role="radiogroup" aria-label="What this request does">
                          <label className="check-row">
                            <input type="radio" name="brief-scope" checked={briefScope === "add"} onChange={() => setBriefScope("add")} />
                            <span>
                              <b>Create new posts</b> · the month's {p.plan.length} current post{p.plan.length === 1 ? "" : "s"} stay as they are
                            </span>
                          </label>
                          <label className="check-row">
                            <input type="radio" name="brief-scope" checked={briefScope === "replace"} onChange={() => setBriefScope("replace")} />
                            <span>
                              <b>Replace the month's posts</b> · the current plan and its pictures are kept under Versions
                            </span>
                          </label>
                        </div>
                      )}
                      <div className="flow-pick-row">
                        <Cta icon={planning ? <Orb size={15} /> : <Sparkles size={16} />} disabled={planning || draftBusy || briefText.trim().length < 20} onClick={() => void planBrief()}>
                          {planning ? "Reading your request…" : draft ? "Plan it again" : "Plan it"}
                        </Cta>
                        <small className="flow-muted">Writes a draft you review first (a text call, or the demo fixture). The month changes only when you apply it; no picture is made here.</small>
                      </div>
                      {planning && <Working label="Reading your request into a draft" />}
                      {draft && (
                        <div className="flow-draft" role="region" aria-label="Draft to review">
                          <div className="flow-row-head">
                            <span className="flow-eyebrow">Draft · not applied</span>
                            <span className={`flow-pill ${draft.mode === "replace" ? "warn" : "ready"}`}>{draft.mode === "replace" ? "Replaces the month's posts" : "Adds to the month"}</span>
                            <small className="flow-muted">{new Date(draft.created).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</small>
                          </div>
                          <p className="flow-text">{draft.summary}</p>
                          <div className="flow-draft-cells">
                            <div className="flow-draft-cell new">
                              <b>{draft.diff.added.length}</b>
                              <span>new post{draft.diff.added.length === 1 ? "" : "s"}</span>
                              <ul>
                                {draft.diff.added.slice(0, 8).map((x) => (
                                  <li key={x.index}>
                                    {String(x.index).padStart(2, "0")} · {x.title}
                                    {x.group ? ` (${x.group.kind} ${x.group.slide}/${x.group.of})` : ""}
                                  </li>
                                ))}
                                {draft.diff.added.length > 8 && <li>+{draft.diff.added.length - 8} more</li>}
                              </ul>
                            </div>
                            <div className={`flow-draft-cell ${draft.diff.changed.length ? "warn" : ""}`}>
                              <b>{draft.diff.changed.length}</b>
                              <span>existing post{draft.diff.changed.length === 1 ? "" : "s"} would change</span>
                              <ul>
                                {draft.diff.changed.slice(0, 6).map((x) => (
                                  <li key={x.index}>
                                    {String(x.index).padStart(2, "0")} · {x.title}: {x.fields.join(", ")}
                                  </li>
                                ))}
                              </ul>
                            </div>
                            <div className="flow-draft-cell">
                              <b>{draft.mode === "replace" ? draft.diff.removed.length : draft.diff.untouched.length}</b>
                              <span>{draft.mode === "replace" ? "current posts kept under Versions" : "posts stay exactly as they are"}</span>
                            </div>
                            <div className={`flow-draft-cell ${draft.diff.olderIdea.length ? "warn" : ""}`}>
                              <b>{draft.diff.olderIdea.length}</b>
                              <span>picture{draft.diff.olderIdea.length === 1 ? "" : "s"} would belong to an older idea</span>
                              <ul>
                                {draft.diff.olderIdea.slice(0, 6).map((x) => (
                                  <li key={x.index}>
                                    {String(x.index).padStart(2, "0")} · {x.title}: {x.why}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          </div>
                          <small className="flow-muted">
                            After applying: {draft.diff.after.posts} post{draft.diff.after.posts === 1 ? "" : "s"} · {draft.diff.after.designs} design{draft.diff.after.designs === 1 ? "" : "s"} · {draft.diff.after.pictures} picture{draft.diff.after.pictures === 1 ? "" : "s"} to make
                            {draft.diff.after.tiles ? ` · ${draft.diff.after.tiles} text tile${draft.diff.after.tiles === 1 ? "" : "s"} drawn here` : ""}. Closing this screen keeps the draft here, unapplied.
                          </small>
                          <div className="flow-pick-row">
                            <Cta icon={draftBusy ? <Orb size={15} /> : <Check size={16} />} disabled={draftBusy} onClick={() => void applyDraft()}>
                              {draftLabel(draft.diff)}
                            </Cta>
                            <button type="button" className="text-button" disabled={draftBusy} onClick={() => void discardDraft()}>
                              Discard the draft
                            </button>
                          </div>
                        </div>
                      )}
                      {!p.products.length && !client?.service && (
                        <small className="flow-muted">
                          No product photos this month yet: name the products in your request (the client's Drive is searched for them) or upload photos below.
                        </small>
                      )}
                      {!draft && p.config?.campaign?.summary && p.plan.length > 0 && (
                        <div className="flow-understood">
                          <div className="flow-row-head">
                            <span className="flow-eyebrow">What was understood</span>
                            <span className="flow-pill dark">{p.config.campaign.only === false ? `${p.config.campaign.added ?? 0} new posts added` : "New plan"}</span>
                          </div>
                          <dl className="flow-dl">
                            <dt>Objective</dt>
                            <dd>{p.config.campaign.summary}</dd>
                            <dt>Posts</dt>
                            <dd>{shape}</dd>
                            <dt>Products</dt>
                            <dd>{[...new Set(p.plan.flatMap((x) => [x.product, ...(x.products ?? []), ...(x.offer?.products ?? [])]).filter(Boolean))].join(", ") || "none named"}</dd>
                            <dt>Visual direction</dt>
                            <dd>
                              {campaignRefs ? `${campaignRefs} reference picture${campaignRefs === 1 ? "" : "s"} recreated on the posts` : "no reference pictures"}
                              {p.config.campaign.colours?.length ? ` · colours ${p.config.campaign.colours.map((c) => c.name || c.hex).join(", ")}` : ""}
                            </dd>
                            <dt>Text on the pictures</dt>
                            <dd>{p.plan.filter((x) => x.headline).length ? p.plan.filter((x) => x.headline).map((x) => `“${x.headline}”`).slice(0, 6).join(" · ") : "none: text-free pictures"}</dd>
                          </dl>
                          <ul className="flow-understood-posts">
                            {[...p.plan].sort((a, b) => a.index - b.index).map((x) => (
                              <li key={x.index}>
                                <span className="flow-post-n">{String(x.index).padStart(2, "0")}</span>
                                <input defaultValue={x.title} dir="auto" aria-label={`Post ${x.index} title`} onBlur={(e) => e.target.value.trim() && e.target.value !== x.title && void p.onSavePlan(p.plan.map((y) => (y.index === x.index ? { ...y, title: e.target.value } : y)))} />
                                <textarea rows={2} defaultValue={x.scene?.trim() || x.brief} dir="auto" aria-label={`Post ${x.index} scene`} placeholder="What the picture shows" onBlur={(e) => { const v = e.target.value; const was = x.scene?.trim() || x.brief; if (v !== was) void p.onSavePlan(p.plan.map((y) => (y.index === x.index ? (y.scene?.trim() ? { ...y, scene: v, handShot: true } : { ...y, brief: v }) : y))); }} />
                              </li>
                            ))}
                          </ul>
                          <small className="flow-muted">Edit any line; it saves when you leave it. The pictures are made from the Plan stage, where the cost is shown first.</small>
                        </div>
                      )}
                    </div>
                  )}
                  {way === "grid" && (
                    <div className="flow-choice-wrap">
                      {shownGrid ? (
                        <GridPreview
                          grid={shownGrid}
                          info={gridInfo[shownGrid.id] ?? null}
                          analysing={gridReading === shownGrid.id}
                          analyseError={gridReadError[shownGrid.id] || null}
                          onAnalyse={() => void analyseGrid(shownGrid.id, !!gridReadError[shownGrid.id] || !!gridInfo[shownGrid.id]?.read)}
                          requested={p.campaignSize.posts}
                          choice={gridCount}
                          onChoice={setGridCount}
                          pending={gridPending}
                          onChange={() => setPicking("grid")}
                          withBrief={!!p.config?.campaign?.text}
                        />
                      ) : (
                        <div className="flow-pick-row">
                          <Cta icon={<Grid3x3 size={16} />} onClick={() => setPicking("grid")}>
                            Pick a grid
                          </Cta>
                          <small className="flow-muted">From the library. Its picture, its real post count and what each tile is are shown here before anything is applied.</small>
                        </div>
                      )}
                      {gridPending && (
                        <p className="flow-note">
                          <b>What applying it changes.</b>{" "}
                          {p.plan.length
                            ? `The month's ${p.plan.length} existing post${p.plan.length === 1 ? "" : "s"} are planned again from the grid's tiles: their compositions, text tiles and fonts change. Pictures already made stay until they are made again; the current plan is kept under Versions. You confirm this on Continue.`
                            : "New posts are planned from the grid, one per tile, with your product photos matched to the tiles. Nothing is made until the plan is confirmed."}
                        </p>
                      )}
                    </div>
                  )}
                  {way === "refs" && client && (
                    <div className="flow-refs">
                      {theme ? (
                        <ReferenceLibrary
                          skill={theme.id}
                          title={`Theme "${theme.title}"`}
                          buttonClass="cta primary"
                          buttonLabel="Add pins or photos"
                          onChanged={async () => {
                            await p.refresh();
                            await p.reloadThemes();
                          }}
                          empty="No pins or photos yet. Add a few: they set the month's light, colours and props."
                          hint="Pinterest links or photos. Their objects are never copied."
                        />
                      ) : (
                        <p className="flow-muted">Pick or create a theme in the brand kit first; its pins and photos are the references.</p>
                      )}
                    </div>
                  )}
                  {isDirect(way) && (
                    <div className="flow-pick-row">
                      <Cta icon={<FolderOpen size={16} />} onClick={() => openIntake(way, "drive")}>
                        Choose from Drive
                      </Cta>
                      <Cta kind="secondary" icon={<Upload size={16} />} onClick={() => pickUploads(way)}>
                        Upload files
                      </Cta>
                      <small className="flow-muted">
                        {way === "video" ? (admin ? "Pictures up to 20 MB, MP4 clips up to 60 MB." : "Pictures up to 20 MB. Clips are added by an admin for now.") : "PNG, JPEG or WebP, up to 20 MB each."} Both sources can be combined in one selection.
                      </small>
                    </div>
                  )}
                  {way === "style" && (
                    <div className="flow-choice-wrap">
                      {startStyle ? (
                        <div className="flow-choice">
                          <img src={styleThumb(startStyle)} alt="" />
                          <div className="flow-choice-text">
                            <b>{startStyle.title}</b>
                            <span className="flow-muted">{startStyle.tags}</span>
                            <span className="flow-pill">Picked · saved on its post when you continue</span>
                          </div>
                          <Cta kind="secondary" icon={<Sparkles size={16} />} onClick={() => setPicking("style")}>
                            Change style
                          </Cta>
                        </div>
                      ) : (
                        <Cta icon={<Sparkles size={16} />} onClick={() => setPicking("style")}>
                          Pick a style
                        </Cta>
                      )}
                      <label className="flow-target">
                        <span className="flow-eyebrow">For which post</span>
                        <select value={styleTarget === null ? "" : String(styleTarget)} onChange={(e) => setStyleTarget(e.target.value === "" ? null : e.target.value === "next" ? "next" : Number(e.target.value))}>
                          {p.plan.length ? (
                            [<option key="" value="">Choose the post…</option>, ...[...p.plan]
                              .sort((a, b) => a.index - b.index)
                              .map((x) => (
                                <option key={x.index} value={x.index}>
                                  Post {x.index} · {x.title || POST_TYPE_INFO[x.type]?.label || x.type}
                                  {x.style ? " (has a style)" : ""}
                                  {taskOf(x.index)?.output ? " · picture made" : ""}
                                </option>
                              ))]
                          ) : (
                            <option value="next">The first post of the plan written next</option>
                          )}
                        </select>
                        <small className="flow-muted">
                          {styleTarget === null
                            ? "Pick the one post this style goes on; nothing is chosen for you."
                            : styleTarget === "next"
                            ? "No posts in this month yet: the plan is written first, and the style goes on its first post."
                            : taskOf(styleTarget as number)?.output
                              ? "This post has a picture: the style rewrites its idea and shot; making another version is a separate step you confirm."
                              : "The style rewrites this post's idea and shot; its picture is made from the Plan stage."}
                        </small>
                      </label>
                    </div>
                  )}
                </section>
                <section className="journey-box flow-box">
                  <span className="flow-eyebrow">Add later, optional</span>
                  <div className="flow-chips">
                    {lead.add.map((a) => (
                      <span key={a} className="flow-chip">
                        {a}
                      </span>
                    ))}
                  </div>
                  <small className="flow-muted">Product photos are always used; they come from the client's Drive folder and this month's uploads, not from a method.</small>
                </section>
              </div>
              <div className="flow-glance3">
                <section className="journey-box flow-box">
                  <span className="flow-eyebrow">Product photos</span>
                  <div className="flow-thumbs">
                    {p.products.slice(0, 6).map((s) => (
                      <img key={s.id} src={p.sourceUrl(s.id)} alt={s.name} />
                    ))}
                    {p.products.length > 6 && <span className="flow-thumb-more">+{p.products.length - 6}</span>}
                  </div>
                  <small>
                    {(() => {
                      const names = p.products.map((s) => displayName(s.name).toLowerCase());
                      const missing = [...new Set(p.plan.flatMap((x) => [x.product, ...(x.products ?? [])]).filter((n): n is string => !!n && !names.includes(n.toLowerCase())))];
                      return `${p.products.length} with photos${missing.length ? ` · ${missing.slice(0, 2).join(", ")} ${missing.length === 1 ? "has" : "have"} none yet` : ""} · `;
                    })()}
                    <button type="button" className="text-button" onClick={() => uploadInput.current?.click()}>
                      upload
                    </button>
                  </small>
                </section>
                {p.loadingMonth ? (
                  <section className="journey-box flow-box">
                    <span className="flow-eyebrow">Campaign size</span>
                    <p className="flow-muted" aria-busy="true">
                      Counting the month…
                    </p>
                  </section>
                ) : (
                  <CampaignSizeCard
                    plan={p.plan}
                    made={p.tasks.filter((t) => t.post && t.output).map((t) => t.post!)}
                    size={p.campaignSize}
                    format={p.format}
                    onSave={p.onSize}
                    onAddPosts={p.onAddPosts}
                    onOpenPlan={() => setStage(2)}
                    gridPosts={way === "grid" && shownGrid ? gridInfo[shownGrid.id]?.tiles || shownGrid.tiles || null : null}
                  />
                )}
                <section className="journey-box flow-box">
                  <span className="flow-eyebrow">Shortcuts</span>
                  {p.previousMonth && (
                    <button type="button" className="flow-shortcut" onClick={() => void p.onContinue()}>
                      <ArrowRight size={14} /> Continue from {monthLabel(p.previousMonth)}
                    </button>
                  )}
                  <button type="button" className="flow-shortcut" onClick={() => p.onDone()}>
                    <Grid3x3 size={14} /> Open {monthLabel(p.month)} in the Studio
                  </button>
                  <button
                    type="button"
                    className="flow-shortcut"
                    disabled={newGridBusy}
                    aria-busy={newGridBusy}
                    onClick={async () => {
                      // One fresh grid per click: the button waits for the month to exist before it can be pressed again.
                      if (newGridBusy) return;
                      setNewGridBusy(true);
                      try {
                        await p.onNewGrid();
                      } catch (e) {
                        toast.error((e as Error).message);
                      } finally {
                        setNewGridBusy(false);
                      }
                    }}
                  >
                    {newGridBusy ? <Orb size={14} /> : <ImagePlus size={14} />} {newGridBusy ? "Making a fresh grid…" : `Fresh grid in ${monthLabel(p.month)}`}
                  </button>
                </section>
              </div>
              <footer className="flow-foot">
                {isDirect(way) ? (
                  <>
                    <span className="flow-muted">{WAY_TITLES[way]} goes straight to the Studio: no Direction or Plan, and nothing is generated.</span>
                    <button type="button" className="primary btn-pill" onClick={() => openIntake(way, "drive")}>
                      <ArrowRight size={14} /> Choose the files
                    </button>
                  </>
                ) : (
                  <>
                    <span className="flow-muted">Starting with {WAY_TITLES[way].toLowerCase()}. You can change this until the plan is approved.</span>
                    <button type="button" className="primary btn-pill" disabled={moving || planning} onClick={() => void toDirection()}>
                      {moving || planning ? <Orb size={14} /> : <ArrowRight size={14} />} Continue to Direction
                    </button>
                  </>
                )}
              </footer>
            </>
          )}

          {/* ───────────── 2 · Direction ───────────── */}
          {stage === 1 && (
            <>
              <div className="journey-head">
                <div>
                  <h2>Direction</h2>
                  <p>What will shape the pictures, in the order it applies. Nothing on this screen spends the picture budget.</p>
                </div>
              </div>
              <div className="flow-two wide">
                <section className="journey-box flow-box">
                  <div className="flow-row-head">
                    <span className="flow-eyebrow">Leads this month</span>
                    <span className="flow-pill dark">{WAY_TITLES[way]}</span>
                    <button type="button" className="text-button" onClick={() => setStage(0)}>
                      Start another way
                    </button>
                  </div>
                  {(() => {
                    const summary = p.config?.campaign?.summary?.trim() ?? "";
                    const request = briefText.trim();
                    const firstSentence = (summary || request).split(/(?<=[.!?؟])\s+/)[0] ?? "";
                    const title =
                      way === "brief"
                        ? firstSentence.length <= 90
                          ? firstSentence.replace(/[.!?؟]$/, "")
                          : `${(summary || request).slice(0, 80).trim()}…`
                        : way === "grid"
                          ? shownGrid?.title ?? "No grid picked yet"
                          : way === "refs"
                            ? theme?.title ?? "No theme yet"
                            : startStyle?.title ?? "No style picked yet";
                    const body =
                      way === "brief"
                        ? summary
                          ? summary.slice(firstSentence.length <= 90 ? firstSentence.length : 0).trim() || request.slice(0, 400)
                          : request
                            ? request.slice(0, 400)
                            : "No request yet. Write it on the Start screen; the plan comes from it."
                        : way === "grid"
                          ? shownGrid
                            ? `The month follows this grid tile by tile: one tile per post, its order, its text tiles and fonts${gridPending ? " (applied when the plan is written)" : ""}.`
                            : "Pick a grid from the library; the month follows it tile by tile."
                          : way === "refs"
                            ? theme
                              ? `${theme.references} reference${theme.references === 1 ? "" : "s"} set the light, colours and camera of every post; never their objects.`
                              : "Pin pictures to a theme; they set the light and palette."
                            : startStyle
                              ? `Goes on ${styleTarget === "next" ? "the first post of the plan written next" : `post ${styleTarget}`} when the plan is written.`
                              : "Pick a style from the gallery for one post.";
                    const at = way === "brief" ? p.config?.campaign?.at : way === "refs" ? theme?.analysed : undefined;
                    const Icon = way === "brief" ? FileText : way === "grid" ? Grid3x3 : way === "refs" ? Images : Sparkles;
                    return (
                      <div className="flow-lead">
                        <span className="flow-lead-icon" aria-hidden>
                          <Icon size={18} />
                        </span>
                        <div className="flow-lead-body">
                          <b>{title}</b>
                          <span>{body}</span>
                          <small className="flow-muted">
                            {at ? `Read on ${new Date(at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })} · ` : ""}
                            {pinned ? `${pinned} picture${pinned === 1 ? "" : "s"} pinned to posts` : "no pictures pinned to posts"} ·{" "}
                            <button type="button" className="text-button" onClick={() => setStage(0)}>
                              {way === "brief" ? "Edit the brief" : way === "grid" ? "Change the grid" : way === "refs" ? "Change the theme" : "Change the style"}
                            </button>
                          </small>
                        </div>
                      </div>
                    );
                  })()}
                  <span className="flow-eyebrow">Supporting inputs</span>
                  {(() => {
                    const pinnedPosts = p.plan.filter((x) => x.reference?.key);
                    const listPosts = (ns: number[]) => (ns.length <= 1 ? ns.join("") : `${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}`);
                    const { missing, posts: missingPosts } = missingProducts;
                    return (
                      <ul className="flow-inputs">
                        <li>
                          <span className="flow-input-art">
                            {pinnedPosts.length ? (
                              pinnedPosts.slice(0, 3).map((x) => <img key={x.index} src={p.batchId ? referenceThumb(p.batchId, x.index, x.reference!.at) : ""} alt="" />)
                            ) : (
                              <i className="flow-input-empty" />
                            )}
                          </span>
                          <div className="flow-input-text">
                            <b>{pinnedPosts.length ? `${pinnedPosts.length} picture${pinnedPosts.length === 1 ? "" : "s"} pinned to post${pinnedPosts.length === 1 ? "" : "s"} ${listPosts(pinnedPosts.map((x) => x.index))}` : "No pictures pinned to posts"}</b>
                            <span>
                              Each is <strong>recreated</strong> on its post and sent to the engine; it wins over any grid tile or theme reference there.
                            </span>
                          </div>
                          <span className="flow-input-actions">
                            {p.plan.length > 0 && (
                              <button type="button" className="text-button" onClick={() => setStage(2)}>
                                {pinnedPosts.length ? "Manage" : "Pin on the plan"}
                              </button>
                            )}
                            {p.plan.length > 0 && p.batchId && client && (
                              <button type="button" className="text-button" onClick={() => setFreepikOpen(true)} title={p.user.role === "admin" ? "A stock picture from Freepik pinned to one post as its reference" : "Admins only for now"}>
                                Add from Freepik
                              </button>
                            )}
                          </span>
                        </li>
                        {client && p.batchId && (
                          <FreepikDialog
                            open={freepikOpen}
                            onClose={() => setFreepikOpen(false)}
                            title="Add from Freepik"
                            description="A stock picture pinned to one post as its reference: the post's next picture takes it. The theme's pins and the products stay as they are."
                            clientId={client.id}
                            batchId={p.batchId}
                            posts={p.plan.map((x) => ({ index: x.index, title: x.title }))}
                            mode="reference"
                            onReference={async () => {
                              await p.refresh();
                              setFreepikOpen(false);
                            }}
                          />
                        )}
                        <li>
                          <span className="flow-input-art">
                            {p.themeRefs.length ? p.themeRefs.slice(0, 3).map((r) => <img key={r.id} src={`/api/studio/references/${r.id}/file`} alt="" />) : <i className="flow-input-empty" />}
                          </span>
                          <div className="flow-input-text">
                            <b>{theme && theme.references ? `Theme references · ${theme.references}` : "Theme references · none"}</b>
                            <span>{theme && theme.references ? "Visual references: they set the light and palette for every post, never their objects. They are not product photos." : "Visual references: would set the light and palette for every post, never their objects. Not product photos. Optional."}</span>
                          </div>
                          <span className="flow-input-actions">
                            {theme && (
                              <button type="button" className="text-button" onClick={() => setRefsOpen((o) => !o)}>
                                {refsOpen ? "Hide" : theme.references ? "Manage" : "Add"}
                              </button>
                            )}
                            {theme && theme.references > 0 && (!theme.shots.length || !theme.analysed || (theme.latestRef ?? 0) > theme.analysed) && (
                              <button type="button" className="text-button" disabled={reading} onClick={() => void readPins()} title="Reads the pins into shots and a palette (a text and vision call, or the demo fixture)">
                                {reading ? <Orb size={12} /> : null} Analyse the pins
                              </button>
                            )}
                          </span>
                        </li>
                        {refsOpen && theme && (
                          <li className="flow-input-wide">
                            <ReferenceLibrary
                              skill={theme.id}
                              title=""
                              onChanged={async () => {
                                await p.refresh();
                                await p.reloadThemes();
                              }}
                            />
                          </li>
                        )}
                        <li>
                          <span className="flow-input-art">{shownGrid ? <img src={styleThumb(shownGrid)} alt="" /> : <i className="flow-input-empty" />}</span>
                          <div className="flow-input-text">
                            <b>{shownGrid ? `Grid · ${shownGrid.title}${gridPending ? " (not applied yet)" : ""}` : "Grid · none"}</b>
                            <span>{shownGrid ? "The tile takes over each post's composition; the words stay the request's." : "The request sets each post's layout. A grid would take over the composition and keep the request's words."}</span>
                          </div>
                          <span className="flow-input-actions">
                            <button type="button" className="text-button" onClick={() => setPicking("grid")}>
                              {shownGrid ? "Change" : "Add a grid"}
                            </button>
                          </span>
                        </li>
                        <li>
                          <span className="flow-input-art tall">
                            {p.products.length ? p.products.slice(0, 3).map((s) => <img key={s.id} src={p.sourceUrl(s.id)} alt="" />) : <i className="flow-input-empty" />}
                          </span>
                          <div className="flow-input-text">
                            <b>
                              Product images · {p.products.length}
                              {missing.length ? ` of ${p.products.length + missing.length}` : ""}
                            </b>
                            <span>
                              The real items in the pictures, one on each post that shows a product; never a reference picture.
                              {missing.length ? (
                                <>
                                  {" "}
                                  <strong>
                                    {missing.slice(0, 2).join(" and ")} {missing.length === 1 ? "has" : "have"} no photo
                                  </strong>
                                  , so post{missingPosts.length === 1 ? "" : "s"} {listPosts(missingPosts)} cannot be made yet.
                                </>
                              ) : null}
                            </span>
                          </div>
                          <span className="flow-input-actions">
                            <span className="flow-pill dark">1 · wins</span>
                          </span>
                        </li>
                        <li className="flow-input-wide">
                          <ProductChoice batchId={p.batchId} client={client ? { id: client.id, name: client.name } : null} plan={p.plan} products={p.products} sourceUrl={p.sourceUrl} refresh={p.refresh} onUpload={() => uploadInput.current?.click()} />
                        </li>
                        <li className="flow-models-row">
                          <span className="flow-input-art flow-models-art">
                            {p.cast.length ? (
                              p.cast.slice(0, 3).map((a) =>
                                portrait(a) ? (
                                  <img key={a.id} src={portrait(a)!} alt="" />
                                ) : (
                                  <i key={a.id} className="flow-model-blank" aria-hidden>
                                    <UserRound size={16} />
                                  </i>
                                ),
                              )
                            ) : (
                              <i className="flow-model-blank" aria-hidden>
                                <UserRound size={16} />
                              </i>
                            )}
                          </span>
                          <div className="flow-input-text">
                            <b>Models · {p.cast.length ? p.cast.length : "none"}</b>
                            <span>
                              {p.cast.length
                                ? "The brand's ambassadors in this month's pictures: the ideas cast them by name, and their portraits keep the same faces in every post."
                                : p.ambassadors.length
                                  ? "No one is cast this month. Choose up to three of the brand's ambassadors; a post that shows a person then shows one of them."
                                  : "No models on this brand yet. Add one with a name, a look and a portrait, so the same face appears in every post."}
                            </span>
                            {p.cast.length > 0 && (
                              <span className="flow-model-chips">
                                {p.cast.map((a) => (
                                  <span key={a.id} className="flow-model-chip">
                                    {portrait(a) ? (
                                      <img src={portrait(a)!} alt="" />
                                    ) : (
                                      <i className="flow-model-blank" aria-hidden>
                                        <UserRound size={12} />
                                      </i>
                                    )}
                                    {a.name}
                                    <button type="button" aria-label={`Take ${a.name} out of this month`} title="Take out of this month" onClick={() => p.onCast(castIds.filter((id) => id !== a.id))}>
                                      <X size={11} />
                                    </button>
                                  </span>
                                ))}
                              </span>
                            )}
                          </div>
                          <span className="flow-input-actions">
                            <button type="button" className="text-button" disabled={!client} onClick={() => setModelsOpen(true)}>
                              {p.cast.length ? "Change models" : p.ambassadors.length ? "Choose models" : "Add a model"}
                            </button>
                          </span>
                        </li>
                      </ul>
                    );
                  })()}
                  {client && (
                    <Dialog open={modelsOpen} onOpenChange={(o) => !o && setModelsOpen(false)}>
                      <DialogContent className="flow-models-dialog">
                        <DialogHeader>
                          <DialogTitle>Models for {monthLabel(p.month)}</DialogTitle>
                          <DialogDescription>
                            The brand's ambassadors, the same roster as the brand kit. Tick “In this month” on up to {MAX_CAST} of them; add a new one with a name, then describe the look and give it a portrait. The month's choice is saved as you tick.
                          </DialogDescription>
                        </DialogHeader>
                        <Ambassadors client={client} ambassadors={p.ambassadors} onChanged={p.onAmbassadorsChanged} cast={castIds} onCast={p.onCast} locked={false} />
                        <div className="flow-pick-row">
                          <button type="button" className="primary btn-pill" onClick={() => setModelsOpen(false)}>
                            <Check size={14} /> Done
                          </button>
                        </div>
                      </DialogContent>
                    </Dialog>
                  )}
                  <div className="flow-precedence-strip">
                    <div className="flow-precedence">
                      <b>When inputs meet on one post, this wins</b>
                      <span className="flow-pill dark">1 Product photo</span>
                      <i>›</i>
                      <span className="flow-pill">2 Picture pinned to the post</span>
                      <i>›</i>
                      <span className="flow-pill">3 Applied style</span>
                      <i>›</i>
                      <span className="flow-pill">4 Grid tile</span>
                      <i>›</i>
                      <span className="flow-pill">5 Theme reference</span>
                    </div>
                    <p className="flow-muted">Brand rules and the month's colours apply on top of all of them. {lead.meet}</p>
                  </div>
                  {client && p.batchId && (
                    <div className="flow-rules">
                      <span className="flow-eyebrow">Rules that apply this month</span>
                      <RelevantRules clientId={client.id} batchId={p.batchId} />
                      <small className="flow-muted">
                        Approved brand rules and this month's instructions, from the brand kit's memory. Proposed lessons wait there until approved and never reach a prompt before.{" "}
                        <button type="button" className="text-button" onClick={p.onBrandKit}>
                          Open the brand memory
                        </button>
                      </small>
                    </div>
                  )}
                </section>
                <div className="flow-stack">
                  <section className="journey-box flow-box flow-colours">
                    <span className="flow-eyebrow">Colours</span>
                    <div className="flow-colour-sources" role="radiogroup" aria-label="Where this month's colours come from">
                      {PALETTE_SOURCES.map((src) => {
                        const r = resolvePalette({ source: src, brand: brandColours, grid: gridPalette, manual: manualColours, gridFollowed });
                        const on = colourSource === src;
                        const swatches = src === "manual" ? (on ? palette : manualColours) : r.palette;
                        return (
                          <button key={src} type="button" role="radio" aria-checked={on} className={`flow-colour-source ${on ? "on" : ""}`} disabled={savingColours} onClick={() => void chooseSource(src)}>
                            <span className="flow-source-check" aria-hidden>
                              {on && <Check size={11} />}
                            </span>
                            <b>{PALETTE_SOURCE_LABELS[src].title}</b>
                            <small>{PALETTE_SOURCE_LABELS[src].note}</small>
                            {swatches.length > 0 && (
                              <span className="flow-source-swatches" aria-hidden>
                                {swatches.slice(0, 8).map((c, i) => (
                                  <i key={i} style={{ background: c.hex }} />
                                ))}
                              </span>
                            )}
                          </button>
                        );
                      })}
                    </div>
                    {!editColours ? (
                      <>
                        <div className="flow-swatches">
                          {(sourceDraft && sourceDraft !== "manual" ? resolved.palette : palette).map((c, i) => (
                            <span key={i} className="flow-swatch" style={{ background: c.hex }} title={`${c.name} ${c.hex}`} />
                          ))}
                          {!(sourceDraft && sourceDraft !== "manual" ? resolved.palette : palette).length && <small className="flow-muted">No colours yet.</small>}
                        </div>
                        {resolved.warning && (sourceDraft || !p.config?.palette?.length) ? (
                          <span className="flow-colour-warn" role="status">
                            <TriangleAlert size={13} /> {resolved.warning}
                            {resolved.needsGridRead && currentGridId && (
                              <button type="button" className="text-button" disabled={gridReading === currentGridId} onClick={() => void analyseGrid(currentGridId, true)}>
                                {gridReading === currentGridId ? <Orb size={12} /> : null} Read the grid
                              </button>
                            )}
                          </span>
                        ) : null}
                        <small className="flow-muted">
                          {p.config?.palette?.length ? `This month only, ${paletteFrom}. The first colour is the background of every post.` : savedSource === "theme" ? `Colours ${paletteFrom}.` : `Not saved yet: the posts use the client's brand colours until a source is chosen.`}
                        </small>
                        {paletteStale && (
                          <button type="button" className="text-button" disabled={savingColours} onClick={() => void saveColours(colourSource, resolved.palette)}>
                            {savingColours ? <Orb size={12} /> : null} The {colourSource === "grid" ? "grid's reading" : "brand kit"} changed: update this month's colours
                          </button>
                        )}
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => {
                            setColourDraft(palette.length ? palette.map((c) => ({ ...c })) : [{ name: "", hex: "#888888" }]);
                            setSourceDraft("manual");
                            setEditColours(true);
                          }}
                        >
                          Edit colours
                        </button>
                      </>
                    ) : (
                      <div className="flow-colour-edit">
                        {colourDraft.map((c, i) => (
                          <div key={i} className="flow-colour-row">
                            <input type="color" value={/^#[0-9a-fA-F]{6}$/.test(c.hex) ? c.hex : "#888888"} onChange={(e) => setColourDraft((d) => d.map((x, k) => (k === i ? { ...x, hex: e.target.value } : x)))} aria-label={`Colour ${i + 1}`} />
                            <input value={c.name} placeholder="name" onChange={(e) => setColourDraft((d) => d.map((x, k) => (k === i ? { ...x, name: e.target.value.slice(0, 40) } : x)))} />
                            <button type="button" className="text-button" onClick={() => setColourDraft((d) => d.filter((_, k) => k !== i))}>
                              remove
                            </button>
                          </div>
                        ))}
                        {colourDraft.length < 8 && (
                          <button type="button" className="text-button" onClick={() => setColourDraft((d) => [...d, { name: "", hex: "#888888" }])}>
                            + colour
                          </button>
                        )}
                        <small className="flow-muted">Saved for this month only; the first colour is the background of every post. A month's colours never change a theme.</small>
                        <div className="flow-pick-row">
                          <button type="button" className="primary btn-pill" disabled={savingColours} onClick={() => void saveColours("manual", colourDraft)}>
                            {savingColours ? <Orb size={14} /> : <Check size={14} />} Save colours
                          </button>
                          <button
                            type="button"
                            className="text-button"
                            onClick={() => {
                              setEditColours(false);
                              setSourceDraft(null);
                            }}
                          >
                            Keep as they are
                          </button>
                        </div>
                      </div>
                    )}
                  </section>
                  <section className="journey-box flow-box">
                    <span className="flow-eyebrow">Format and engine</span>
                    <dl className="flow-dl">
                      <dt>Size</dt>
                      <dd>
                        {p.format} · {p.size}
                      </dd>
                      <dt>Engine</dt>
                      <dd>
                        {p.modelName || p.model || "the connected engine"} · {perPicture ? `about ${formatUsd(perPicture)} per picture (list price, an estimate)` : "price not known for this engine"}
                      </dd>
                      <dt>Occasions</dt>
                      <dd>
                        {(() => {
                          const occ = pickedOccasions(p.month, p.config?.occasions);
                          return occ.length ? occ.map((o) => o.name).join(", ") : "none ticked this month";
                        })()}
                      </dd>
                      <dt>Words</dt>
                      <dd>Arabic headline, English second line, caption at most 10 words</dd>
                    </dl>
                    <small className="flow-muted">The ideas, shots, captions and reviews are text calls billed per call by the provider, outside the picture budget; without a key they come from demo fixtures and say so.</small>
                  </section>
                  <section className="journey-box flow-box">
                    <span className="flow-eyebrow">{theme && theme.references > 0 ? "What the pinned pictures say" : "What the theme's description says"}</span>
                    {theme && theme.references === 0 && themeNote ? <small className="flow-muted">No reference pictures were read: this comes from the theme's written description alone.</small> : null}
                    {themeNote ? (
                      <>
                        <p className="flow-text">{themeNote.summary}</p>
                        <ul className="flow-points">
                          {themeNote.points.slice(0, 4).map((x, i) => (
                            <li key={i}>{x}</li>
                          ))}
                        </ul>
                        <small className="flow-muted">Read once and kept with the plan; not read again unless a picture changes.</small>
                      </>
                    ) : (
                      <small className="flow-muted">Not read yet. The reading runs when the plan is written.</small>
                    )}
                  </section>
                </div>
              </div>
              <footer className="flow-foot">
                <span className="flow-muted">
                  {WAY_TITLES[way]} leads · {pinned} pinned · colours {paletteFrom} · {p.cast.length ? `${p.cast.length} model${p.cast.length === 1 ? "" : "s"}` : "no models"} · {p.products.length} product photo{p.products.length === 1 ? "" : "s"}
                </span>
                <button type="button" className="primary btn-pill" disabled={moving} onClick={() => void toPlan()}>
                  {moving ? <Orb size={14} /> : <ArrowRight size={14} />} {p.plan.length ? "Open the plan" : "Write the plan"}
                </button>
              </footer>
            </>
          )}

          {/* ───────────── 3 · Plan ───────────── */}
          {stage === 2 && (
            <>
              <div className="journey-head">
                <div>
                  <h2>The plan, before anything is made</h2>
                  <p>Read it and change anything. Making the pictures is the one step that costs money; you confirm it at the bottom.</p>
                </div>
                <Cta kind="secondary" icon={<MessageSquareText size={16} />} className="journey-head-action" onClick={() => setChatOpen((o) => !o)}>
                  {chatOpen ? "Close the planner" : "Talk to the planner"}
                </Cta>
              </div>
              <div className="flow-tools quiet">
                <button type="button" className="text-button" disabled={reading2 || !readyPictures} onClick={() => void readScenes()} title="The art director reads each ready post before paying: what it would take out of the scene, and whether a reference would be left out. Text and vision calls, or the demo fixture; no picture is made.">
                  {reading2 ? <Orb size={12} /> : <BadgeCheck size={14} />} Read the scenes before paying
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={rewriting}
                  onClick={async () => {
                    const ok = await askConfirm(`Write the ideas of the whole month again (${p.plan.length} design${p.plan.length === 1 ? "" : "s"})? ${effectLine("plan", { kind: "month", month: p.month, designs: p.plan.length })} The current posts, their words and pictures are kept under Versions; ${counts.existing ? `the ${counts.existing} picture${counts.existing === 1 ? "" : "s"} already made ${counts.existing === 1 ? "is" : "are"} marked as made for an older idea and ` : "pictures already made are "}not remade until you ask.`, { ok: "Write them again", danger: false, cancel: "Keep these ideas" });
                    if (!ok) return;
                    setRewriting(true);
                    try {
                      await p.onGenerateIdeas(true);
                    } finally {
                      setRewriting(false);
                    }
                  }}
                >
                  {rewriting ? <Orb size={12} /> : <Sparkles size={14} />} Write the ideas again
                </button>
                <button
                  type="button"
                  className="text-button"
                  disabled={rewriting}
                  onClick={async () => {
                    const n = Number(await askInput("How many posts to add?", "1", { ok: "Add", placeholder: "1" }));
                    if (!n || n < 1 || n > 12) return;
                    setRewriting(true);
                    try {
                      await p.onAddPosts(n);
                    } finally {
                      setRewriting(false);
                    }
                  }}
                >
                  <ImagePlus size={14} /> Add posts
                </button>
                <button type="button" className="text-button" onClick={() => void loadPreview()} disabled={previewBusy} title="Reads the plan again: states, estimate and what each post would send to the engine">
                  {previewBusy ? <Orb size={12} /> : <Wand2 size={14} />} Read again
                </button>
              </div>
              {reading2 && <Working label="Reading the scenes before paying" count={{ done: 0, of: readyPictures }} className="flow-working" />}
              {rewriting && <Working label="Writing the ideas" className="flow-working" />}
              {writingShots && <Working label="Writing the shots" className="flow-working" />}
              {previewBusy && !preview && <Working label="Reading the plan" className="flow-working" />}
              {chatOpen && (
                <IdeasChat
                  batchId={p.batchId}
                  config={p.config}
                  busy={rewriting}
                  admin={p.user.role === "admin"}
                  engineReady={p.engineReady}
                  refresh={async () => {
                    await p.refresh();
                    await loadPreview();
                  }}
                  onNotes={p.onNotes}
                  onMake={async (indexes) => {
                    const versions = indexes.filter((i) => !!taskOf(i)?.output).length;
                    const scope = confirmScope({ target: { kind: "selection", indexes }, effect: versions === indexes.length ? "new-version" : "first-image", cost: (estimate?.perImage ?? perPicture) * indexes.length, untouched: p.plan.length > indexes.length ? `the month's other ${p.plan.length - indexes.length} post${p.plan.length - indexes.length === 1 ? "" : "s"}` : undefined });
                    const ok = await askConfirm(`The changes are saved. ${scope.message}${versions && versions < indexes.length ? ` ${versions} of them already ${versions === 1 ? "has" : "have"} a picture: that one stays under Versions.` : ""}`, { ok: scope.ok, cancel: "Keep the changes, make them later", danger: false });
                    if (ok) await p.onMakePosts(indexes);
                    else toast.message("The posts are changed; the Plan's button makes the pictures when you want them.");
                  }}
                />
              )}
              <section className="flow-summary">
                <div className="flow-sum-cell">
                  <span className="flow-eyebrow">Objective</span>
                  <p>
                    {p.config?.gridRef && monthGrid
                      ? `The month follows the grid "${monthGrid.title}", tile by tile.${p.config.gridNotes ? ` ${p.config.gridNotes.split(/(?<=\.)\s/)[0]}` : ""}`
                      : p.config?.campaign?.summary || p.config?.notes || theme?.direction?.split(/(?<=\.)\s/)[0] || "The month's posts for the brand."}
                  </p>
                </div>
                <div className="flow-sum-cell">
                  <span className="flow-eyebrow">Product images</span>
                  <div className="flow-thumbs small">
                    {p.products.slice(0, 7).map((s) => (
                      <img key={s.id} src={p.sourceUrl(s.id)} alt={s.name} title={`Product photo: ${displayName(s.name)}`} />
                    ))}
                  </div>
                  <small>
                    {(() => {
                      const named = [...new Set(p.plan.flatMap((x) => [x.product, ...(x.products ?? []), ...(x.offer?.products ?? [])]).filter((n): n is string => !!n))];
                      return named.length ? `${named.slice(0, 4).join(", ")}${named.length > 4 ? ` +${named.length - 4} more` : ""} · ` : "";
                    })()}
                    {(() => {
                      const shown = p.plan.filter((x) => x.type !== "greeting" && x.type !== "offer" && !["text", "texture", "place"].includes(x.tileSpec?.kind ?? ""));
                      const without = shown.filter((x) => !productOf(x, p.products)).length;
                      return `${p.products.length} product photo${p.products.length === 1 ? "" : "s"} · ${shown.length - without} of ${shown.length} post${shown.length === 1 ? "" : "s"} have theirs${without ? ` · ${without} without` : ""}`;
                    })()}
                    {blockedList.length ? ` · ${blockedList.length} post${blockedList.length === 1 ? "" : "s"} waiting` : ""}
                  </small>
                </div>
                <div className="flow-sum-cell">
                  <span className="flow-eyebrow">Visual direction</span>
                  <p>
                    <b>{WAY_TITLES[way]} leads</b> · {monthGrid ? `grid “${monthGrid.title}”` : "no grid"} · {theme ? `theme “${theme.title}”${theme.references ? "" : " (no pins, optional)"}` : "no theme"} · colours {p.config?.palette?.length ? `this month only, ${paletteFrom}` : savedSource === "theme" ? paletteFrom : "the client's brand colours"}
                  </p>
                  <button type="button" className="text-button" onClick={() => setStage(1)}>
                    Change
                  </button>
                </div>
                <div className="flow-sum-cell">
                  <span className="flow-eyebrow">Models</span>
                  {p.cast.length ? (
                    <div className="flow-model-chips">
                      {p.cast.map((a) => (
                        <span key={a.id} className="flow-model-chip" title={a.description || a.name}>
                          {portrait(a) ? (
                            <img src={portrait(a)!} alt="" />
                          ) : (
                            <i className="flow-model-blank" aria-hidden>
                              <UserRound size={12} />
                            </i>
                          )}
                          {a.name}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p>No models cast this month: a post that shows a person shows no one in particular.</p>
                  )}
                  <small>
                    {(() => {
                      const named = p.plan.filter((x) => x.people?.length).length;
                      return p.cast.length ? `${p.cast.length} cast this month · ${named ? `${named} post${named === 1 ? "" : "s"} name${named === 1 ? "s" : ""} them` : "no post names them yet"}` : "";
                    })()}
                  </small>
                  <button type="button" className="text-button" onClick={() => setStage(1)}>
                    Change
                  </button>
                </div>
                <div className="flow-sum-cell">
                  <span className="flow-eyebrow">Reference pictures</span>
                  {(() => {
                    const styled = p.plan.filter((x) => x.style);
                    const pinnedPosts = p.plan.filter((x) => x.reference?.key).map((x) => x.index);
                    const items: { n: string; what: string }[] = [];
                    if (pinnedPosts.length) items.push({ n: `${pinnedPosts.length} pinned to post${pinnedPosts.length === 1 ? "" : "s"} ${pinnedPosts.slice(0, 5).join(", ")}${pinnedPosts.length > 5 ? "…" : ""}`, what: "recreated on that post; wins over the style, the grid and the theme there" });
                    if (campaignRefs) items.push({ n: `${campaignRefs} attached to the brief`, what: "recreated on the posts they were attached to" });
                    if (styled.length) items.push({ n: `${styled.length} style${styled.length === 1 ? "" : "s"} on post${styled.length === 1 ? "" : "s"} ${styled.map((x) => x.index).slice(0, 5).join(", ")}${styled.length > 5 ? "…" : ""}`, what: "the idea and shot of that post" });
                    if (monthGrid) items.push({ n: `Grid “${monthGrid.title}”`, what: "the composition of every post" });
                    if (theme?.references) items.push({ n: `${theme.references} theme reference${theme.references === 1 ? "" : "s"}`, what: "the light and palette only, never their objects" });
                    return (
                      <ul className="flow-refs-list">
                        {items.map((it) => (
                          <li key={it.n}>
                            <b>{it.n}</b> · {it.what}
                          </li>
                        ))}
                        {!items.length && <li>None: the pictures follow the brief and the product photos.</li>}
                      </ul>
                    );
                  })()}
                </div>
                {onePost !== null ? (
                  <div className="flow-sum-cell scope">
                    <span className="flow-eyebrow">This operation · one post</span>
                    <p>
                      <b>Post {onePost} “{p.plan.find((x) => x.index === onePost)?.title}”</b>
                    </p>
                    <small>
                      {taskOf(onePost)?.output ? effectLine("new-version", { kind: "post", index: onePost }) : effectLine("first-image", { kind: "post", index: onePost })} About {formatUsd(estimate?.perImage ?? perPicture)}. {scopeNote({ kind: "post", index: onePost }, p.plan.length)}
                    </small>
                  </div>
                ) : (
                  <div className="flow-sum-cell">
                    <span className="flow-eyebrow">Output</span>
                    {p.loadingMonth ? (
                      <p className="flow-muted" aria-busy="true">
                        Counting the month…
                      </p>
                    ) : (
                      <>
                        <p>
                          <b>{shapeLine(counts)}</b>
                        </p>
                        <small>
                          {picturesLine(counts)} · {p.format}
                          {blockedList.length ? ` · ${blockedList.length} blocked` : ""}
                        </small>
                      </>
                    )}
                  </div>
                )}
                <div className={`flow-sum-cell attention ${attention.length || blockedList.length ? "on" : ""}`}>
                  <span className="flow-eyebrow">Needs your attention · {attention.length + blockedList.length}</span>
                  <ul>
                    {blockedList.map((b) => (
                      <li key={`b${b.index}`}>
                        Post {b.index}: {b.why}
                      </li>
                    ))}
                    {(() => {
                      const shots = attention.filter((x) => x.code === "post-shot");
                      const rest = attention.filter((x) => x.code !== "post-shot");
                      return (
                        <>
                          {shots.length > 0 && (
                            <li>
                              {shots.length} post{shots.length === 1 ? " has" : "s have"} no shot yet (made from the idea alone).{" "}
                              <button type="button" className="text-button" disabled={writingShots} onClick={() => void writeShots(true)}>
                                {writingShots ? <Orb size={12} /> : null} Write the shots
                              </button>
                            </li>
                          )}
                          {rest.slice(0, 4).map((x, i) => (
                            <li key={i}>{x.text}</li>
                          ))}
                          {rest.length > 4 && <li className="flow-muted">+{rest.length - 4} more, each on its post below</li>}
                        </>
                      );
                    })()}
                    {!attention.length && !blockedList.length && <li>Nothing. Every post can be made.</li>}
                  </ul>
                </div>
              </section>
              <section className="journey-box flow-box prodc-box">
                <span className="flow-eyebrow">Product images</span>
                <ProductChoice variant="bar" batchId={p.batchId} client={client ? { id: client.id, name: client.name } : null} plan={p.plan} products={p.products} sourceUrl={p.sourceUrl} refresh={p.refresh} onUpload={() => uploadInput.current?.click()} onChanged={loadPreview} />
              </section>
              <p className="flow-muted flow-precedence-line">{precedenceLine(isDirect(way) ? "refs" : way, { grid: !!monthGrid, theme: !!theme?.references, pinned, styled: p.plan.filter((x) => x.style).length })}</p>
              {counts.older > 0 && onePost === null && (
                <section className="flow-older" role="note">
                  <div className="flow-older-text">
                    <b>
                      {counts.older} picture{counts.older === 1 ? "" : "s"} belong{counts.older === 1 ? "s" : ""} to an older idea · post{counts.olderPosts.length === 1 ? "" : "s"} {counts.olderPosts.join(", ")}
                    </b>
                    <span>
                      The idea, product or direction of {counts.older === 1 ? "this post" : "these posts"} changed after the picture{counts.older === 1 ? " was" : "s were"} made. {counts.older === 1 ? "It stays" : "They stay"} under Versions; the month's other {p.plan.length - counts.older} post{p.plan.length - counts.older === 1 ? " is" : "s are"} untouched. Only {counts.older === 1 ? "this one is" : "these are"} made again, when you ask.
                    </span>
                  </div>
                  <button
                    type="button"
                    className="secondary btn-pill"
                    disabled={!p.engineReady}
                    onClick={async () => {
                      const cost = (estimate?.perImage ?? perPicture) * counts.olderPosts.length;
                      const scope = confirmScope({ target: { kind: "selection", indexes: counts.olderPosts }, effect: "new-version", cost, untouched: `the month's other ${p.plan.length - counts.older} post${p.plan.length - counts.older === 1 ? "" : "s"}` });
                      const ok = await askConfirm(scope.message, { ok: scope.ok, danger: false, cancel: "Keep the pictures as they are" });
                      if (!ok) return;
                      await p.onMakePosts(counts.olderPosts);
                      p.onDone(counts.olderPosts[0]);
                    }}
                  >
                    Make {counts.older === 1 ? "it" : `those ${counts.older}`} again · about {formatUsd((estimate?.perImage ?? perPicture) * counts.olderPosts.length)}
                  </button>
                </section>
              )}
              <section className="journey-box flow-posts">
                <div className="flow-posts-head">
                  <span>#</span>
                  <span />
                  <span>Post and scene</span>
                  <span>Product</span>
                  <span>Output · day</span>
                  <span />
                </div>
                <ul>
                  {[...p.plan]
                    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? "") || a.index - b.index)
                    .map((x) => {
                      const t = taskOf(x.index);
                      const o = outcomeOf(x.index);
                      const kind = x.tileSpec?.kind === "text" && !x.product ? "Text tile · drawn here, free" : x.group ? `${x.group.kind === "carousel" ? "Carousel" : "Series"} · slide ${x.group.slide} of ${x.group.of}` : "Picture";
                      const state = o?.status === "blocked" ? { cls: "warn", text: "Blocked" } : t && olderIdea(t, x, p.config) ? { cls: "idea", text: "Older idea" } : o?.status === "made" ? { cls: "ok", text: "Made" } : o?.status === "making" ? { cls: "making", text: "Making" } : o?.status === "ready" ? { cls: "ready", text: o.paid ? "Ready to make" : "Drawn here" } : { cls: "", text: "" };
                      const isOpen = open === x.index;
                      const older = !!t && olderIdea(t, x, p.config);
                      return (
                        <li key={x.index} className={`${isOpen ? "open" : ""} ${onePost === x.index ? "scoped" : ""}`}>
                          <span className="flow-post-n">{String(x.index).padStart(2, "0")}</span>
                          <span className="flow-post-thumb">{t?.output ? <img src={p.outputThumb(t)} alt="" /> : <span className="flow-post-blank" />}</span>
                          <span className="flow-post-main">
                            <b>{x.title}</b>
                            <span className="flow-muted flow-scene" title={x.scene?.trim() ? "The shot written for this post: what the engine is told to show" : "No shot written yet: the picture is made from the idea alone"}>
                              {x.scene?.trim() ? `Shot · ${x.scene.trim().slice(0, 160)}` : `Idea · ${x.brief.slice(0, 160)}`}
                            </span>
                            {p.cast.length > 0 && (
                              <span className="flow-post-people">
                                {(x.people ?? []).map((n) => {
                                  const a = p.cast.find((y) => y.name === n);
                                  return (
                                    <span key={n} className="flow-model-chip small">
                                      {a && portrait(a) ? <img src={portrait(a)!} alt="" /> : null}
                                      {n}
                                      <button type="button" aria-label={`Take ${n} out of post ${x.index}`} title="Take out of this picture" onClick={() => void p.onSavePlan(p.plan.map((y) => (y.index === x.index ? { ...y, people: (y.people ?? []).filter((z) => z !== n) } : y)))}>
                                        <X size={10} />
                                      </button>
                                    </span>
                                  );
                                })}
                                {(x.people ?? []).length < MAX_CAST && p.cast.some((a) => !(x.people ?? []).includes(a.name)) && (
                                  <select
                                    value=""
                                    aria-label={`Add a model to post ${x.index}`}
                                    onChange={(e) => {
                                      const n = e.target.value;
                                      if (n) void p.onSavePlan(p.plan.map((y) => (y.index === x.index ? { ...y, people: [...new Set([...(y.people ?? []), n])] } : y)));
                                    }}
                                  >
                                    <option value="">{(x.people ?? []).length ? "+ model" : "No one in the picture · + model"}</option>
                                    {p.cast
                                      .filter((a) => !(x.people ?? []).includes(a.name))
                                      .map((a) => (
                                        <option key={a.id} value={a.name}>
                                          {a.name}
                                        </option>
                                      ))}
                                  </select>
                                )}
                              </span>
                            )}
                            {older && (
                              <span className="flow-post-flag idea">
                                Made for an older idea: the idea, product or direction changed after this picture was made. It stays under Versions; make it again when you want, the other posts are untouched.
                              </span>
                            )}
                            {o?.status === "blocked" && (
                              <span className="flow-post-flag">
                                {o.why}
                                {(missingProducts.posts.includes(x.index) || /no product/i.test(o.why ?? "")) && (
                                  <button type="button" className="text-button" onClick={() => setSwapTarget(x)}>
                                    Choose a product image
                                  </button>
                                )}
                              </span>
                            )}
                            {o?.status !== "blocked" && !isOpen && o?.changes?.[0] && (
                              <span className="flow-post-flag">
                                {o.changes[0]}
                                {o.changes.length > 1 && (
                                  <button type="button" className="text-button" onClick={() => setOpen(x.index)}>
                                    +{o.changes.length - 1} more
                                  </button>
                                )}
                              </span>
                            )}
                          </span>
                          <span className="flow-post-product">
                            <PostProductCell post={x} products={p.products} sourceUrl={p.sourceUrl} onChoose={setSwapTarget} />
                          </span>
                          <span className="flow-post-out">
                            <span className={`flow-pill ${state.cls}`}>{state.text || kind}</span>
                            <small>{kind}</small>
                            <label className="flow-date" title="The posting day. Changing it moves the post in the month; its number and its pictures stay.">
                              <input type="date" value={x.date ?? ""} onChange={(e) => void p.onSavePlan(p.plan.map((y) => (y.index === x.index ? { ...y, date: e.target.value || undefined } : y)))} />
                            </label>
                          </span>
                          <button type="button" className="text-button" onClick={() => setOpen(isOpen ? null : x.index)}>
                            {isOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />} {isOpen ? "Hide details" : "Details"}
                          </button>
                          {isOpen && (
                            <div className="flow-post-details">
                              <div>
                                <span className="flow-eyebrow">Idea</span>
                                <textarea rows={3} defaultValue={x.brief} onBlur={(e) => e.target.value !== x.brief && void p.onSavePlan(p.plan.map((y) => (y.index === x.index ? { ...y, brief: e.target.value } : y)))} />
                              </div>
                              <div>
                                <span className="flow-eyebrow">Shot</span>
                                <textarea rows={3} defaultValue={x.scene ?? ""} placeholder="Written by the shots writer when empty" onBlur={(e) => (e.target.value || "") !== (x.scene ?? "") && void p.onSavePlan(p.plan.map((y) => (y.index === x.index ? { ...y, scene: e.target.value || undefined } : y)))} />
                              </div>
                              <div>
                                <span className="flow-eyebrow">Words</span>
                                <input defaultValue={x.headline ?? ""} placeholder="Headline on the picture" dir="auto" onBlur={(e) => (e.target.value || "") !== (x.headline ?? "") && void p.onSavePlan(p.plan.map((y) => (y.index === x.index ? { ...y, headline: e.target.value || undefined } : y)))} />
                                <textarea rows={2} defaultValue={x.caption} placeholder="Caption (separate from the words on the picture)" dir="auto" onBlur={(e) => e.target.value !== x.caption && void p.onSavePlan(p.plan.map((y) => (y.index === x.index ? { ...y, caption: e.target.value } : y)))} />
                                <small className="flow-muted">
                                  {o?.reference ? `Follows the ${o.reference}` : "Follows the brief"}
                                  {o?.images ? ` · ${o.images.length} picture${o.images.length === 1 ? "" : "s"} go to the engine (Image 1 to ${o.highestImage || o.images.length})` : ""}
                                  {t && lineageUnknown(t) ? " · this picture was made before lineage was kept (unknown lineage)" : ""}
                                </small>
                              </div>
                              {o?.conflicts?.length ? (
                                <div className={`flow-post-changes conflicts ${o.conflicts.some((c) => !c.allowed) ? "block" : ""}`}>
                                  <span className="flow-eyebrow">{o.conflicts.some((c) => !c.allowed) ? "Inputs disagree · decide before paying" : "Exceptions allowed on this post"}</span>
                                  <ul>
                                    {o.conflicts.map((c, k) => (
                                      <li key={k}>
                                        {c.text}
                                        {c.allowed ? <em> · allowed on this post</em> : null}
                                        {!c.allowed && (
                                          <span className="flow-conflict-actions">
                                            {c.source === "style" && x.style && (
                                              <button type="button" className="text-button" onClick={() => void p.onStyles([{ index: x.index, style: null }]).then(() => loadPreview())} title="Takes the style off this post: its own idea and shot come back">
                                                Take the style off
                                              </button>
                                            )}
                                            <button
                                              type="button"
                                              className="text-button"
                                              onClick={async () => {
                                                const ok = await askConfirm(`Allow ${CONFLICT_LABELS[c.kind]} on post ${x.index} only? The brief's rule stays for every other post; nothing becomes a brand rule.`, { ok: `Allow on post ${x.index}`, danger: false, cancel: "Keep the rule" });
                                                if (!ok) return;
                                                await p.onSavePlan(p.plan.map((y) => (y.index === x.index ? { ...y, allow: [...new Set([...(y.allow ?? []), c.kind])] } : y)));
                                                await loadPreview();
                                              }}
                                            >
                                              Allow on this post
                                            </button>
                                          </span>
                                        )}
                                        {c.allowed && (
                                          <button
                                            type="button"
                                            className="text-button"
                                            onClick={async () => {
                                              await p.onSavePlan(p.plan.map((y) => (y.index === x.index ? { ...y, allow: (y.allow ?? []).filter((k) => k !== c.kind) } : y)));
                                              await loadPreview();
                                            }}
                                          >
                                            Withdraw
                                          </button>
                                        )}
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              ) : null}
                              {o?.guide?.length ? (
                                <details className="flow-guide">
                                  <summary>What will guide this picture</summary>
                                  <ol className="flow-guide-layers">
                                    {o.guide.map((layer) => (
                                      <li key={layer.id}>
                                        <b>{layer.label}</b>
                                        <ul>
                                          {layer.items.map((it, k) => (
                                            <li key={k}>
                                              {it.text} <small className="flow-muted">· {it.from}</small>
                                            </li>
                                          ))}
                                        </ul>
                                      </li>
                                    ))}
                                  </ol>
                                  {x.briefBeforeStyle && x.style ? <small className="flow-muted">Idea before the style: {x.briefBeforeStyle}</small> : null}
                                </details>
                              ) : null}
                              {(o?.changes?.length || (o?.images && o.highestImage && o.highestImage < o.images.length)) ? (
                                <div className="flow-post-changes">
                                  <span className="flow-eyebrow">What changed or was excluded</span>
                                  <ul>
                                    {(o?.changes ?? []).map((ch, k) => (
                                      <li key={k}>{ch}</li>
                                    ))}
                                    {o?.images && o.highestImage && o.highestImage < o.images.length ? <li>The prompt names {o.highestImage} picture{o.highestImage === 1 ? "" : "s"} of the {o.images.length} attached: this engine reads only those.</li> : null}
                                  </ul>
                                </div>
                              ) : null}
                              {o?.status === "ready" && o.paid && (
                                <div className={`flow-post-changes reading ${o.preflight ? "" : "none"}`}>
                                  <span className="flow-eyebrow">Read before paying</span>
                                  {o.preflight ? (
                                    <>
                                      <ul>
                                        {o.preflight.notes.length ? o.preflight.notes.map((n, k) => <li key={k}>{n}</li>) : <li>Nothing to take out: the engine gets the scene as written.</li>}
                                      </ul>
                                      {(o.preflight.dropped || x.keepRef) && (o.reference === "style" || o.reference === "grid tile" || o.reference === "grid" || o.reference === "theme reference") && (
                                        <label className="check-row">
                                          <input type="checkbox" checked={!!x.keepRef} onChange={(e) => void keepReference(x.index, e.target.checked)} />
                                          <span>Keep my reference attached anyway (the {o.reference})</span>
                                        </label>
                                      )}
                                    </>
                                  ) : (
                                    <small className="flow-muted">Not read yet, or the post changed since: the reading runs at Generate, or now with "Read the scenes before paying".</small>
                                  )}
                                </div>
                              )}
                            </div>
                          )}
                        </li>
                      );
                    })}
                </ul>
              </section>
              {p.batchId && p.plan.length > 0 && (
                <section className="flow-testgrid">
                  <TestGrid batchId={p.batchId} plan={p.plan} overlay={p.overlay} logoSrc={p.logoSrc} reference={monthGrid ? styleThumb(monthGrid, true) : null} blocked={blocking(issues).length > 0} onShowIssues={() => toast.error(blocking(issues)[0]?.text ?? "Fix the month's blockers first.")} />
                </section>
              )}
              {onePost !== null ? (
                /* One post from a style: the footer is that post's scope alone, never the month's summary. */
                <footer className="flow-confirm one-post">
                  <div className="flow-confirm-text">
                    <b>
                      1 picture · post {onePost} “{p.plan.find((x) => x.index === onePost)?.title}” · {p.modelName ?? estimate?.model ?? p.model} · {estimate?.size ?? p.size} · about {formatUsd(estimate?.perImage ?? perPicture)}
                    </b>
                    <span className="flow-muted">
                      {taskOf(onePost)?.output ? effectLine("new-version", { kind: "post", index: onePost }) : effectLine("first-image", { kind: "post", index: onePost })} {scopeNote({ kind: "post", index: onePost }, p.plan.length)} List price, an estimate.
                      {outcomeOf(onePost)?.status === "blocked" ? ` Blocked: ${outcomeOf(onePost)?.why}` : ""}
                    </span>
                    <small className="flow-muted">
                      The month's other pictures are not part of this.{" "}
                      <button type="button" className="text-button" onClick={() => setWay(p.config?.gridRef ? "grid" : p.config?.campaign ? "brief" : "refs")} title="Shows the month's own plan and cost instead; the style stays saved on its post">
                        Show the whole month's plan instead
                      </button>
                    </small>
                  </div>
                  <div className="flow-confirm-actions">
                    <button type="button" className="secondary btn-pill" onClick={() => p.onDone()} title="The style stays saved on the post; no picture is made">
                      Save the plan, make nothing
                    </button>
                    <button
                      type="button"
                      className="primary btn-pill"
                      disabled={!p.engineReady || outcomeOf(onePost)?.status === "blocked"}
                      title={scopeNote({ kind: "post", index: onePost }, p.plan.length)}
                      onClick={async () => {
                        const i = onePost;
                        const again = !!taskOf(i)?.output;
                        const scope = confirmScope({ target: { kind: "post", index: i, title: p.plan.find((x) => x.index === i)?.title }, effect: again ? "new-version" : "first-image", cost: estimate?.perImage ?? perPicture, untouched: p.plan.length > 1 ? `the month's other ${p.plan.length - 1} post${p.plan.length === 2 ? "" : "s"}` : undefined });
                        const ok = await askConfirm(scope.message, { ok: scope.ok, danger: false, cancel: "Not now" });
                        if (!ok) return;
                        await p.onGenerateOne(i);
                        p.onDone(i);
                      }}
                    >
                      <BadgeCheck size={14} /> Make post {onePost} · about {formatUsd(estimate?.perImage ?? perPicture)}
                    </button>
                  </div>
                </footer>
              ) : (
                <footer className="flow-confirm">
                  <div className="flow-confirm-text">
                    <b>
                      {preview && !readyPictures && !readyTiles && made > 0
                        ? `Every picture is made (${made}). Nothing to pay for here: edit a post or make another version from the Studio.`
                        : `${readyPictures} picture${readyPictures === 1 ? "" : "s"} · ${p.modelName ?? estimate?.model ?? p.model} · ${estimate?.size ?? p.size} · about ${formatUsd(estimate?.perImage ?? perPicture)} each`}
                    </b>
                    <span className="flow-muted">
                      {readyPictures ? `${readyPictures === counts.pictures ? `The whole month: ${counts.pictures} picture${counts.pictures === 1 ? "" : "s"}` : `${readyPictures} of the month's ${counts.pictures} picture${counts.pictures === 1 ? "" : "s"}`}${counts.existing ? `; the ${counts.existing} made already ${counts.older ? `stay, and the ${counts.older} made for an older idea get another version (the current ones stay under Versions)` : "are untouched"}` : ""}. ` : ""}
                      Estimate {formatUsd(total)}
                      {retakes ? `, at most ${formatUsd(maximum)} if each picture is retaken once by itself after the review` : ", no automatic retakes"}. List prices, an estimate.
                      {blockedList.length ? ` ${blockedList.length} post${blockedList.length === 1 ? "" : "s"} wait: making them later is a new approval, never this one.` : ""}
                      {preview && preview.spend.approved > 0 ? ` Approved so far this month: ${formatUsd(preview.spend.approved)}, ${formatUsd(preview.spend.reserved)} used.` : ""}
                    </span>
                    <label className="check-row">
                      <input type="checkbox" checked={retakes} onChange={(e) => setRetakes(e.target.checked)} />
                      <span>If the review finds a problem, retake the picture once by itself (up to {formatUsd(total)} more, approved now).</span>
                    </label>
                  </div>
                  <div className="flow-confirm-actions">
                    <button type="button" className="secondary btn-pill" onClick={() => p.onDone()} title="Every edit is saved already; no picture is made">
                      Save the plan, make nothing
                    </button>
                    {ready.find((x) => x.paid) && (
                      <button type="button" className="secondary btn-pill" disabled={!p.engineReady} title={`One picture, post ${ready.find((x) => x.paid)!.index} only, to see the look before the rest; the other posts are untouched`} onClick={() => void p.onTest(ready.find((x) => x.paid)!.index)}>
                        Make one test picture · about {formatUsd(estimate?.perImage ?? perPicture)}
                      </button>
                    )}
                    <button
                      type="button"
                      className="primary btn-pill"
                      disabled={!p.engineReady || !readyPictures && !readyTiles}
                      title={readyPictures === counts.pictures ? `The whole month: ${counts.pictures} picture${counts.pictures === 1 ? "" : "s"}` : `${readyPictures} of the month's ${counts.pictures} pictures; the pictures already made stay`}
                      onClick={async () => {
                        const idx = ready.filter((x) => x.paid).map((x) => x.index);
                        const versions = idx.filter((i) => !!taskOf(i)?.output).length;
                        const who = readyPictures === counts.pictures ? `the whole month (${counts.pictures} picture${counts.pictures === 1 ? "" : "s"})` : idx.length <= 8 ? `post${idx.length === 1 ? "" : "s"} ${idx.join(", ")}` : `${idx.length} of the month's ${counts.pictures} posts`;
                        const ok = await askConfirm(
                          `Make ${readyPictures} picture${readyPictures === 1 ? "" : "s"} for ${who}${readyTiles ? ` and draw ${readyTiles} text tile${readyTiles === 1 ? "" : "s"} free` : ""}? ${versions ? `${versions} of them ${versions === 1 ? "is" : "are"} another version of a picture that exists (the current one${versions === 1 ? " stays" : "s stay"} under Versions); the rest are first pictures.` : "First pictures: nothing that exists is replaced."}${counts.existing && readyPictures !== counts.pictures ? ` The ${counts.existing - versions} picture${counts.existing - versions === 1 ? "" : "s"} already made ${counts.existing - versions === 1 ? "is" : "are"} untouched.` : ""} About ${formatUsd(total)}${retakes ? `, at most ${formatUsd(maximum)} with the automatic retakes` : ""} (list prices, an estimate). Blocked posts are left out.`,
                          { ok: `Make ${readyPictures} · about ${formatUsd(total)}`, danger: false, cancel: "Not now" },
                        );
                        if (!ok) return;
                        await p.onGenerate(retakes);
                        p.onDone();
                      }}
                    >
                      <BadgeCheck size={14} /> Make {readyPictures === counts.pictures ? "all" : ""} {readyPictures} picture{readyPictures === 1 ? "" : "s"} · about {formatUsd(total)}
                    </button>
                  </div>
                </footer>
              )}
              {!p.engineReady && (
                <p className="flow-muted">
                  <TriangleAlert size={13} /> No image engine is connected: the plan can be written and edited, but no picture can be made here.
                </p>
              )}
            </>
          )}
        </div>
      </div>

      <input ref={uploadInput} type="file" accept="image/*" multiple hidden onChange={(e) => { const files = [...(e.target.files ?? [])]; e.target.value = ""; if (files.length) void p.onUpload(files); }} />
      <ProductSwap
        open={!!swapTarget}
        onClose={() => setSwapTarget(null)}
        batchId={p.batchId}
        target={swapTarget}
        sourceUrl={p.sourceUrl}
        onChanged={async () => {
          await p.refresh();
          if (stage === 2) await loadPreview();
        }}
      />
      {intake && (
        <MediaIntake
          open
          route={intake.route}
          startTab={intake.tab}
          initialFiles={intake.files}
          clients={p.clients}
          clientId={client?.id ?? null}
          month={p.month}
          batchId={p.batchId}
          posts={p.plan.length}
          admin={admin}
          ensurePlan={p.ensurePlan}
          onClose={() => setIntake(null)}
          onDone={intakeDone}
        />
      )}
      {picking && client && (
        <StyleScreen
          open
          onClose={() => setPicking(null)}
          admin={p.user.role === "admin"}
          forClient={{ id: client.id, name: client.name }}
          pick={
            picking === "grid"
              ? { mode: "feed", tab: "grid", client: client.id, onPick: (_ids, items) => { setPickedGrid(items[0] ?? null); setWay("grid"); setPicking(null); } }
              : { mode: "post", label: styleTarget === "next" ? "The first post" : `Post ${styleTarget}`, onPick: (_ids, items) => { setStartStyle(items[0] ?? null); setPicking(null); } }
          }
        />
      )}
    </div>
  );
}
