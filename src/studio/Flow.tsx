/**
 * The four-stage workflow: Start (one way to begin), Direction (what shapes the pictures), Plan
 * (the plan before anything is paid for), Studio (the month's posts, outside this screen). It
 * replaces the nine-screen journey for admins when the flag is on, over the same month data and
 * the same server routes; nothing here costs money until the plan's own button is pressed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowRight, BadgeCheck, Check, ChevronDown, ChevronUp, FileText, Grid3x3, ImagePlus, Images, MessageSquareText, Moon, Sparkles, Sun, TriangleAlert, Wand2 } from "lucide-react";
import { pickedOccasions } from "@shared/occasions";
import { referenceThumb } from "./PostTools";
import LevelLogo from "@/components/LevelLogo";
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
import { CONFLICT_LABELS, type Conflict, type GuideLayer } from "@shared/conflicts";
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

type Way = "brief" | "grid" | "refs" | "style";
type Stage = 0 | 1 | 2;

/** The four ways to start, each with the same four lines: what it is, what it needs, what it creates, what it controls. */
const WAYS: { key: Way; title: string; desc: string; needs: string; makes: string; controls: string; action: string; icon: React.ReactNode }[] = [
  { key: "brief", title: "Quick Campaign", desc: "Say what you want in your words, typed or spoken: the posts, the products, the look, the text on the pictures.", needs: "a few sentences; reference pictures optional", makes: "a draft of posts to review, then the whole month", controls: "ideas, words, colours, exact references", action: "Plan it", icon: <MessageSquareText size={18} /> },
  { key: "grid", title: "Follow a grid", desc: "A whole feed from the library: one tile per post, its order, its text tiles and fonts.", needs: "one grid from the library", makes: "one post per tile, in the grid's order", controls: "the composition of every post", action: "Pick a grid", icon: <Grid3x3 size={18} /> },
  { key: "refs", title: "Use theme references", desc: "Pins or photos that set the month's look: light, colours, props, camera. Never their objects.", needs: "pins or photos on the theme", makes: "the month's posts in that light and palette", controls: "mood, palette, shot list", action: "Add pins or photos", icon: <Images size={18} /> },
  { key: "style", title: "One post from a style", desc: "One look from the gallery for one post. The style is saved on the post first; making the picture is a separate step you confirm.", needs: "one style and the post it goes on", makes: "that post's idea and shot (its picture is a separate step)", controls: "one post's look and idea", action: "Pick a style", icon: <Sparkles size={18} /> },
];

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
  /** The month's cast (the chosen ambassadors), and the client's whole roster (for the brand chip). */
  cast: Ambassador[];
  ambassadors: Ambassador[];
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
}

const STAGES = ["Start", "Direction", "Plan", "Studio"];

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
  const [way, setWay] = useState<Way>(() => (p.config?.gridRef ? "grid" : p.config?.campaign ? "brief" : "brief"));
  const client = p.client;
  const theme = p.themes.find((t) => t.id === p.themeId) ?? null;
  const shape = planShape(p.plan);
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
  const [styleTarget, setStyleTarget] = useState<number | "next" | null>(() => (p.plan.length ? null : "next"));
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
      }),
    [p.config, client, theme, p.products, p.cast],
  );
  const outcomeOf = (index: number) => preview?.posts.find((x) => x.index === index);
  const ready = preview?.posts.filter((x) => x.status === "ready") ?? [];
  const readyPictures = ready.filter((x) => x.paid).length;
  const readyTiles = ready.filter((x) => !x.paid).length;
  const made = preview?.posts.filter((x) => x.status === "made").length ?? 0;
  const blockedList = preview?.blocked ?? [];
  const estimate = preview?.estimate;
  const total = estimate ? estimate.total : readyPictures * perPicture;
  const maximum = retakes ? total * (1 + (estimate?.retakes ?? 1)) : total;
  // A blocked post is listed once, from the preview; the same finding from the issues list is left out.
  const blockedIdx = new Set(blockedList.map((b) => b.index));
  const attention = [...blocking(issues), ...issues.filter((x) => x.warn)].filter((x) => !(x.post && blockedIdx.has(x.post)));
  const taskOf = (index: number) => p.tasks.find((t) => t.post === index) ?? null;

  /* ── Direction: colours ── */
  const palette = p.config?.palette?.length ? p.config.palette : (theme?.palette ?? []);
  const paletteFrom = p.config?.palette?.length ? (p.config.paletteFrom === "brief" ? "from the brief" : p.config.paletteFrom === "grid" ? "from the grid" : "set by you") : theme ? `the theme "${theme.title}"` : "the brand colours";
  const [editColours, setEditColours] = useState(false);
  const [colourDraft, setColourDraft] = useState<{ name: string; hex: string }[]>([]);
  const [alsoTheme, setAlsoTheme] = useState(false);
  const [savingColours, setSavingColours] = useState(false);
  const [refsOpen, setRefsOpen] = useState(false);
  const uploadInput = useRef<HTMLInputElement>(null);
  async function saveColours() {
    if (!p.batchId) return;
    setSavingColours(true);
    try {
      const r = await post<{ palette: { name: string; hex: string }[]; theme?: { updated: boolean; months: number } }>("/api/studio/posts/palette", {
        batch: p.batchId,
        palette: colourDraft.filter((c) => /^#[0-9a-fA-F]{6}$/.test(c.hex)),
        theme: alsoTheme || undefined,
      });
      await p.refresh();
      setEditColours(false);
      toast.success(r.theme?.updated ? `Colours saved for this month and the theme (${r.theme.months} month${r.theme.months === 1 ? "" : "s"} follow it).` : "Colours saved for this month only.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingColours(false);
    }
  }
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

  return (
    <div className="journey flow" role="dialog" aria-modal="true" aria-label="Create content">
      <header className="journey-top">
        <LevelLogo className="journey-logo" />
        <nav className="flow-rail" aria-label="Stages">
          {STAGES.map((s, i) => (
            <button key={s} type="button" className={`flow-stage ${i === stage ? "now" : i < stage ? "done" : ""}`} disabled={i > stage && !(i === 2 && p.plan.length) && i !== 3} onClick={() => (i === 3 ? p.onDone() : setStage(i as Stage))}>
              <span className="flow-stage-n">{i + 1}</span> {s}
            </button>
          ))}
        </nav>
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
                  <p>Choose one way to start. Supporting inputs can be added on the next screen, and nothing costs money until the plan is approved.</p>
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
              <div className="flow-ways" role="radiogroup" aria-label="Start with">
                {WAYS.map((w) => (
                  <button key={w.key} type="button" role="radio" aria-checked={way === w.key} className={`flow-way ${way === w.key ? "on" : ""}`} onClick={() => setWay(w.key)}>
                    <span className="flow-way-check" aria-hidden>
                      <Check size={12} />
                    </span>
                    <span className="flow-way-art" aria-hidden>
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
                      {w.key === "refs" && (
                        <span className="flow-art-refs">
                          {(daily?.refs.length ? daily.refs.map((s) => styleThumb(s)) : p.themeRefs.length ? p.themeRefs.slice(0, 3).map((r) => `/api/studio/references/${r.id}/file`) : p.products.slice(0, 3).map((s) => p.sourceUrl(s.id))).map((src, i) => (
                            <img key={i} src={src} alt="" style={{ left: 14 + i * 70, top: [14, 8, 18][i], transform: `rotate(${[-4, 2, 5][i]}deg)` }} />
                          ))}
                        </span>
                      )}
                      {w.key === "style" && (
                        <span className="flow-art-style">
                          {startStyle ? <img src={styleThumb(startStyle)} alt="" /> : daily?.style ? <img src={styleThumb(daily.style)} alt="" /> : p.products[0] ? <img src={p.sourceUrl(p.products[0].id)} alt="" /> : <span className="flow-art-tile" />}
                          <span className="flow-art-label">{startStyle?.title ?? "A look from the gallery"}</span>
                        </span>
                      )}
                    </span>
                    <strong>{w.title}</strong>
                    <span className="flow-way-desc">{w.desc}</span>
                    <dl className="flow-way-facts">
                      <dt>Needs</dt>
                      <dd>{w.needs}</dd>
                      <dt>Creates</dt>
                      <dd>{w.makes}</dd>
                      <dt>Controls</dt>
                      <dd>{w.controls}</dd>
                    </dl>
                    <span className="flow-way-foot">
                      <span className={`flow-way-action ${way === w.key ? "on" : ""}`}>
                        {w.icon} {w.action}
                      </span>
                      {w.key === "brief" && <span className="flow-way-rec">Most months start here</span>}
                    </span>
                  </button>
                ))}
              </div>
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
                            ? "No posts yet: the plan is written first, and the style goes on its first post."
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
                <span className="flow-muted">Starting with {WAYS.find((w) => w.key === way)?.title.toLowerCase()}. You can change this until the plan is approved.</span>
                <button type="button" className="primary btn-pill" disabled={moving || planning} onClick={() => void toDirection()}>
                  {moving || planning ? <Orb size={14} /> : <ArrowRight size={14} />} Continue to Direction
                </button>
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
                    <span className="flow-pill dark">{WAYS.find((w) => w.key === way)?.title}</span>
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
                          </span>
                        </li>
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
                      </ul>
                    );
                  })()}
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
                  <section className="journey-box flow-box">
                    <span className="flow-eyebrow">Colours</span>
                    {!editColours ? (
                      <>
                        <div className="flow-swatches">
                          {palette.map((c, i) => (
                            <span key={i} className="flow-swatch" style={{ background: c.hex }} title={`${c.name} ${c.hex}`} />
                          ))}
                          {!palette.length && <small className="flow-muted">No colours yet: the brand colours are used.</small>}
                        </div>
                        <small className="flow-muted">
                          {p.config?.palette?.length ? `This month only, ${paletteFrom}. The theme keeps its own palette.` : `From ${paletteFrom}, shared by every month on it.`}
                        </small>
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => {
                            setColourDraft(palette.length ? palette.map((c) => ({ ...c })) : [{ name: "", hex: "#" }]);
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
                        <label className="check-row">
                          <input type="checkbox" checked={alsoTheme} onChange={(e) => setAlsoTheme(e.target.checked)} disabled={!theme} />
                          <span>
                            Also update the theme {theme ? `"${theme.title}"` : ""} {theme?.months ? `(${theme.months} month${theme.months === 1 ? "" : "s"} follow it)` : ""}. Off: this month only.
                          </span>
                        </label>
                        <div className="flow-pick-row">
                          <button type="button" className="primary btn-pill" disabled={savingColours} onClick={() => void saveColours()}>
                            {savingColours ? <Orb size={14} /> : <Check size={14} />} Save colours
                          </button>
                          <button type="button" className="text-button" onClick={() => setEditColours(false)}>
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
                  {WAYS.find((w) => w.key === way)?.title} leads · {pinned} pinned · colours {p.config?.palette?.length ? "for this month only" : "from the theme"} · {p.products.length} product photo{p.products.length === 1 ? "" : "s"}
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
                    const ok = await askConfirm(`Write the month's ${p.plan.length} ideas again? The current posts, their words and pictures are kept under Versions; pictures already made are not remade until you ask.`, { ok: "Write them again", danger: false, cancel: "Keep these ideas" });
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
                  engineReady={p.engineReady}
                  refresh={async () => {
                    await p.refresh();
                    await loadPreview();
                  }}
                  onNotes={p.onNotes}
                  onMake={async (indexes) => {
                    const ok = await askConfirm(`The changes are saved. Make post${indexes.length > 1 ? "s" : ""} ${indexes.join(", ")} now, about ${formatUsd((estimate?.perImage ?? perPicture) * indexes.length)}?`, { ok: `Make ${indexes.length} · about ${formatUsd((estimate?.perImage ?? perPicture) * indexes.length)}`, cancel: "Keep the changes, make them later", danger: false });
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
                      const shown = p.plan.filter((x) => x.type !== "greeting" && x.type !== "offer" && !["text", "texture", "place"].includes(x.tileSpec?.kind ?? ""));
                      const without = shown.filter((x) => !productOf(x, p.products)).length;
                      return `${p.products.length} product photo${p.products.length === 1 ? "" : "s"} · ${shown.length - without} of ${shown.length} post${shown.length === 1 ? "" : "s"} have theirs${without ? ` · ${without} without` : ""}`;
                    })()}
                    {blockedList.length ? ` · ${blockedList.length} post${blockedList.length === 1 ? "" : "s"} waiting` : ""}
                  </small>
                </div>
                <div className="flow-sum-cell">
                  <span className="flow-eyebrow">Direction</span>
                  <p>
                    <b>{WAYS.find((w) => w.key === way)?.title} leads</b> · {pinned} pinned · {p.config?.gridRef ? "grid" : "no grid"} · colours {p.config?.palette?.length ? "this month only" : "from the theme"}
                  </p>
                  <button type="button" className="text-button" onClick={() => setStage(1)}>
                    Change
                  </button>
                </div>
                {way === "style" && typeof styleTarget === "number" && p.plan.some((x) => x.index === styleTarget) && (
                  <div className="flow-sum-cell scope">
                    <span className="flow-eyebrow">This operation</span>
                    <p>
                      <b>One post from a style · post {styleTarget}</b>
                    </p>
                    <small>
                      {taskOf(styleTarget as number)?.output ? "Another version of its picture" : "Its picture"} · about {formatUsd(estimate?.perImage ?? perPicture)}. The whole-month figures beside are a separate summary.
                    </small>
                  </div>
                )}
                <div className="flow-sum-cell">
                  <span className="flow-eyebrow">Output</span>
                  {(() => {
                    const groups = new Map<string, number>();
                    for (const x of p.plan) if (x.group) groups.set(x.group.id, (groups.get(x.group.id) ?? 0) + 1);
                    const posts = p.plan.filter((x) => !x.group).length + groups.size;
                    const tiles = p.plan.filter((x) => x.tileSpec?.kind === "text" && !x.product).length;
                    const carousels = [...groups.values()];
                    const shapeOf = carousels.length ? (carousels.length === 1 ? `, one a ${carousels[0]}-slide carousel` : `, ${carousels.length} carousels (${carousels.join(", ")} slides)`) : "";
                    return (
                      <>
                        <p>
                          <b>{posts} post{posts === 1 ? "" : "s"}</b>
                          {shapeOf} = <b>{p.plan.length} design{p.plan.length === 1 ? "" : "s"}</b>
                        </p>
                        <small>
                          {p.plan.length - tiles} picture{p.plan.length - tiles === 1 ? "" : "s"} to make{tiles ? ` · ${tiles} text tile${tiles === 1 ? "" : "s"} drawn here, free` : ""} · {p.format}
                          {preview && (made || blockedList.length) ? ` · ${made} made already${blockedList.length ? ` · ${blockedList.length} blocked` : ""}` : ""}
                        </small>
                      </>
                    );
                  })()}
                </div>
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
                      return (
                        <li key={x.index} className={isOpen ? "open" : ""}>
                          <span className="flow-post-n">{String(x.index).padStart(2, "0")}</span>
                          <span className="flow-post-thumb">{t?.output ? <img src={p.outputThumb(t)} alt="" /> : <span className="flow-post-blank" />}</span>
                          <span className="flow-post-main">
                            <b>{x.title}</b>
                            <span className="flow-muted">{(x.scene?.trim() || x.brief).slice(0, 160)}</span>
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
              <footer className="flow-confirm">
                <div className="flow-confirm-text">
                  <b>
                    {way === "style" && typeof styleTarget === "number" && p.plan.some((x) => x.index === styleTarget)
                      ? `1 picture · post ${styleTarget}${taskOf(styleTarget)?.output ? ", another version of its picture" : ""} · ${p.modelName ?? estimate?.model ?? p.model} · ${estimate?.size ?? p.size} · about ${formatUsd(estimate?.perImage ?? perPicture)}`
                      : preview && !readyPictures && !readyTiles && made > 0
                        ? `Every post is made (${made}). Nothing to pay for here: edit a post or make another version from the Studio.`
                        : `${readyPictures} picture${readyPictures === 1 ? "" : "s"} · ${p.modelName ?? estimate?.model ?? p.model} · ${estimate?.size ?? p.size} · about ${formatUsd(estimate?.perImage ?? perPicture)} each`}
                  </b>
                  {way === "style" && typeof styleTarget === "number" && p.plan.some((x) => x.index === styleTarget) && (
                    <span className="flow-muted">Only post {styleTarget} changes. Its current picture stays under Versions; the month's other posts are untouched. The whole-month figures above are a separate summary.</span>
                  )}
                  <span className="flow-muted">
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
                  <button type="button" className="secondary btn-pill" onClick={() => p.onDone()}>
                    Save the plan, make nothing
                  </button>
                  {way === "style" && typeof styleTarget === "number" && p.plan.some((x) => x.index === styleTarget) && (
                    <button
                      type="button"
                      className="primary btn-pill"
                      disabled={!p.engineReady || outcomeOf(styleTarget as number)?.status === "blocked"}
                      title="Only this post's picture; the other posts are untouched"
                      onClick={async () => {
                        const i = styleTarget as number;
                        const again = !!taskOf(i)?.output;
                        const ok = await askConfirm(`${again ? "Make another version of" : "Make"} post ${i}'s picture: about ${formatUsd(estimate?.perImage ?? perPicture)} (list price, an estimate). Nothing else is made.`, { ok: `Make post ${i} · about ${formatUsd(estimate?.perImage ?? perPicture)}`, danger: false, cancel: "Not now" });
                        if (!ok) return;
                        await p.onGenerateOne(i);
                        p.onDone(i);
                      }}
                    >
                      <BadgeCheck size={14} /> Make post {styleTarget} · about {formatUsd(estimate?.perImage ?? perPicture)}
                    </button>
                  )}
                  {ready.find((x) => x.paid) && (
                    <button type="button" className="secondary btn-pill" disabled={!p.engineReady} onClick={() => void p.onTest(ready.find((x) => x.paid)!.index)}>
                      Make one test picture · about {formatUsd(estimate?.perImage ?? perPicture)}
                    </button>
                  )}
                  <button
                    type="button"
                    className={`${way === "style" && styleTarget !== "next" ? "secondary" : "primary"} btn-pill`}
                    disabled={!p.engineReady || !readyPictures && !readyTiles}
                    onClick={async () => {
                      const ok = await askConfirm(
                        `Make ${readyPictures} picture${readyPictures === 1 ? "" : "s"}${readyTiles ? ` and draw ${readyTiles} text tile${readyTiles === 1 ? "" : "s"}` : ""}: about ${formatUsd(total)}${retakes ? `, at most ${formatUsd(maximum)} with the automatic retakes` : ""} (list prices, an estimate). Blocked posts are left out.`,
                        { ok: `Make ${readyPictures} · about ${formatUsd(total)}`, danger: false, cancel: "Not now" },
                      );
                      if (!ok) return;
                      await p.onGenerate(retakes);
                      p.onDone();
                    }}
                  >
                    <BadgeCheck size={14} /> Make all {readyPictures} picture{readyPictures === 1 ? "" : "s"} · about {formatUsd(total)}
                  </button>
                </div>
              </footer>
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
