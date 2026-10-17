import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  BadgeCheck,
  Check,
  FlaskConical,
  Grid3x3,
  HardDrive,
  Images,
  ImagePlus,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  Repeat,
  Sparkles,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import { del, get, post, postForm, put } from "@/api";
import LevelLogo from "@/components/LevelLogo";
import { applyTheme, currentTheme } from "@/theme";
import { askConfirm, askInput } from "@/lib/confirm";
import { confetti } from "@/lib/celebrate";
import type { Ambassador, Client, GalleryItem, QA, Source, Theme, User } from "@shared/types";
import type { BriefNote, BriefStep, Config } from "@shared/config";
import {
  FORMATS,
  FORMAT_INFO,
  MAX_POST_COUNT,
  monthLabel,
  offerReady,
  POST_TYPE_INFO,
  POST_TYPES,
  withoutBags,
  withoutLettering,
  withoutPaletteText,
  type Format,
  type Post,
} from "@shared/posts";
import { occasionsOf, pickedOccasions, shortDate, spreadDates, type MonthOccasions } from "@shared/occasions";
import { briefLines, FOREIGN_ITEMS } from "@shared/brief";
import { fixNote, postProblems, type PostProblem } from "@shared/qa";
import type { StyleItem } from "@shared/styles";
import StyleScreen, { styleThumb, useStyleInfo } from "./StyleGallery";
import DrivePicker from "./DrivePicker";
import ProductSwap, { RecommendedProducts } from "./ProductSwap";
import TestGrid from "./TestGrid";
import { NO_PRODUCT_TILES } from "@shared/drive";
import { BrandKit, ThemeSection } from "./BrandPanel";
import Ambassadors from "./Ambassadors";
import { displayName } from "./PlanView";
import { KitIcon, type KitKey } from "./kit";
import { ProfileBar } from "./ClientProfile";
import { CaptionsStep, captionCurrent, FeedStep, MAKING, MakeStep, type JourneyPost } from "./JourneyResults";
import type { OverlaySpec } from "@shared/overlay";

type ThemesReply = { themes: Theme[] };

const STEPS: { key: string; kit?: KitKey; title: string; brief?: BriefStep }[] = [
  { key: "client", title: "Account" },
  { key: "products", kit: "references", title: "Products", brief: "products" },
  { key: "count", kit: "output", title: "Posts", brief: "count" },
  { key: "brand", kit: "brand", title: "Brand kit", brief: "brand" },
  { key: "identity", kit: "identity", title: "Visual identity", brief: "theme" },
  { key: "colours", kit: "colours", title: "Colours", brief: "colours" },
  { key: "ideas", kit: "voice", title: "Ideas and dates" },
  { key: "scene", kit: "shots", title: "Props and shots", brief: "shots" },
  { key: "magic", kit: "theme", title: "Test grid" },
  // After Generate the journey stays: the images arrive, then their captions, then the feed.
  { key: "make", kit: "output", title: "Generate" },
  { key: "captions", kit: "voice", title: "Captions" },
  { key: "feed", kit: "output", title: "Feed" },
];
const MAGIC = STEPS.findIndex((s) => s.key === "magic");

const RESUME_KEY = "lsm-journey-step";

function greeting(d = new Date()): string {
  const h = d.getHours();
  return h >= 5 && h < 12 ? "Good morning" : h >= 12 && h < 17 ? "Good afternoon" : "Good evening";
}

function firstName(user: User): string {
  const n = (user.name || user.email.split("@")[0] || "").trim().split(/\s+/)[0] ?? "";
  return n ? n[0].toUpperCase() + n.slice(1) : "";
}

/** A number that counts up to its value (the magic screen's post count). */
function useCountUp(target: number, ms = 900): number {
  const [n, setN] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return setN(target);
    const start = performance.now();
    let raf = 0;
    const tick = (t: number) => {
      const k = Math.min(1, (t - start) / ms);
      setN(Math.round(target * (1 - Math.pow(1 - k, 3))));
      if (k < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms]);
  return n;
}

/** A short stable fingerprint of a text (what the month's shots were written from). */
function hash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  return `${text.length.toString(36)}-${h.toString(36)}`;
}

function nextMonth(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
}

function thisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

function readResume(): { client: string; month: string; step: number } | null {
  try {
    const v = JSON.parse(localStorage.getItem(RESUME_KEY) ?? "null") as { client: string; month: string; step: number } | null;
    return v && typeof v.step === "number" ? v : null;
  } catch {
    return null;
  }
}

export interface TestPost {
  index: number;
  status: string;
  url: string | null;
  error: string | null;
  qa: QA | null;
  /** Made at 1K: the approved test is made again at the month's size with the rest. */
  draft: boolean;
}

export interface JourneyProps {
  user: User;
  clients: Client[];
  clientId: string;
  onClient: (id: string) => void;
  onClientsChanged: (clients: Client[]) => void;
  month: string;
  onMonth: (m: string) => void;
  batchId: string | null;
  config: Config | null;
  /** The client's last month before this one, when this month has no plan yet. */
  previousMonth: string | null;
  onContinue: () => Promise<void>;
  continuing: boolean;
  ensurePlan: () => Promise<string>;
  refresh: () => Promise<void>;
  products: Source[];
  sourceUrl: (id: string) => string;
  onUpload: (files: File[]) => Promise<void>;
  onRemoveProduct: (id: string) => void;
  uploading: boolean;
  postCount: number;
  format: Format;
  onSettings: (patch: {
    postCount?: number;
    exact?: boolean;
    format?: Format;
    shots?: string[];
    gridRef?: string | null;
    monthFonts?: { headline: string; body: string } | null;
    occasions?: { picked: string[]; custom: NonNullable<MonthOccasions["custom"]> };
  }) => void;
  themes: Theme[];
  themeId: string;
  onTheme: (id: string) => void;
  onThemesChanged: (themes: Theme[]) => void;
  ambassadors: Ambassador[];
  onAmbassadorsChanged: (list: Ambassador[]) => void;
  cast: string[];
  onCast: (ids: string[]) => void;
  plan: Post[];
  onGenerateIdeas: () => Promise<boolean>;
  onSavePlan: (plan: Post[]) => void;
  ideasBusy: boolean;
  /** A single post is being written again (its type changed or its offer was filled). */
  rewriting: boolean;
  onRewrite: (index: number, plan: Post[]) => void;
  /** Gallery styles for posts, each written for its post's product (null takes it off). */
  onStyles: (assign: { index: number; style: string | null }[]) => Promise<void>;
  onGenerate: () => Promise<void>;
  /** The post tested before the month is generated, with its image and its review. */
  testPost: TestPost | null;
  onTest: (index: number) => Promise<void>;
  onFixTest: (edit: string) => Promise<void>;
  onDone: () => void;
  /** Styles and grids waiting for the admin's approval, and a nudge when the admin decided some. */
  pendingStyles?: number;
  onPendingChange?: () => void;
  /** An image engine is connected (Generate would otherwise fail). */
  engineReady: boolean;
  /** Every post's image and review, once Generate has started. */
  posts: JourneyPost[];
  onRetake: (index: number) => Promise<void>;
  onFix: (index: number, edit: string) => Promise<void>;
  onShare: () => Promise<void>;
  onExport: () => Promise<void>;
  overlay: OverlaySpec;
  logoSrc: string | null;
}

/**
 * The start of a working session, taken like a creative brief: one decision per screen, every
 * screen read and summed up ("what I understood"), and that understanding becomes the rules the
 * month's ideas follow. The last screen starts the generation; the studio is for edits after.
 */
export default function Journey(p: JourneyProps) {
  const active = p.clients.filter((c) => c.status === "active");
  const client = active.find((c) => c.id === p.clientId) ?? null;
  const theme = p.themes.find((t) => t.id === p.themeId) ?? null;
  const [approving, setApproving] = useState(false);
  const [step, setStep] = useState(() => {
    const r = readResume();
    return r && r.client === p.clientId && r.month === p.month ? Math.min(r.step, STEPS.length - 1) : 0;
  });
  const [moving, setMoving] = useState(false);
  /** Next already fixed this screen once by itself; set back on every screen. */
  const [autoTried, setAutoTried] = useState(false);
  const [autoNext, setAutoNext] = useState(false);
  const key = STEPS[step].key;
  const last = step === STEPS.length - 1;

  // The journey is always light, whatever the studio uses; the studio's choice comes back after.
  useEffect(() => {
    applyTheme("light", false);
    // The studio behind the journey never scrolls under it.
    const html = document.documentElement;
    const before = html.style.overflow;
    html.style.overflow = "hidden";
    return () => {
      html.style.overflow = before;
      applyTheme(currentTheme(), false);
    };
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(RESUME_KEY, JSON.stringify({ client: p.clientId, month: p.month, step }));
    } catch {
      /* private mode */
    }
  }, [step, p.clientId, p.month]);

  /* ── The brief: one analysis per screen, run when the screen's content changes ── */
  const [briefBusy, setBriefBusy] = useState<BriefStep | "">("");
  const [briefError, setBriefError] = useState<Partial<Record<BriefStep, string>>>({});
  const [showIssues, setShowIssues] = useState(false);
  const [fixing, setFixing] = useState("");
  const [adapting, setAdapting] = useState(false);
  const [reading, setReading] = useState(false);
  const brief = p.config?.brief ?? {};
  const seen = useRef<Partial<Record<BriefStep, string>>>({});
  const runBrief = useCallback(
    async (s: BriefStep) => {
      if (!p.batchId) return;
      setBriefBusy(s);
      try {
        await post("/api/studio/posts/brief", { batch: p.batchId, step: s });
        await p.refresh();
        setBriefError((m) => ({ ...m, [s]: undefined }));
      } catch (e) {
        setBriefError((m) => ({ ...m, [s]: (e as Error).message }));
      } finally {
        setBriefBusy("");
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.batchId, p.refresh],
  );
  const productIds = p.products.map((s) => s.id).join(",");
  const signature: Partial<Record<BriefStep, string>> = {
    products: `${productIds}|${client?.service ?? ""}`,
    count: `${p.postCount}:${p.month}:${JSON.stringify(p.config?.occasions?.picked ?? [])}:${(p.config?.occasions?.custom ?? []).length}`,
    brand: String(client?.updated ?? ""),
    // The theme's world (its pins and their reading), not its props: props belong to the shots.
    theme: `${p.themeId}:${theme?.analysed ?? ""}:${theme?.latestRef ?? ""}:${theme?.references ?? ""}:${p.cast.join(",")}`,
    colours: `${JSON.stringify(theme?.palette ?? [])}:${productIds}`,
    shots: `${p.plan.map((x) => x.scene ?? "").join("|")}:${theme?.props ?? ""}`,
  };
  const stepBrief = STEPS[step].brief;
  const sig = stepBrief ? signature[stepBrief] : undefined;
  useEffect(() => {
    if (!stepBrief || !p.batchId || briefBusy) return;
    // The shots are read once they are written for this month's products.
    if (stepBrief === "shots" && (adapting || !p.plan.some((x) => x.scene)) && theme?.shots.length) return;
    const note = brief[stepBrief];
    const before = seen.current[stepBrief];
    if (note && before === undefined) {
      seen.current[stepBrief] = sig;
      return;
    }
    if (note && before === sig) return;
    if (stepBrief === "products" && !p.products.length && !client?.service?.trim()) return;
    const t = setTimeout(
      () => {
        seen.current[stepBrief] = sig;
        void runBrief(stepBrief);
      },
      note ? 1500 : 300,
    );
    return () => clearTimeout(t);
    // briefBusy too: a change made while a reading ran is read once that reading ends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepBrief, sig, p.batchId, !!(stepBrief && brief[stepBrief]), adapting, briefBusy]);

  // A month that follows a grid from the library: its ideas carry a tile each and its shots come from them.
  const gridMonth = !!p.config?.gridRef && p.plan.some((x) => x.tile);

  /* ── The pins' shots rewritten for this month's products and colours ── */
  // One shot per post: written again when the posts, the pins, the colours or the props change.
  const planSig = JSON.stringify(
    p.plan.map((x) => [x.index, x.type, x.product, x.products, x.occasion, x.people, x.brief, x.offer?.products, x.tile]),
  );
  const shotsSig = hash(
    `v3|${p.themeId}|${p.config?.gridRef ?? ""}|${(theme?.shots ?? []).join("|")}|${planSig}|${JSON.stringify(theme?.palette ?? [])}|${theme?.props ?? ""}`,
  );
  const adaptedFor = useRef("");
  const adaptShots = useCallback(
    async (force = false) => {
      // Styled posts are rewritten from their styles even when the theme has no pin shots.
      if (!p.batchId || !p.plan.length || (!theme?.shots.length && !gridMonth && !p.plan.some((x) => x.style))) return;
      if (!force && adaptedFor.current === shotsSig) return;
      adaptedFor.current = shotsSig;
      setAdapting(true);
      try {
        await post("/api/studio/posts/shots", { batch: p.batchId, sig: shotsSig, all: force || undefined });
        await p.refresh();
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setAdapting(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.batchId, theme?.shots, gridMonth, shotsSig, p.refresh],
  );
  useEffect(() => {
    if (key !== "scene" || !p.config || reading) return;
    if (p.plan.every((x) => x.scene) && p.config.shotsFor === shotsSig) return;
    void adaptShots();
  }, [key, shotsSig, p.config?.shotsFor, reading]); // eslint-disable-line react-hooks/exhaustive-deps

  /* ── Captions, written from the finished pictures ── */
  const [captionsWriting, setCaptionsWriting] = useState<number[]>([]);
  const [captionsFailed, setCaptionsFailed] = useState<number[]>([]);
  const writeCaptions = useCallback(
    async (indexes?: number[], force = false) => {
      if (!p.batchId) return;
      const due = indexes ?? p.plan.filter((x) => !captionCurrent(x, p.posts.find((j) => j.index === x.index))).map((x) => x.index);
      if (!due.length) return;
      setCaptionsWriting(due);
      try {
        const r = await post<{ written: number[]; failed: number[] }>("/api/studio/posts/captions", {
          batch: p.batchId,
          indexes: due,
          force: force || undefined,
        });
        setCaptionsFailed((f) => [...f.filter((i) => !due.includes(i)), ...r.failed]);
        await p.refresh();
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setCaptionsWriting([]);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.batchId, p.plan, p.posts, p.refresh],
  );
  // On the captions screen, every caption older than its picture is written once by itself.
  const staleCaptions = p.plan
    .filter((x) => !captionCurrent(x, p.posts.find((j) => j.index === x.index)))
    .map((x) => `${x.index}:${p.posts.find((j) => j.index === x.index)?.output ?? ""}`)
    .join(",");
  const captionsTried = useRef("");
  useEffect(() => {
    if (key !== "captions" || !staleCaptions || captionsWriting.length || captionsTried.current === staleCaptions) return;
    captionsTried.current = staleCaptions;
    void writeCaptions();
  }, [key, staleCaptions, captionsWriting.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const started = p.posts.some((x) => x.status !== "none");

  /* ── Reading the pins (theme analysis) before colours and shots ── */
  async function readReferences(force = false) {
    if (!theme || !theme.references) return;
    if (!force && theme.shots.length && theme.palette.length) return;
    setReading(true);
    try {
      const r = await post<ThemesReply>(`/api/studio/posts/themes/${theme.id}/analyze`);
      p.onThemesChanged(r.themes);
      if (force) toast.success("Pins read again: shots and visual language rewritten.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setReading(false);
    }
  }

  /** A new client: named here, its logo and brand kit filled on the next screens. */
  async function newClient() {
    const name = await askInput("Account name", "", { ok: "Create", placeholder: "Client or brand name" });
    if (!name?.trim()) return;
    try {
      const before = new Set(p.clients.map((c) => c.id));
      const r = await post<{ clients: Client[] }>("/api/studio/clients", { name: name.trim() });
      p.onClientsChanged(r.clients);
      const made = r.clients.find((c) => !before.has(c.id));
      if (made) p.onClient(made.id);
      toast.success(`${name.trim()} created. Next: its products, then its logo and brand kit.`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  /** An admin removes an account: archived when it has months (an admin can restore it), deleted otherwise. */
  async function removeClient(c: Client) {
    const ok = await askConfirm(
      c.batches
        ? `Remove ${c.name} from the accounts? Its ${c.batches} month${c.batches > 1 ? "s stay" : " stays"} saved and an admin can restore it from the sidebar.`
        : `Delete ${c.name}? It has no months yet.`,
      { ok: "Remove" },
    );
    if (!ok) return;
    try {
      const r = await del<{ clients: Client[] }>(`/api/studio/clients/${encodeURIComponent(c.id)}`);
      p.onClientsChanged(r.clients);
      if (c.id === p.clientId) {
        const nextClient = r.clients.find((x) => x.status === "active" && x.id !== c.id);
        if (nextClient) p.onClient(nextClient.id);
      }
      toast.success(`${c.name} removed.`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  /* ── The checklist: Next opens only when the screen is complete and current ── */
  type Issue = {
    text: string;
    how?: string;
    warn?: boolean;
    fix?: { label: string; run: () => void | Promise<void> };
    /** A post's own problem: fixed with the others in one go, and never holds the journey once tried. */
    problem?: PostProblem;
  };
  const go = (k: string) => () => setStep(Math.max(0, STEPS.findIndex((x) => x.key === k)));
  const castPeople = p.ambassadors.filter((a) => p.cast.includes(a.id));
  const productNames = p.products.map((x) => displayName(x.name));
  const sellsDrinks = p.products.some((x) => FOREIGN_ITEMS.test(`${x.note ?? ""} ${x.category ?? ""}`));
  const analysedAt = theme ? (theme.analysed ?? (theme.shots.length ? theme.updated : 0)) : 0;
  const briefAt = Math.max(
    0,
    ...Object.entries(p.config?.brief ?? {})
      .filter(([k]) => k !== "shots")
      .map(([, n]) => n?.at ?? 0),
  );
  const plannedAt = p.config?.plannedAt ?? 0;

  /** The month follows a grid: its colours become the month's colours (the pins' are left aside). */
  async function pickGrid(gridRef: string) {
    p.onSettings({ gridRef });
    if (!theme) return;
    try {
      const r = await post<ThemesReply>(`/api/studio/posts/themes/${theme.id}/palette`, { grid: gridRef });
      p.onThemesChanged(r.themes);
      toast.success("The month's colours now come from the grid you chose. Change any of them on the Colours screen.");
    } catch (e) {
      toast.error(`Colours: ${(e as Error).message}`);
    }
  }

  /**
   * Fixes posts in one go, each from the stored plan: bag sentences are taken out on the spot, the
   * posts to write again are written, then every touched shot is written again.
   */
  async function fixPosts(list: PostProblem[]) {
    if (!p.batchId || !list.length) return;
    // Fixes that need no writing: bag sentences out, named products into the picture.
    const unbag = new Set(list.filter((x) => x.fix === "unbag").map((x) => x.index));
    const blank = new Set(list.filter((x) => x.fix === "blank").map((x) => x.index));
    const include = new Map<number, string[]>();
    for (const x of list) if (x.fix === "include" && x.products) include.set(x.index, [...(include.get(x.index) ?? []), ...x.products]);
    if (unbag.size || include.size || blank.size) {
      const plan = p.plan.map((x) => {
        let y = x;
        if (unbag.has(x.index)) y = { ...y, brief: withoutBags(y.brief) || y.brief, ...(y.scene ? { scene: withoutBags(y.scene) || y.scene } : {}) };
        if (blank.has(x.index)) y = { ...y, brief: withoutLettering(y.brief), ...(y.scene ? { scene: withoutLettering(y.scene) } : {}) };
        const add = include.get(x.index);
        if (add) y = { ...y, products: [...new Set([...(y.products ?? []), ...add])] };
        return y;
      });
      await put("/api/studio/posts/plan", { batch: p.batchId, plan });
    }
    // A person with nothing in hand: the best-fitting products are put in the hands (one go for all).
    if (list.some((x) => x.fix === "product")) await post("/api/studio/posts/products/fill", { batch: p.batchId });
    const handed = list.filter((x) => x.fix === "product").map((x) => x.index);
    const noPlace = new Set(list.filter((x) => x.fix === "noplace").map((x) => x.index));
    const rewrite = [...new Set(list.filter((x) => x.fix === "post" || x.fix === "noplace").map((x) => x.index))];
    for (const index of rewrite) await post("/api/studio/posts/reidea", { batch: p.batchId, index, noPlace: noPlace.has(index) || undefined });
    const shots = [...new Set([...list.filter((x) => x.fix === "shot").map((x) => x.index), ...rewrite, ...handed])];
    if (shots.length) await post("/api/studio/posts/shots", { batch: p.batchId, indexes: shots });
    await p.refresh();
  }

  /** The analysis of a screen must exist, be current and not have failed. */
  function analysisIssues(k: BriefStep): Issue[] {
    if (briefError[k])
      return [{ text: `"What I understood" could not be written: ${briefError[k]}`, fix: { label: "Read again", run: () => runBrief(k) } }];
    if (briefBusy === k)
      return [{ text: "Wait for \"What I understood\": it is reading this screen.", how: "It takes a few seconds; the rest of the month follows it." }];
    if (!brief[k] || (stepBrief === k && seen.current[k] !== signature[k]))
      return [
        {
          text: "\"What I understood\" is older than this screen.",
          how: "It reads the screen again by itself in a moment, or press Read again.",
          fix: {
            label: "Read again",
            run: () => {
              seen.current[k] = signature[k];
              return runBrief(k);
            },
          },
        },
      ];
    return [];
  }

  function issuesFor(k: string): Issue[] {
    const out: Issue[] = [];
    switch (k) {
      case "client":
        if (!client) out.push({ text: "Pick the account you are working on." });
        break;
      case "products":
        if (p.uploading) out.push({ text: "Wait for the photos to finish uploading." });
        if (!p.products.length && !client?.service?.trim())
          out.push({
            text: "No products yet.",
            how: "Upload product photos, pick them from the gallery, or tick \"sells a service\" and describe what the client offers.",
          });
        else out.push(...analysisIssues("products"));
        break;
      case "count": {
        if (p.postCount < 1) out.push({ text: "Pick how many posts this month has." });
        const sel = p.config?.occasions;
        for (const o of pickedOccasions(p.month, sel))
          if (o.portrait && !sel?.photos?.[o.id])
            out.push({ warn: true, text: `${o.name}: upload the official portrait before Generate.`, how: "Use \"Official portrait\" next to it." });
        const ticked = new Set(sel?.picked ?? []);
        for (const o of occasionsOf(p.month))
          if (o.major && !ticked.has(o.id)) out.push({ warn: true, text: `${o.name} (${shortDate(o.date)}) is a big day without a post.` });
        out.push(...analysisIssues("count"));
        break;
      }
      case "brand":
        if (client && !client.logo) out.push({ warn: true, text: "No logo: the posts go out without one.", how: "Upload it in Logos." });
        if (client && !client.tone?.trim()) out.push({ warn: true, text: "No tone of voice: captions use a neutral tone." });
        if (client && !client.colors.length) out.push({ warn: true, text: "No brand colours yet." });
        out.push(...analysisIssues("brand"));
        break;
      case "identity":
        for (const a of castPeople) {
          if (!a.gender)
            out.push({ text: `Choose whether ${a.name} is a man or a woman.`, how: "Tick Man or Woman on the ambassador's card." });
          if (!a.image)
            out.push({ text: `${a.name} has no portrait yet.`, how: "Create the portrait, or take them out of this month." });
        }
        if (!theme) out.push({ warn: true, text: "No theme: the posts follow the brand identity and get no shots from pins." });
        else if (!theme.references)
          out.push({ text: "The theme has no pins or photos.", how: "Add photos, or paste Pinterest links and import them." });
        else if (reading) out.push({ text: "Wait: the pins are being read." });
        else if (!theme.shots.length || !analysedAt || (theme.latestRef ?? 0) > analysedAt)
          out.push({
            text: "The pins were not read since the last change: the month would follow the old theme.",
            fix: { label: "Analyse the pins", run: () => readReferences(true) },
          });
        out.push(...analysisIssues("theme"));
        break;
      case "colours":
        if (theme && !theme.palette.length)
          out.push({
            text: "No colours for this month.",
            how: `Add the colours, or let the ${p.config?.gridRef ? "grid" : "pins"} suggest them.`,
            fix: {
              label: p.config?.gridRef ? "Suggest from the grid" : "Suggest from the pins",
              run: async () => {
                const r = await post<ThemesReply>(`/api/studio/posts/themes/${theme.id}/palette`, p.config?.gridRef ? { grid: p.config.gridRef } : undefined);
                p.onThemesChanged(r.themes);
              },
            },
          });
        out.push(...analysisIssues("colours"));
        break;
      case "ideas": {
        if (p.ideasBusy || p.rewriting) {
          out.push({ text: "Wait: the ideas are being written." });
          break;
        }
        if (!p.plan.length) {
          out.push({ text: "No ideas yet.", fix: { label: "Write the ideas", run: () => void p.onGenerateIdeas() } });
          break;
        }
        const rewrite = { label: "Write the ideas again", run: () => void p.onGenerateIdeas() };
        // Only what comes before the captions makes them old: new pins or their new reading, never props or styles.
        if ((p.config?.gridAt ?? 0) > plannedAt)
          out.push({ text: "The month's grid changed after these ideas were written: they follow the old one.", fix: rewrite });
        else if (briefAt > plannedAt || (theme && Math.max(theme.analysed ?? 0, theme.latestRef ?? 0) > plannedAt))
          out.push({ text: "The brief or the theme changed after these ideas were written: they follow the old one.", fix: rewrite });
        else if (p.plan.length !== p.postCount)
          out.push({ text: `The month has ${p.postCount} posts but ${p.plan.length} ideas.`, fix: rewrite });
        const missing = pickedOccasions(p.month, p.config?.occasions).filter(
          (o) => !p.plan.some((x) => x.type === "greeting" && x.occasion === o.id),
        );
        if (missing.length)
          out.push({
            text: `No greeting post yet for ${missing.map((o) => o.name).join(", ")}.`,
            fix: {
              label: "Add the greeting post",
              run: async () => {
                await post("/api/studio/posts/occasion-posts", { batch: p.batchId });
                await p.refresh();
              },
            },
          });
        for (const x of p.plan) {
          if (x.type === "offer" && !offerReady(x.offer))
            out.push({ text: `Post ${x.index} is an offer: pick its products, write the price and what it includes, then "Write the offer post".` });
          if (x.product && !productNames.some((n) => n.toLowerCase() === x.product!.toLowerCase()) && x.type !== "offer")
            out.push({
              warn: true,
              text: `Post ${x.index} uses ${x.product}, which is not among this month's photos.`,
              fix: {
                label: "Find its photo",
                run: async () => {
                  await post("/api/studio/posts/products/fill", { batch: p.batchId });
                  await p.refresh();
                },
              },
            });
        }
        break;
      }
      case "scene": {
        if (adapting) {
          out.push({ text: "Wait: the shots are being written." });
          break;
        }
        const needsScene = !!theme?.shots.length || gridMonth;
        if (needsScene && (p.plan.some((x) => !x.scene) || p.config?.shotsFor !== shotsSig))
          out.push({ text: "The shots do not follow the current posts yet.", fix: { label: "Write the shots", run: () => adaptShots(true) } });
        else
          for (const x of p.plan)
            for (const pr of postProblems(x, { products: productNames, cast: castPeople, sellsDrinks, needsScene, hasPlaces: !!client?.places?.length }))
              out.push({
                text: `Post ${pr.index} ${pr.text}.`,
                problem: pr,
                fix:
                  pr.fix === "unbag"
                    ? { label: "Take the bag out", run: () => fixPosts([pr]) }
                    : pr.fix === "blank"
                      ? { label: "Take it out", run: () => fixPosts([pr]) }
                      : pr.fix === "product"
                        ? { label: "Give it a product", run: () => fixPosts([pr]) }
                    : pr.fix === "include"
                      ? { label: "Add it to the picture", run: () => fixPosts([pr]) }
                      : pr.fix === "noplace"
                        ? { label: "Make it a product post", run: () => fixPosts([pr]) }
                    : pr.fix === "shot"
                      ? { label: "Rewrite its shot", run: () => fixPosts([pr]) }
                      : { label: "Write the post again", run: () => fixPosts([pr]) },
              });
        if (needsScene) out.push(...analysisIssues("shots"));
        break;
      }
      case "magic": {
        for (const st of STEPS.slice(0, MAGIC)) {
          const blocks = issuesFor(st.key).filter((i) => !i.warn);
          if (blocks.length)
            out.push({ text: `${st.title}: ${blocks[0].text}${blocks.length > 1 ? ` (+${blocks.length - 1} more)` : ""}`, fix: { label: `Go to ${st.title}`, run: go(st.key) } });
        }
        const sel = p.config?.occasions;
        for (const o of pickedOccasions(p.month, sel))
          if (o.portrait && !sel?.photos?.[o.id])
            out.push({ text: `${o.name} needs its official portrait.`, fix: { label: "Go to Posts", run: go("count") } });
        if (!p.engineReady) out.push({ text: "No image engine is connected.", how: "Open Connection in the studio's left rail and connect Google." });
        break;
      }
      case "make": {
        if (!started) {
          out.push({ text: "Nothing is being made yet.", fix: { label: "Go to the test post", run: go("magic") } });
          break;
        }
        const making = p.posts.filter((x) => MAKING.includes(x.status));
        if (making.length)
          out.push({ text: `Wait: ${making.length} post${making.length > 1 ? "s are" : " is"} still being made.`, how: "You can close the page; they keep going and are here when you come back." });
        for (const x of p.posts) {
          if (x.status === "failed")
            out.push({ text: `Post ${x.index} failed: ${(x.error ?? "the engine gave no image").replace(/\.$/, "")}.`, fix: { label: "Make it again", run: () => p.onRetake(x.index) } });
          else if (x.status === "none")
            out.push({ text: `Post ${x.index} has no image.`, fix: { label: "Make it", run: () => p.onRetake(x.index) } });
          else if (x.flags?.length && !MAKING.includes(x.status))
            out.push({ warn: true, text: `Post ${x.index}: ${x.flags.map((f) => f.text).join("; ")}`, fix: { label: "Fix it", run: () => p.onFix(x.index, fixNote(x.flags!)) } });
        }
        break;
      }
      case "captions": {
        if (captionsWriting.length) {
          out.push({ text: "Wait: the captions are being written from the pictures." });
          break;
        }
        const old = p.plan.filter((x) => !captionCurrent(x, p.posts.find((j) => j.index === x.index)));
        if (old.length)
          out.push({
            text: `${old.length === 1 ? `Post ${old[0].index}'s caption is` : `${old.length} captions are`} not written from ${old.length === 1 ? "its" : "their"} picture yet.`,
            fix: { label: "Write from the pictures", run: () => writeCaptions(old.map((x) => x.index)) },
          });
        break;
      }
    }
    return out;
  }

  const issues = issuesFor(key);
  // A post's own problems hold the journey until Next has tried to fix them once; then they are
  // left to the review after each image.
  const blocking = issues.filter((i) => !i.warn && !(i.problem && autoTried && i.problem.text !== "has no shot yet"));
  useEffect(() => {
    if (!blocking.length) setShowIssues(false);
  }, [blocking.length]);
  useEffect(() => setAutoTried(false), [key]);
  // After Next fixed the screen by itself, it goes on (or shows what is left) with the fresh posts.
  useEffect(() => {
    if (!autoNext || fixing || moving) return;
    setAutoNext(false);
    void next();
  }, [autoNext, fixing, moving]); // eslint-disable-line react-hooks/exhaustive-deps

  async function runFix(id: string, run: () => void | Promise<void>) {
    setFixing(id);
    try {
      await run();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setFixing("");
    }
  }

  /** Every fix on the screen, one after the other (the posts' own problems in one go). */
  async function fixAll(list: Issue[]) {
    setFixing("all");
    try {
      await fixPosts(list.flatMap((i) => (i.problem ? [i.problem] : [])));
      const seenLabels = new Set<string>();
      for (const i of list)
        if (!i.problem && i.fix && !seenLabels.has(i.fix.label)) {
          seenLabels.add(i.fix.label);
          await i.fix.run();
        }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setFixing("");
    }
  }

  async function next() {
    if (blocking.length) {
      // Next fixes what it can by itself once, then tries again; only what needs a person stays.
      if (!autoTried && blocking.every((i) => i.fix)) {
        setAutoTried(true);
        toast(`Fixing ${blocking.length === 1 ? "1 thing" : `${blocking.length} things`} for you…`);
        await fixAll(blocking);
        setAutoNext(true);
        return;
      }
      setShowIssues(true);
      return;
    }
    setMoving(true);
    try {
      if (key === "client") await p.ensurePlan();
      if (key === "identity") await readReferences();
      if (last) return;
      setStep((s) => s + 1);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setMoving(false);
    }
  }

  const name = firstName(p.user);
  const stepsLeft = STEPS.length - step - 1;

  return (
    <div className="journey" role="dialog" aria-modal="true" aria-label="Start your session">
      <header className="journey-top">
        <LevelLogo className="journey-logo" />
        {p.user.role === "admin" && (
          <button type="button" className="secondary journey-approvals" aria-label="Approvals" onClick={() => setApproving(true)}>
            <BadgeCheck size={17} />
            <span className="journey-approvals-label">Approvals</span>
            {(p.pendingStyles ?? 0) > 0 && <span className="journey-approvals-count">{p.pendingStyles}</span>}
          </button>
        )}
        <span className="journey-where">
          {client && step > 0 ? `${client.name} · ${monthLabel(p.month)}` : ""}
        </span>
        <button type="button" className="text-button" onClick={p.onDone}>
          Skip to the studio
        </button>
      </header>

      {approving && (
        <StyleScreen
          open
          approvals
          admin
          clients={p.clients.filter((c) => c.status === "active").map((c) => ({ id: c.id, name: c.name }))}
          onPendingChange={p.onPendingChange}
          onClose={() => {
            setApproving(false);
            p.onPendingChange?.();
          }}
        />
      )}

      <div className="journey-body">
        <div className={`journey-step step-${key}`} key={key}>
          {key === "client" && (
            <div className="journey-welcome">
              <h1 className="journey-hello">
                <span className="journey-hello-text">
                  {greeting()}
                  {name ? ` ${name}` : ""}
                </span>{" "}
                <span className="journey-emoji" aria-hidden>
                  😍
                </span>
              </h1>
              <p className="journey-lead">Which account would you like to work on today?</p>
              <div className="journey-clients">
                {active.map((c, i) => (
                  <button
                    key={c.id}
                    type="button"
                    style={{ "--i": i } as React.CSSProperties}
                    className={`journey-client ${c.id === p.clientId ? "active" : ""}`}
                    onClick={() => p.onClient(c.id)}
                  >
                    <span className="journey-client-logo">
                      {c.logo ? (
                        <img src={`/api/studio/clients/${c.id}/logo?v=${c.updated}`} alt="" />
                      ) : (
                        <strong>{c.name.slice(0, 1)}</strong>
                      )}
                    </span>
                    <span>{c.name}</span>
                    {c.id === p.clientId && <Check className="journey-client-tick" size={16} />}
                    {p.user.role === "admin" && (
                      <span
                        role="button"
                        tabIndex={0}
                        className="journey-client-x"
                        title={`Remove ${c.name}`}
                        aria-label={`Remove ${c.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          void removeClient(c);
                        }}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.stopPropagation();
                            void removeClient(c);
                          }
                        }}
                      >
                        <X size={13} />
                      </span>
                    )}
                  </button>
                ))}
                <button
                  type="button"
                  className="journey-client add"
                  style={{ "--i": active.length } as React.CSSProperties}
                  onClick={() => void newClient()}
                >
                  <span className="journey-client-logo">
                    <Plus size={26} />
                  </span>
                  <span>New account</span>
                </button>
              </div>
              <div className="journey-months" role="radiogroup" aria-label="Month">
                {[thisMonth(), nextMonth(thisMonth())].map((m) => (
                  <button
                    key={m}
                    type="button"
                    role="radio"
                    aria-checked={p.month === m}
                    className={`journey-chip ${p.month === m ? "active" : ""}`}
                    onClick={() => p.onMonth(m)}
                  >
                    {monthLabel(m)}
                  </button>
                ))}
              </div>
              {client && <ProfileBar key={client.id} client={client} onClientsChanged={p.onClientsChanged} />}
              {client && p.previousMonth && !p.batchId && (
                <div className="journey-continue">
                  <span>
                    <strong>Continue with the same direction</strong>
                    <small>
                      Start {monthLabel(p.month)} from {monthLabel(p.previousMonth)}: the same theme, pins, colours, props,
                      ambassadors, size and products. The posts and occasions are new.
                    </small>
                  </span>
                  <button type="button" className="primary" disabled={p.continuing} onClick={() => void p.onContinue().then(() => setStep(1))}>
                    {p.continuing ? <LoaderCircle className="spinning" size={14} /> : <Repeat size={14} />} Continue from {monthLabel(p.previousMonth)}
                  </button>
                </div>
              )}
              {p.config?.continuedFrom && (
                <p className="journey-continued">
                  <Repeat size={13} /> Continued from {monthLabel(p.config.continuedFrom)}: check each screen and press Next.
                </p>
              )}
            </div>
          )}

          {key === "products" && client && (
            <>
              <StepHead kit="references" title="Products for this month">
                Upload new product photos or pick them from {client.name}'s gallery. I read every photo.
              </StepHead>
              <div className="journey-boxes cols-3">
                <ProductsBox {...p} client={client} />
                <GalleryBox
                  client={client}
                  batchId={p.batchId}
                  products={p.products}
                  refresh={p.refresh}
                  onUpload={p.onUpload}
                  uploading={p.uploading}
                  posts={p.plan.length}
                />
                <Analysis step="products" note={brief.products} busy={briefBusy === "products"} onRun={() => void runBrief("products")} empty="Add products and I will read them: kinds, packaging and how each is best shown." />
              </div>
            </>
          )}

          {key === "count" && (
            <>
              <StepHead kit="output" title="How many posts this month?">
                Pick the number and the size. Posts are spread over {monthLabel(p.month)}, with the occasions on their days.
              </StepHead>
              <div className="journey-boxes cols-3">
                <CountBox {...p} />
                <CalendarBox
                  month={p.month}
                  plan={p.plan}
                  count={p.postCount}
                  config={p.config}
                  batchId={p.batchId}
                  onOccasions={(o) => p.onSettings({ occasions: { picked: o.picked ?? [], custom: o.custom ?? [] } })}
                  refresh={p.refresh}
                />
                <Analysis step="count" note={brief.count} busy={briefBusy === "count"} onRun={() => void runBrief("count")} />
              </div>
            </>
          )}

          {key === "brand" && client && (
            <>
              <StepHead kit="brand" title={`Confirm ${client.name}'s brand kit`}>
                Check the colours, fonts, tone of voice and rules. Every change saves itself and is read again.
              </StepHead>
              <div className="journey-boxes cols-brand">
                <div className="journey-box journey-brand">
                  <BrandKit client={client} onClientsChanged={p.onClientsChanged} bare />
                </div>
                <Analysis step="brand" note={brief.brand} busy={briefBusy === "brand"} onRun={() => void runBrief("brand")} />
              </div>
            </>
          )}

          {key === "identity" && client && (
            <>
              <StepHead kit="identity" title="Visual identity">
                Pick the brand ambassadors for this month, then the theme and its Pinterest pins, or a whole feed grid the month follows.
              </StepHead>
              <GridPick
                clientId={client.id}
                clientName={client.name}
                gridFonts={p.config?.gridFonts}
                monthFonts={p.config?.monthFonts}
                onFonts={(f) => p.onSettings({ monthFonts: f })}
                gridRef={p.config?.gridRef ?? null}
                admin={p.user.role === "admin"}
                onPick={(id) => void pickGrid(`style:${id}`)}
                onClear={() => p.onSettings({ gridRef: null })}
              />
              <div className="journey-boxes cols-3">
                <div className="journey-box">
                  <BoxTitle kit="ambassadors">Brand ambassadors</BoxTitle>
                  <Ambassadors
                    client={client}
                    ambassadors={p.ambassadors}
                    onChanged={p.onAmbassadorsChanged}
                    cast={p.cast}
                    onCast={p.onCast}
                    locked={false}
                  />
                </div>
                <div className="journey-box">
                  <ThemeSection
                    client={client}
                    themes={p.themes}
                    theme={p.themeId}
                    onTheme={p.onTheme}
                    onThemesChanged={p.onThemesChanged}
                    parts={["pick", "references"]}
                    bare
                  />
                </div>
                <Analysis step="theme" note={brief.theme} busy={briefBusy === "theme" || reading} onRun={() => void runBrief("theme")} />
              </div>
            </>
          )}

          {key === "colours" && client && (
            <>
              <StepHead kit="colours" title="The colours of this month">
                {theme?.palette.length
                  ? `These colours come from the ${p.config?.gridRef ? "grid" : "pins"} you chose. Would you like to change the colours? The first one is the background of every post.`
                  : "Add the month's colours. The first one is the background of every post."}
              </StepHead>
              <div className="journey-boxes cols-3">
                <div className="journey-box">
                  {reading ? (
                    <Reading />
                  ) : theme ? (
                    <ThemeSection
                      client={client}
                      themes={p.themes}
                      theme={p.themeId}
                      onTheme={p.onTheme}
                      onThemesChanged={p.onThemesChanged}
                      parts={["colours"]}
                      gridRef={p.config?.gridRef}
                      bare
                    />
                  ) : (
                    <p className="field-hint">No theme this month: the posts use the brand colours.</p>
                  )}
                </div>
                <ColourPreview palette={theme?.palette.length ? theme.palette : client.colors} products={p.products} sourceUrl={p.sourceUrl} />
                <Analysis step="colours" note={brief.colours} busy={briefBusy === "colours"} onRun={() => void runBrief("colours")} />
              </div>
            </>
          )}

          {key === "scene" && client && (
            <>
              <StepHead kit="shots" title="Props and shots">
                One shot for every post, in the look of your pins: its product, its type, its occasion and its people, in your colours. Edit any of them; the images follow these.
              </StepHead>
              <div className="journey-boxes cols-scene">
                {reading ? (
                  <div className="journey-box">
                    <Reading />
                  </div>
                ) : theme || gridMonth ? (
                  <>
                    <div className="scene-side">
                      {theme && (
                        <div className="journey-box">
                          <ThemeSection client={client} themes={p.themes} theme={p.themeId} onTheme={p.onTheme} onThemesChanged={p.onThemesChanged} parts={["props"]} bare />
                        </div>
                      )}
                      <RecommendedProducts
                        batchId={p.batchId}
                        plan={p.plan}
                        monthProducts={p.products.map((x) => displayName(x.name))}
                        sourceUrl={p.sourceUrl}
                        onChanged={p.refresh}
                      />
                    </div>
                    <MonthShots
                      forClient={{ id: client.id, name: client.name }}
                      plan={p.plan}
                      products={p.products}
                      sourceUrl={p.sourceUrl}
                      admin={p.user.role === "admin"}
                      onStyles={p.onStyles}
                      busy={adapting}
                      empty={!theme?.shots.length && !gridMonth}
                      onRewrite={() => void adaptShots(true)}
                      onReadPins={theme && theme.references > 0 ? () => void readReferences(true).then(p.refresh) : undefined}
                      onSave={(index, scene) => p.onSavePlan(p.plan.map((x) => (x.index === index ? { ...x, scene } : x)))}
                      batchId={p.batchId}
                      refresh={p.refresh}
                    />
                  </>
                ) : (
                  <div className="journey-box">
                    <p className="field-hint">No theme this month: the posts follow the brand identity.</p>
                  </div>
                )}
                <Analysis step="shots" note={brief.shots} busy={briefBusy === "shots"} onRun={() => void runBrief("shots")} />
              </div>
            </>
          )}

          {key === "ideas" && (
            <IdeasStep
              plan={p.plan}
              config={p.config}
              busy={p.ideasBusy}
              rewriting={p.rewriting}
              batchId={p.batchId}
              refresh={p.refresh}
              productNames={p.products.map((x) => displayName(x.name))}
              onGenerate={() => void p.onGenerateIdeas()}
              onSavePlan={p.onSavePlan}
              onRewrite={p.onRewrite}
            />
          )}

          {key === "magic" && client && (
            <MagicStep
              blocked={blocking.length > 0}
              onShowIssues={() => setShowIssues(true)}
              client={client}
              month={p.month}
              plan={p.plan}
              format={p.format}
              theme={theme}
              config={p.config}
              testPost={p.testPost}
              exact={!!p.config?.exact}
              onExact={(on) => p.onSettings({ exact: on })}
              onTest={p.onTest}
              onFixTest={p.onFixTest}
              batchId={p.batchId}
              overlay={p.overlay}
              logoSrc={p.logoSrc}
              onGenerate={async () => {
                confetti();
                await p.onGenerate();
                setStep(STEPS.findIndex((s) => s.key === "make"));
              }}
            />
          )}

          {key === "make" && <MakeStep plan={p.plan} posts={p.posts} format={p.format} onRetake={p.onRetake} onFix={p.onFix} />}

          {key === "captions" && (
            <CaptionsStep
              plan={p.plan}
              posts={p.posts}
              writing={captionsWriting}
              failed={captionsFailed}
              onWrite={(indexes, force) => void writeCaptions(indexes, force)}
              onSave={(next) => p.onSavePlan(p.plan.map((x) => (x.index === next.index ? next : x)))}
            />
          )}

          {key === "feed" && client && (
            <FeedStep
              client={client}
              month={p.month}
              plan={p.plan}
              posts={p.posts}
              format={p.format}
              overlay={p.overlay}
              logoSrc={p.logoSrc}
              onShare={p.onShare}
              onExport={p.onExport}
              onRetake={p.onRetake}
              reference={
                p.config?.gridRef
                  ? p.config.gridRef.startsWith("style:")
                    ? styleThumb({ id: p.config.gridRef.slice(6), updated: 0 }, true)
                    : `/api/studio/references/${p.config.gridRef}/file`
                  : undefined
              }
            />
          )}
        </div>
      </div>

      <footer className="journey-foot">
        <div className="journey-progress" aria-label={`Step ${step + 1} of ${STEPS.length}`}>
          {STEPS.map((s, i) => (
            <button
              type="button"
              key={s.key}
              className={`journey-seg ${i < step ? "done" : i === step ? "now" : ""}`}
              onClick={() => i < step && setStep(i)}
              disabled={i >= step}
              aria-label={s.title}
            >
              <i />
              <small>{s.title}</small>
            </button>
          ))}
        </div>
        {showIssues && issues.length > 0 && (
          <div className="journey-issues" role="alert">
            <div className="journey-issues-head">
              <strong>{blocking.length ? `Fix ${blocking.length === 1 ? "this" : `these ${blocking.length}`} before Next` : "Worth a look"}</strong>
              {issues.filter((i) => i.fix).length > 1 && (
                <button
                  type="button"
                  className="secondary journey-fix-all"
                  disabled={!!fixing}
                  // What is left after one go never holds the journey (the review after each image checks it).
                  onClick={() => void fixAll(issues.filter((i) => i.fix)).then(() => setAutoTried(true))}
                >
                  {fixing === "all" ? <LoaderCircle className="spinning" size={13} /> : <Wand2 size={13} />} Fix all for me
                </button>
              )}
              <button type="button" className="icon-button" onClick={() => setShowIssues(false)} aria-label="Close">
                <X size={14} />
              </button>
            </div>
            <ul>
              {issues.map((i, n) => (
                <li key={n} className={i.warn ? "warn" : "block"}>
                  <span>
                    {i.text}
                    {i.how && <small>{i.how}</small>}
                  </span>
                  {i.fix && (
                    <button type="button" className="secondary" disabled={!!fixing} onClick={() => void runFix(`${n}`, i.fix!.run)}>
                      {fixing === `${n}` ? <LoaderCircle className="spinning" size={13} /> : null}
                      {i.fix.label}
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="journey-actions">
          <button
            type="button"
            className={`journey-check ${blocking.length ? "block" : issues.length ? "warn" : "ok"}`}
            onClick={() => setShowIssues((v) => !v)}
            disabled={!issues.length}
            title="What this screen still needs"
          >
            {blocking.length ? `${blocking.length} to fix` : issues.length ? `${issues.length} to look at` : "Ready"}
          </button>
          <span className="journey-left">
            Step{" "}
            <b key={step} className="bump">
              {step + 1}
            </b>{" "}
            of {STEPS.length} · {last ? "last step" : `${stepsLeft} left`}
          </span>
          {step > 0 && (
            <button type="button" className="secondary" onClick={() => setStep((s) => s - 1)} disabled={moving}>
              <ArrowLeft size={15} /> Back
            </button>
          )}
          {last && (
            <button
              type="button"
              className="primary"
              onClick={() => {
                try {
                  localStorage.removeItem(RESUME_KEY);
                } catch {
                  /* private mode */
                }
                p.onDone();
              }}
            >
              Open the studio <ArrowRight size={15} />
            </button>
          )}
          {/* The test post's screen moves on with its Generate button; once the posts exist, Next goes to them. */}
          {!last && (key !== "magic" || started) && (
            <button
              type="button"
              className="primary"
              onClick={() => void next()}
              disabled={moving || reading}
              data-blocked={blocking.length > 0 || undefined}
              title={blocking.length ? "Fix the list first" : ""}
            >
              {moving || reading ? <LoaderCircle className="spinning" size={15} /> : null}
              Next
              {!moving && !reading && <ArrowRight size={15} />}
            </button>
          )}
        </div>
      </footer>
    </div>
  );
}

function StepHead({ kit, title, children }: { kit: KitKey; title: string; children: ReactNode }) {
  return (
    <div className="journey-head">
      <KitIcon kit={kit} size={18} />
      <div>
        <h2>{title}</h2>
        <p>{children}</p>
      </div>
    </div>
  );
}

function BoxTitle({ kit, children, actions }: { kit: KitKey; children: ReactNode; actions?: ReactNode }) {
  return (
    <div className="journey-box-title">
      <KitIcon kit={kit} />
      <strong>{children}</strong>
      {actions && <span className="journey-box-actions">{actions}</span>}
    </div>
  );
}

function Reading() {
  return (
    <div className="journey-reading">
      <LoaderCircle className="spinning" size={18} />
      Reading your pins: colours, visual language and one shot per picture…
    </div>
  );
}

/** "What I understood": the screen's analysis and the rule it adds to the month. */
function Analysis({
  note,
  busy,
  onRun,
  empty = "Reading this screen…",
}: {
  step: BriefStep;
  note?: BriefNote;
  busy: boolean;
  onRun: () => void;
  empty?: string;
}) {
  return (
    <aside className={`journey-box journey-analysis ${busy ? "busy" : ""}`} aria-live="polite">
      <div className="journey-box-title">
        <span className="analysis-icon">
          <Sparkles size={14} />
        </span>
        <strong>What I understood</strong>
        <span className="journey-box-actions">
          <button type="button" className="text-button" onClick={onRun} disabled={busy} title="Read this screen again">
            {busy ? <LoaderCircle className="spinning" size={13} /> : <RefreshCw size={13} />}
          </button>
        </span>
      </div>
      {busy && !note ? (
        <div className="analysis-skeleton">
          <i />
          <i />
          <i />
          <i />
        </div>
      ) : note ? (
        <>
          <p className="analysis-summary">{note.summary}</p>
          <ul className="analysis-points">
            {note.points.map((pt, i) => (
              <li key={i}>{pt}</li>
            ))}
          </ul>
          {note.logic && (
            <div className="analysis-logic">
              <small>Rule for the month</small>
              {note.logic}
            </div>
          )}
          {busy && <p className="analysis-updating">Updating…</p>}
        </>
      ) : (
        <p className="field-hint">{empty}</p>
      )}
    </aside>
  );
}

/* ───────────── Products ───────────── */

function ProductsBox(p: JourneyProps & { client: Client }) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [service, setService] = useState(p.client.service ?? "");
  const [asService, setAsService] = useState(!!p.client.service?.trim());
  useEffect(() => {
    setService(p.client.service ?? "");
    setAsService(!!p.client.service?.trim());
  }, [p.client.id, p.client.service]);
  async function saveService(text: string) {
    if (text.trim() === (p.client.service ?? "").trim()) return;
    try {
      const r = await put<{ clients: Client[] }>(`/api/studio/clients/${p.client.id}`, { service: text.trim() });
      p.onClientsChanged(r.clients);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  const take = (list: FileList | null) => {
    const files = [...(list ?? [])].filter((f) => f.type.startsWith("image/") || /\.(heic|jpe?g|png|webp)$/i.test(f.name));
    if (files.length) void p.onUpload(files);
  };
  return (
    <div
      className={`journey-box journey-drop ${over ? "over" : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        take(e.dataTransfer.files);
      }}
    >
      <BoxTitle
        kit="references"
        actions={
          <button type="button" className="text-button" onClick={() => input.current?.click()} disabled={p.uploading}>
            {p.uploading ? <LoaderCircle className="spinning" size={13} /> : <Upload size={13} />} Upload
          </button>
        }
      >
        This month · {p.products.length}
      </BoxTitle>
      <input ref={input} type="file" accept="image/*" multiple hidden onChange={(e) => (take(e.target.files), (e.target.value = ""))} />
      {p.products.length ? (
        <div className="journey-thumbs">
          {p.products.map((s, i) => (
            <figure key={s.id} className="journey-thumb" style={{ "--i": i } as React.CSSProperties}>
              <img src={p.sourceUrl(s.id)} alt="" loading="lazy" />
              <figcaption title={displayName(s.name)}>{displayName(s.name)}</figcaption>
              {s.category && <span className="journey-tag">{s.category}</span>}
              <button type="button" className="journey-thumb-x" aria-label={`Remove ${displayName(s.name)}`} onClick={() => p.onRemoveProduct(s.id)}>
                <X size={12} />
              </button>
            </figure>
          ))}
        </div>
      ) : (
        <button type="button" className="journey-dropzone" onClick={() => input.current?.click()}>
          <ImagePlus size={26} />
          <strong>Drop product photos here</strong>
          <span>or click to upload · or pick from the gallery</span>
        </button>
      )}
      <div className={`journey-service ${asService ? "on" : ""}`}>
        <label className="journey-service-toggle">
          <input
            type="checkbox"
            checked={asService}
            onChange={(e) => {
              setAsService(e.target.checked);
              if (!e.target.checked) {
                setService("");
                void saveService("");
              }
            }}
          />
          <span>
            <strong>No products? {p.client.name} sells a service</strong>
            <small>Insurance, a bank, a clinic, a school: the posts show the moments the service is about.</small>
          </span>
        </label>
        {asService && (
          <textarea
            rows={3}
            dir="auto"
            value={service}
            placeholder="What does the client offer, and to whom? e.g. car, home, health and travel insurance for families in Jordan"
            onChange={(e) => setService(e.target.value)}
            onBlur={() => void saveService(service)}
          />
        )}
      </div>
    </div>
  );
}

function GalleryBox({
  client,
  batchId,
  products,
  refresh,
  onUpload,
  uploading,
  posts,
}: {
  client: Client;
  batchId: string | null;
  products: Source[];
  refresh: () => Promise<void>;
  onUpload: (files: File[]) => Promise<void>;
  uploading: boolean;
  /** The month's posts: "Pick for me" picks about as many products from Drive. */
  posts: number;
}) {
  const uploadInput = useRef<HTMLInputElement>(null);
  const [drive, setDrive] = useState(false);
  const [items, setItems] = useState<GalleryItem[] | null>(null);
  const [cat, setCat] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const loadGallery = useCallback(() => {
    get<{ items: GalleryItem[] }>(`/api/studio/posts/gallery?client=${encodeURIComponent(client.id)}`)
      .then((r) => setItems(r.items))
      .catch(() => setItems([]));
  }, [client.id]);
  useEffect(loadGallery, [loadGallery]);
  const here = new Set(products.map((s) => displayName(s.name).toLowerCase()));
  // Categories read on this month's products count for their gallery copies too.
  useEffect(() => {
    if (products.some((s) => s.category)) loadGallery();
  }, [products.map((s) => s.category ?? "").join(","), loadGallery]); // eslint-disable-line react-hooks/exhaustive-deps
  const offered = (items ?? []).filter((g) => !here.has(g.name.toLowerCase()));
  const cats = [...new Set(offered.map((g) => g.category).filter(Boolean))].sort();
  const shown = offered.filter((g) => !cat || g.category === cat);

  async function add(ids: string[]) {
    if (!batchId || !ids.length) return;
    setAdding(true);
    try {
      const r = await post<{ added: number }>("/api/studio/posts/gallery/add", { batch: batchId, ids });
      setPicked([]);
      await refresh();
      toast.success(`${r.added} product${r.added === 1 ? "" : "s"} added from the gallery.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="journey-box">
      <BoxTitle
        kit="identity"
        actions={
          <>
            <button
              type="button"
              className="text-button"
              onClick={() => uploadInput.current?.click()}
              disabled={uploading}
              title="Upload new product photos: they join this month and stay in the gallery for every month after"
            >
              {uploading ? <LoaderCircle className="spinning" size={13} /> : <Upload size={13} />} Upload
            </button>
            <button type="button" className="text-button" onClick={() => setDrive(true)} disabled={uploading} title="Pick photos from the client's Google Drive">
              <HardDrive size={13} /> Drive
            </button>
            {offered.length > 0 && (
              <button type="button" className="text-button" onClick={() => void add(picked.length ? picked : shown.map((g) => g.id))} disabled={adding}>
                {adding ? <LoaderCircle className="spinning" size={13} /> : <Plus size={13} />}
                {picked.length ? `Add ${picked.length}` : `Add all${cat ? ` ${cat}` : ""}`}
              </button>
            )}
          </>
        }
      >
        {client.name} gallery
      </BoxTitle>
      <DrivePicker
        open={drive}
        onClose={() => setDrive(false)}
        client={client}
        count={Math.min(12, Math.max(4, posts || 6))}
        batchId={batchId}
        onAdded={() => refresh().then(loadGallery)}
      />
      <input
        ref={uploadInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          e.target.value = "";
          if (files.length) void onUpload(files).then(loadGallery);
        }}
      />
      {cats.length > 0 && (
        <div className="journey-filter">
          <button type="button" className={`journey-chip small ${!cat ? "active" : ""}`} onClick={() => setCat("")}>
            All · {offered.length}
          </button>
          {cats.map((c) => (
            <button key={c} type="button" className={`journey-chip small ${cat === c ? "active" : ""}`} onClick={() => setCat(c)}>
              {c} · {offered.filter((g) => g.category === c).length}
            </button>
          ))}
        </div>
      )}
      {items === null ? (
        <div className="journey-reading">
          <LoaderCircle className="spinning" size={16} /> Opening the gallery…
        </div>
      ) : shown.length ? (
        <div className="journey-thumbs">
          {shown.map((g, i) => {
            const on = picked.includes(g.id);
            return (
              <button
                key={g.id}
                type="button"
                className={`journey-thumb pick ${on ? "on" : ""}`}
                style={{ "--i": i } as React.CSSProperties}
                onClick={() => setPicked((l) => (on ? l.filter((x) => x !== g.id) : [...l, g.id]))}
                title={g.note || g.name}
              >
                <img src={`/api/studio/posts/gallery/image?id=${encodeURIComponent(g.id)}`} alt="" loading="lazy" />
                <figcaption>{g.name}</figcaption>
                {g.category && <span className="journey-tag">{g.category}</span>}
                {on && (
                  <span className="journey-thumb-check">
                    <Check size={12} />
                  </span>
                )}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="field-hint">
          {items.length ? "Every gallery product is already in this month." : "The gallery fills up with every product uploaded for this client."}
        </p>
      )}
    </div>
  );
}

/* ───────────── This month's shots ───────────── */

function MonthShots({
  plan,
  products,
  sourceUrl,
  admin,
  onStyles,
  busy,
  empty,
  onRewrite,
  onReadPins,
  onSave,
  forClient,
  batchId,
  refresh,
}: {
  forClient: { id: string; name: string };
  batchId: string | null;
  refresh: () => Promise<void>;
  plan: Post[];
  products: Source[];
  sourceUrl: (id: string) => string;
  admin: boolean;
  onStyles: (assign: { index: number; style: string | null }[]) => Promise<void>;
  busy: boolean;
  empty: boolean;
  onRewrite: () => void;
  onReadPins?: () => void;
  onSave: (index: number, scene: string) => void;
}) {
  const written = plan.filter((x) => x.scene).length;
  const styles = useStyleInfo(plan.map((x) => x.style));
  // null: closed; "grid": styles for the whole grid; a number: the style of that post.
  const [picking, setPicking] = useState<"grid" | number | null>(null);
  const [styling, setStyling] = useState(false);
  /** The post whose product is being chosen. */
  const [swapping, setSwapping] = useState<number | null>(null);
  const styled = plan.filter((x) => x.style).length;
  const gridPosts = plan.filter((x) => x.type !== "greeting");
  async function apply(assign: { index: number; style: string | null }[]) {
    setStyling(true);
    try {
      await onStyles(assign);
    } finally {
      setStyling(false);
    }
  }
  return (
    <div className="journey-box">
      <StyleScreen
        open={picking !== null}
        onClose={() => setPicking(null)}
        admin={admin}
        forClient={forClient}
        pick={{
          mode: picking === "grid" ? "grid" : "post",
          posts: gridPosts.length,
          label: typeof picking === "number" ? `Post ${String(picking).padStart(2, "0")}` : undefined,
          tab: typeof picking === "number" && plan.find((x) => x.index === picking)?.people?.length ? "lifestyle" : undefined,
          onPick: (ids: string[], items: StyleItem[]) => {
            if (picking === "grid") {
              // Every picked style is used, spread over the posts in order; a people style then swaps
              // onto a post that has people when one is free.
              const isPeople = (id: string) => items.find((st) => st.id === id)?.kind === "people";
              const order = gridPosts.map((_, i) => ids[i % ids.length]);
              gridPosts.forEach((x, i) => {
                if (!x.people?.length || isPeople(order[i])) return;
                const j = gridPosts.findIndex((y, k) => !y.people?.length && isPeople(order[k]));
                if (j >= 0) [order[i], order[j]] = [order[j], order[i]];
              });
              const assign = gridPosts.map((x, i) => ({ index: x.index, style: order[i] }));
              void apply(assign);
            } else if (typeof picking === "number") void apply([{ index: picking, style: ids[0] }]);
          },
        }}
      />
      <BoxTitle
        kit="shots"
        actions={
          <>
            <button
              type="button"
              className="text-button"
              onClick={() => setPicking("grid")}
              disabled={busy || styling || !plan.length}
              title="Pick styles from the gallery: each is written for its post's product"
            >
              {styling ? <LoaderCircle className="spinning" size={13} /> : <Images size={13} />} Styles{styled ? ` · ${styled}` : ""}
            </button>
            {onReadPins && (
              <button type="button" className="text-button" onClick={onReadPins} disabled={busy} title="Read the pins again, then write the shots again">
                <RefreshCw size={13} /> Pins
              </button>
            )}
            <button type="button" className="text-button" onClick={onRewrite} disabled={busy || styling || (empty && !styled) || !plan.length} title="Write every post's shot again (a styled post from its style)">
              {busy ? <LoaderCircle className="spinning" size={13} /> : <Wand2 size={13} />} Rewrite
            </button>
          </>
        }
      >
        Shot list{plan.length ? ` · ${written}/${plan.length}` : ""}
      </BoxTitle>
      {styled > 0 && (
        <p className="shot-grid-note">
          <Images size={13} /> {styled === gridPosts.length ? "Style grid" : `${styled} of ${gridPosts.length} posts styled`}: these posts follow their style's own reference; the theme's pins are not used for them.
        </p>
      )}
      {busy && !written ? (
        <div className="journey-reading">
          <LoaderCircle className="spinning" size={18} />
          Writing one shot per post from your pins, products and colours…
        </div>
      ) : empty ? (
        <p className="field-hint">Add pins to the theme (Visual identity) and they are read into shots.</p>
      ) : !plan.length ? (
        <p className="field-hint">Write the post types and captions first: every post gets its own shot.</p>
      ) : (
        <ol className="shot-list">
          {plan.map((x, i) => (
            <ShotRow
              key={`${x.index}:${x.scene ?? ""}`}
              post={x}
              order={i}
              busy={busy || styling}
              style={x.style ? styles.get(x.style) : undefined}
              product={products.find((s) => displayName(s.name).toLowerCase() === (x.product ?? "").toLowerCase())}
              sourceUrl={sourceUrl}
              onStyle={() => setPicking(x.index)}
              onUnstyle={() => void apply([{ index: x.index, style: null }])}
              onSave={(t) => onSave(x.index, t)}
              onProduct={() => setSwapping(x.index)}
            />
          ))}
        </ol>
      )}
      <ProductSwap
        open={swapping !== null}
        onClose={() => setSwapping(null)}
        batchId={batchId}
        target={plan.find((x) => x.index === swapping) ?? null}
        sourceUrl={sourceUrl}
        onChanged={refresh}
      />
    </div>
  );
}

function ShotRow({
  post,
  order,
  busy,
  style,
  product,
  sourceUrl,
  onStyle,
  onUnstyle,
  onSave,
  onProduct,
}: {
  /** Choose or replace the post's product. */
  onProduct: () => void;
  post: Post;
  order: number;
  busy: boolean;
  style?: StyleItem;
  /** The post's product photo: shown small, so the team picks a style knowing the product. */
  product?: Source;
  sourceUrl: (id: string) => string;
  onStyle: () => void;
  onUnstyle: () => void;
  onSave: (scene: string) => void;
}) {
  const [text, setText] = useState(post.scene ?? "");
  return (
    <li className={`shot-row ${post.style ? "styled" : ""}`} style={{ "--i": order } as React.CSSProperties}>
      <div className="idea-meta">
        <span className="idea-index">{String(post.index).padStart(2, "0")}</span>
        {post.date && <span className="journey-tag">{shortDate(post.date)}</span>}
        <span className="journey-tag muted">{POST_TYPE_INFO[post.type]?.label ?? post.type}</span>
        <span className="shot-headline" dir="auto">
          {post.headline}
        </span>
        {product || post.product ? (
          <button
            type="button"
            className={`shot-product ${product ? "" : "missing"}`}
            onClick={onProduct}
            disabled={busy}
            title={product ? `${post.product}: replace it` : `${post.product} has no photo this month: choose one`}
          >
            {product ? <img src={sourceUrl(product.id)} alt="" loading="lazy" /> : <i />}
            <span dir="auto">{post.product}</span>
            <Repeat size={11} />
          </button>
        ) : (
          post.type !== "greeting" &&
          post.type !== "offer" &&
          !NO_PRODUCT_TILES.has(post.tileSpec?.kind ?? "") && (
            <button type="button" className="text-button shot-style" onClick={onProduct} disabled={busy} title="Choose the product this post shows">
              <Plus size={12} /> Product
            </button>
          )
        )}
        {!post.style && (
          <button type="button" className="text-button shot-style" onClick={onStyle} disabled={busy} title="Pick a style from the gallery for this post">
            <Images size={12} /> Style
          </button>
        )}
      </div>
      {post.style && (
        <div className="shot-style-banner">
          {style ? <img src={styleThumb(style)} alt="" /> : <span className="shot-style-empty" />}
          <span>
            <strong>Style applied on this post</strong>
            <small>{style?.title ?? "A style from the gallery"} · the shot below is that style written for this product</small>
          </span>
          <button type="button" className="text-button" onClick={onStyle} disabled={busy}>
            Change
          </button>
          <button type="button" className="icon-button" onClick={onUnstyle} disabled={busy} aria-label="Take the style off" title="Take the style off: back to the pins' shot">
            <X size={13} />
          </button>
        </div>
      )}
      {post.scene || !busy ? (
        <textarea
          rows={3}
          value={text}
          placeholder="Writing this post's shot…"
          onChange={(e) => setText(e.target.value)}
          onBlur={() => text.trim() !== (post.scene ?? "").trim() && onSave(text.trim())}
          aria-label={`Shot of post ${post.index}`}
        />
      ) : (
        <div className="analysis-skeleton">
          <i />
          <i />
        </div>
      )}
    </li>
  );
}

/* ───────────── Count and calendar ───────────── */

function CountBox(p: JourneyProps) {
  const set = (n: number) => p.onSettings({ postCount: Math.max(1, Math.min(MAX_POST_COUNT, n)) });
  return (
    <div className="journey-box">
      <BoxTitle kit="output">Posts this month</BoxTitle>
      <div className="journey-count">
        <button type="button" className="icon-button" onClick={() => set(p.postCount - 1)} aria-label="One post fewer">
          <Minus size={18} />
        </button>
        <strong key={p.postCount} className="bump">
          {p.postCount}
        </strong>
        <button type="button" className="icon-button" onClick={() => set(p.postCount + 1)} aria-label="One post more">
          <Plus size={18} />
        </button>
      </div>
      <div className="journey-filter center">
        {[8, 12, 16, 20, 30].map((n) => (
          <button key={n} type="button" className={`journey-chip ${p.postCount === n ? "active" : ""}`} onClick={() => set(n)}>
            {n}
          </button>
        ))}
        {p.products.length > 0 && ![8, 12, 16, 20, 30].includes(p.products.length) && (
          <button type="button" className={`journey-chip ${p.postCount === p.products.length ? "active" : ""}`} onClick={() => set(p.products.length)}>
            {p.products.length} · one per product
          </button>
        )}
      </div>
      <label className="field-label">Post size</label>
      <div className="format-row">
        {FORMATS.map((f) => (
          <button key={f} type="button" className={`format-chip ${p.format === f ? "active" : ""}`} onClick={() => p.onSettings({ format: f })}>
            <span className={`format-shape f-${f.replace(":", "x")}`} />
            <strong>{FORMAT_INFO[f].label}</strong>
            <small>{FORMAT_INFO[f].pixels}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

function CalendarBox({
  month,
  plan,
  count,
  config,
  batchId,
  onOccasions,
  refresh,
}: {
  month: string;
  plan: Post[];
  count: number;
  config: Config | null;
  batchId: string | null;
  onOccasions: (o: { picked: string[]; custom: MonthOccasions["custom"] }) => void;
  refresh: () => Promise<void>;
}) {
  const [y, m] = month.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const offset = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 1) % 7; // weeks start on Saturday
  // Ticks show at once; the saved month catches up a moment later.
  const saved = config?.occasions;
  const savedKey = JSON.stringify([saved?.picked ?? [], saved?.custom ?? [], saved?.photos ?? {}]);
  const [sel, setSel] = useState<MonthOccasions | undefined>(saved);
  useEffect(() => setSel(saved), [savedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const picked = new Set(sel?.picked ?? []);
  const custom = (sel?.custom ?? []).filter((c) => c.date.startsWith(`${month}-`));
  const calendar = occasionsOf(month);
  const all = [
    ...calendar,
    ...custom.map((c) => ({ id: c.id, date: c.date, name: c.name, ar: "", category: "commercial" as const, elements: c.elements ?? "", portrait: false, major: false })),
  ].sort((a, b) => a.date.localeCompare(b.date));
  const chosen = all.filter((o) => picked.has(o.id) || o.id.startsWith("c-"));
  const planned = plan.length && plan.every((x) => x.date) ? plan.map((x) => x.date!) : spreadDates(month, count);
  const postsOn = (d: string) => planned.filter((x) => x === d).length;
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ date: `${month}-01`, name: "" });
  const [uploading, setUploading] = useState("");
  const photoInput = useRef<HTMLInputElement>(null);
  const photoFor = useRef("");

  const change = (next: { picked?: string[]; custom?: MonthOccasions["custom"] }) => {
    setSel((s0) => ({ ...(s0 ?? {}), ...next }));
    onOccasions({ picked: next.picked ?? sel?.picked ?? [], custom: next.custom ?? sel?.custom ?? [] });
  };
  const toggle = (id: string) => change({ picked: picked.has(id) ? [...picked].filter((x) => x !== id) : [...picked, id] });
  const addCustom = () => {
    if (!draft.name.trim() || !draft.date.startsWith(`${month}-`)) return;
    const id = `c-${Date.now().toString(36)}`;
    change({ custom: [...(sel?.custom ?? []), { id, date: draft.date, name: draft.name.trim() }] });
    setDraft({ date: draft.date, name: "" });
    setAdding(false);
  };
  const removeCustom = (id: string) => change({ custom: (sel?.custom ?? []).filter((c) => c.id !== id) });
  async function uploadPortrait(file: File | undefined) {
    const id = photoFor.current;
    if (!file || !id || !batchId) return;
    setUploading(id);
    try {
      const form = new FormData();
      form.append("file", file);
      await postForm(`/api/studio/posts/occasion-photo?batch=${encodeURIComponent(batchId)}&occasion=${encodeURIComponent(id)}`, form);
      await refresh();
      toast.success("Official portrait added. It is framed on the greeting post exactly as uploaded.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading("");
      if (photoInput.current) photoInput.current.value = "";
    }
  }

  return (
    <div className="journey-box">
      <BoxTitle
        kit="direction"
        actions={
          <button type="button" className="text-button" onClick={() => setAdding((v) => !v)}>
            <Plus size={13} /> Add occasion
          </button>
        }
      >
        {monthLabel(month)}
      </BoxTitle>
      <div className="journey-cal compact">
        {["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"].map((d) => (
          <small key={d}>{d}</small>
        ))}
        {Array.from({ length: offset }, (_, i) => (
          <span key={`e${i}`} />
        ))}
        {Array.from({ length: days }, (_, i) => {
          const date = `${month}-${String(i + 1).padStart(2, "0")}`;
          const occ = chosen.filter((o) => o.date === date);
          const n = postsOn(date);
          return (
            <span key={date} style={{ "--i": i } as React.CSSProperties} className={`cal-day ${n ? "post" : ""} ${occ.length ? "occasion" : ""}`} title={occ.map((o) => o.name).join("\n")}>
              {i + 1}
              {n > 0 && <i />}
            </span>
          );
        })}
      </div>
      {adding && (
        <div className="occ-add">
          <input type="date" value={draft.date} min={`${month}-01`} max={`${month}-${String(days).padStart(2, "0")}`} onChange={(e) => setDraft((d) => ({ ...d, date: e.target.value }))} />
          <input dir="auto" value={draft.name} placeholder="Occasion (a branch opening, the brand's anniversary…)" onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} onKeyDown={(e) => e.key === "Enter" && addCustom()} />
          <button type="button" className="secondary" onClick={addCustom} disabled={!draft.name.trim()}>
            Add
          </button>
        </div>
      )}
      <p className="field-hint">Occasions are optional: tick the ones the brand greets this month. Each one becomes a greeting post on its day.</p>
      <ul className="occ-list">
        {all.map((o) => {
          const on = picked.has(o.id) || o.id.startsWith("c-");
          const hasPhoto = !!sel?.photos?.[o.id];
          return (
            <li key={o.id} className={`occ ${on ? "on" : ""} ${o.major && !on ? "warn" : ""}`}>
              <label>
                <input type="checkbox" checked={on} onChange={() => (o.id.startsWith("c-") ? removeCustom(o.id) : toggle(o.id))} />
                <span className="occ-date">{shortDate(o.date)}</span>
                <span className="occ-name">
                  {o.name}
                  {o.ar && <small dir="rtl">{o.ar}</small>}
                </span>
                <span className={`journey-tag occ-${o.category}`}>{o.id.startsWith("c-") ? "yours" : o.category}</span>
              </label>
              {o.major && !on && <em className="occ-warning">Big day without a post</em>}
              {on && o.portrait && (
                <button
                  type="button"
                  className={`text-button occ-photo ${hasPhoto ? "done" : ""}`}
                  disabled={!!uploading}
                  onClick={() => {
                    photoFor.current = o.id;
                    photoInput.current?.click();
                  }}
                  title="Upload the official portrait: it is framed on the post exactly as it is, never redrawn"
                >
                  {uploading === o.id ? <LoaderCircle className="spinning" size={12} /> : hasPhoto ? <Check size={12} /> : <ImagePlus size={12} />}
                  {hasPhoto ? "Portrait added" : "Official portrait"}
                </button>
              )}
            </li>
          );
        })}
        {!all.length && <li className="field-hint">No occasions this month. Add your own with "Add occasion".</li>}
      </ul>
      <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" hidden onChange={(e) => void uploadPortrait(e.target.files?.[0])} />
    </div>
  );
}

/* ───────────── Colours ───────────── */

function ColourPreview({
  palette,
  products,
  sourceUrl,
}: {
  palette: { name: string; hex: string }[];
  products: Source[];
  sourceUrl: (id: string) => string;
}) {
  const [bg, ...rest] = palette;
  return (
    <div className="journey-box">
      <BoxTitle kit="colours">How a post sits in these colours</BoxTitle>
      <div className="colour-stage" style={{ background: bg?.hex ?? "#f2f2f2" }}>
        <div className="colour-props">
          {rest.slice(0, 4).map((c) => (
            <span key={c.hex} style={{ background: c.hex }} title={c.name} />
          ))}
        </div>
        <div className="colour-products">
          {products.slice(0, 3).map((s) => (
            <img key={s.id} src={sourceUrl(s.id)} alt="" />
          ))}
        </div>
        <small className="colour-caption">Background {bg?.name || bg?.hex || "not set"}</small>
      </div>
    </div>
  );
}

/* ───────────── Ideas and captions ───────────── */

function IdeasStep({
  plan,
  config,
  busy,
  rewriting,
  batchId,
  refresh,
  productNames,
  onGenerate,
  onSavePlan,
  onRewrite,
}: {
  plan: Post[];
  config: Config | null;
  busy: boolean;
  rewriting: boolean;
  batchId: string | null;
  refresh: () => Promise<void>;
  productNames: string[];
  onGenerate: () => void;
  onSavePlan: (plan: Post[]) => void;
  onRewrite: (index: number, plan: Post[]) => void;
}) {
  // An occasion ticked after the ideas were written gets its greeting post here (only that post
  // is written again, the rest of the month stays).
  const month = config?.month ?? "";
  const missing = pickedOccasions(month, config?.occasions).filter(
    (o) => !plan.some((x) => x.type === "greeting" && x.occasion === o.id),
  );
  const [adding, setAdding] = useState(false);
  const tried = useRef("");
  useEffect(() => {
    const key = missing.map((o) => o.id).join(",");
    if (!batchId || !plan.length || busy || adding || !key || tried.current === key) return;
    tried.current = key;
    setAdding(true);
    void post<{ added: string[] }>("/api/studio/posts/occasion-posts", { batch: batchId })
      .then(async (r) => {
        await refresh();
        if (r.added.length) toast.success(`Greeting post added for ${r.added.join(", ")}.`);
      })
      .catch((e: Error) => toast.error(e.message))
      .finally(() => setAdding(false));
  }, [batchId, plan.length, busy, missing.map((o) => o.id).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const occasionName = (id?: string) => pickedOccasions(month, config?.occasions).find((o) => o.id === id)?.name;
  // Every post on one screen: up to six across, the rows share the height.
  const n = Math.max(1, plan.length || 4);
  const cols = n <= 4 ? n : n <= 8 ? Math.ceil(n / 2) : 6;
  const rows = Math.ceil(n / cols);
  const grid = {
    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
    gridTemplateRows: rows <= 3 ? `repeat(${rows}, minmax(0, 1fr))` : undefined,
    gridAutoRows: rows > 3 ? "minmax(240px, 1fr)" : undefined,
  };
  // The shots are read after the ideas now: only the screens before this one make them stale.
  const briefAt = Math.max(
    0,
    ...Object.entries(config?.brief ?? {})
      .filter(([k]) => k !== "shots")
      .map(([, n]) => n?.at ?? 0),
  );
  const stale = plan.length > 0 && Math.max(briefAt, config?.gridAt ?? 0) > (config?.plannedAt ?? 0);
  const started = useRef(false);
  // Ideas are written by themselves only for a month that has none, once it has loaded (a reload
  // that lands here must never overwrite ideas that are still on their way).
  useEffect(() => {
    if (!config || config.plan?.length || plan.length || busy || started.current) return;
    started.current = true;
    onGenerate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, plan.length]);
  return (
    <>
      <div className="journey-head">
        <KitIcon kit="voice" size={18} />
        <div>
          <h2>Ideas and dates</h2>
          <p>
            {busy
              ? "Writing the month from the whole brief: products, colours, pins and the occasions…"
              : adding
                ? `Adding the greeting post${missing.length > 1 ? "s" : ""} for ${missing.map((o) => o.name).join(", ")}…`
                : stale
                  ? "The brief changed after these ideas were written. Write them again to follow it."
                  : "Every post is lifestyle with your product by default. Change a post's type to make it a tip, a quote, an offer or an announcement; it is written again for that type. The captions are written after the pictures, from what each one shows."}
          </p>
        </div>
        <button type="button" className="secondary journey-head-action" onClick={onGenerate} disabled={busy}>
          {busy ? <LoaderCircle className="spinning" size={15} /> : <Wand2 size={15} />}
          {plan.length ? "Write the ideas again" : "Generate ideas"}
        </button>
      </div>
      {busy && !plan.length ? (
        <div className="journey-boxes idea-grid" style={grid}>
          {Array.from({ length: n }, (_, i) => (
            <div key={i} className="journey-box idea-card skeleton" style={{ "--i": i } as React.CSSProperties}>
              <div className="analysis-skeleton">
                <i />
                <i />
                <i />
                <i />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className={`journey-boxes idea-grid ${rows > 3 ? "scrolls" : ""}`} style={grid}>
          {plan.map((post, i) => (
            <IdeaCard
              key={`${post.index}:${config?.plannedAt ?? 0}:${post.type}:${post.title}`}
              post={post}
              order={i}
              compact={rows > 1}
              occasion={occasionName(post.occasion)}
              productNames={productNames}
              rewriting={rewriting}
              onSave={(next) => onSavePlan(plan.map((x) => (x.index === next.index ? next : x)))}
              onRewrite={(next) => onRewrite(next.index, plan.map((x) => (x.index === next.index ? next : x)))}
            />
          ))}
        </div>
      )}
    </>
  );
}

function IdeaCard({
  post,
  order,
  compact,
  occasion,
  productNames,
  rewriting,
  onSave,
  onRewrite,
}: {
  post: Post;
  order: number;
  compact: boolean;
  occasion?: string;
  productNames: string[];
  rewriting: boolean;
  onSave: (p: Post) => void;
  onRewrite: (p: Post) => void;
}) {
  const [headline, setHeadline] = useState(post.headline ?? "");
  const [offer, setOffer] = useState<Post["offer"]>(post.offer);
  const save = () => {
    if (headline !== (post.headline ?? "")) onSave({ ...post, headline: headline || undefined });
  };
  const isOffer = post.type === "offer";
  return (
    <article className={`journey-box idea-card ${compact ? "compact" : ""}`} style={{ "--i": order } as React.CSSProperties}>
      <div className="idea-meta">
        <span className="idea-index">{String(post.index).padStart(2, "0")}</span>
        {post.date && <span className="journey-tag">{shortDate(post.date)}</span>}
        <select
          className="idea-type"
          value={post.type}
          disabled={rewriting}
          aria-label="Post type"
          title="Changing the type writes this post again for that type"
          onChange={(e) => {
            const type = e.target.value as Post["type"];
            if (type === "offer") {
              // An offer waits for its products, price and contents before it is written.
              const o = post.offer ?? { products: post.product ? [post.product] : [], price: "", details: "" };
              setOffer(o);
              onSave({ ...post, type, offer: o });
              return;
            }
            onRewrite({ ...post, type, offer: undefined, headline: headline || undefined });
          }}
        >
          {POST_TYPES.filter((t) => t !== "greeting" || post.type === "greeting").map((t) => (
            <option key={t} value={t}>
              {POST_TYPE_INFO[t].label}
            </option>
          ))}
        </select>
        {occasion && <span className="journey-tag occ-religious">{occasion}</span>}
      </div>
      <strong className="idea-title">{post.title}</strong>
      {isOffer ? (
        <div className="idea-offer">
          <div className="offer-products">
            {productNames.map((n) => {
              const on = !!offer?.products.includes(n);
              return (
                <button
                  key={n}
                  type="button"
                  className={`chip ${on ? "on" : ""}`}
                  onClick={() =>
                    setOffer((o) => {
                      const cur = o ?? { products: [], price: "", details: "" };
                      return { ...cur, products: on ? cur.products.filter((x) => x !== n) : [...cur.products, n] };
                    })
                  }
                >
                  {n}
                </button>
              );
            })}
          </div>
          <input dir="auto" value={offer?.price ?? ""} placeholder="Price: 15 JD, ٢ علب بـ ١٥ دينار" onChange={(e) => setOffer((o) => ({ products: o?.products ?? [], details: o?.details ?? "", price: e.target.value }))} />
          <textarea dir="auto" rows={2} value={offer?.details ?? ""} placeholder="What is in the offer, conditions and dates" onChange={(e) => setOffer((o) => ({ products: o?.products ?? [], price: o?.price ?? "", details: e.target.value }))} />
          <button
            type="button"
            className="secondary"
            disabled={rewriting || !offerReady(offer)}
            onClick={() => onRewrite({ ...post, offer })}
            title={offerReady(offer) ? "" : "Pick the products, write the price and what the offer includes"}
          >
            {rewriting ? <LoaderCircle className="spinning" size={13} /> : <Wand2 size={13} />} Write the offer post
          </button>
        </div>
      ) : null}
      <input className="idea-headline" dir="auto" value={headline} onChange={(e) => setHeadline(e.target.value)} onBlur={save} aria-label="Headline on the image" />
      <p className="idea-brief">{post.brief}</p>
    </article>
  );
}

/* ───────────── A feed grid the month follows ───────────── */

function GridPick({
  clientId,
  clientName,
  gridFonts,
  monthFonts,
  onFonts,
  gridRef,
  admin,
  onPick,
  onClear,
}: {
  clientId: string;
  clientName: string;
  gridFonts?: { headline: string; body: string; why: string };
  monthFonts?: { headline: string; body: string };
  onFonts: (f: { headline: string; body: string } | null) => void;
  gridRef: string | null;
  admin: boolean;
  onPick: (id: string) => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const styleId = gridRef?.startsWith("style:") ? gridRef.slice(6) : null;
  const info = useStyleInfo([styleId]);
  const g = styleId ? info.get(styleId) : undefined;
  return (
    <div className={`journey-grid-pick ${gridRef ? "on" : ""}`}>
      {gridRef ? (
        <img src={styleId ? styleThumb({ id: styleId, updated: g?.updated ?? 0 }) : `/api/studio/references/${gridRef}/file`} alt="" />
      ) : (
        <span className="journey-grid-icon">
          <Grid3x3 size={18} />
        </span>
      )}
      <span className="journey-grid-text">
        <strong>{gridRef ? `This month follows ${g ? `“${g.title}”` : "a grid"}` : "Follow a grid"}</strong>
        <small>
          {gridRef
            ? `${g?.tiles ? `${g.tiles} posts, one for each tile. ` : ""}The ideas and the shots are written from its tiles, with your products, people and colours.`
            : "Pick a whole Instagram feed from the library: the month follows its rhythm tile by tile."}
        </small>
      </span>
      <button type="button" className="secondary" onClick={() => setOpen(true)}>
        <Grid3x3 size={14} /> {gridRef ? "Change" : "Pick a grid"}
      </button>
      {gridRef && (
        <button type="button" className="text-button" onClick={onClear}>
          Stop following
        </button>
      )}
      {gridRef && gridFonts && (
        <span className="journey-grid-fonts" title={gridFonts.why}>
          <small>The grid's lettering:</small>
          <b style={{ fontFamily: `"${gridFonts.headline}"` }}>{gridFonts.headline}</b>
          <span>+</span>
          <b style={{ fontFamily: `"${gridFonts.body}"`, fontWeight: 400 }}>{gridFonts.body}</b>
          {monthFonts?.headline === gridFonts.headline && monthFonts.body === gridFonts.body ? (
            <button type="button" className="text-button" onClick={() => onFonts(null)}>
              Back to the brand's fonts
            </button>
          ) : (
            <button type="button" className="secondary" onClick={() => onFonts({ headline: gridFonts.headline, body: gridFonts.body })}>
              Use them this month
            </button>
          )}
        </span>
      )}
      <StyleScreen
        open={open}
        onClose={() => setOpen(false)}
        admin={admin}
        forClient={{ id: clientId, name: clientName }}
        pick={{ mode: "feed", tab: "grid", client: clientId, onPick: (ids) => onPick(ids[0]) }}
      />
    </div>
  );
}

/* ───────────── Let the magic begin ───────────── */

function MagicStep({
  blocked,
  onShowIssues,
  client,
  month,
  plan,
  format,
  theme,
  config,
  testPost,
  exact,
  onExact,
  onTest,
  onFixTest,
  onGenerate,
  batchId,
  overlay,
  logoSrc,
}: {
  batchId: string | null;
  overlay: OverlaySpec;
  logoSrc: string | null;
  blocked: boolean;
  onShowIssues: () => void;
  client: Client;
  month: string;
  plan: Post[];
  format: Format;
  theme: Theme | null;
  config: Config | null;
  testPost: TestPost | null;
  exact: boolean;
  onExact: (on: boolean) => void;
  onTest: (index: number) => Promise<void>;
  onFixTest: (edit: string) => Promise<void>;
  onGenerate: () => Promise<void>;
}) {
  const [going, setGoing] = useState(false);
  const [testing, setTesting] = useState(false);
  // The grid the month follows, shown next to the test grid.
  const refId = config?.gridRef?.startsWith("style:") ? config.gridRef.slice(6) : null;
  const refItem = useStyleInfo([refId]).get(refId ?? "");
  const reference = refItem ? styleThumb(refItem, true) : null;
  // The test post: the most telling one (a product with people, then a product), unless picked.
  const telling =
    plan.find((x) => x.type === "lifestyle" && x.product && x.people?.length) ??
    plan.find((x) => x.product && x.type !== "greeting") ??
    plan[0];
  const [pick, setPick] = useState<number>(testPost?.index ?? telling?.index ?? 1);
  useEffect(() => {
    if (testPost) setPick(testPost.index);
  }, [testPost?.index]); // eslint-disable-line react-hooks/exhaustive-deps
  const testBusy = !!testPost && ["queued", "processing", "finalizing"].includes(testPost.status);
  const reviewing = !!testPost?.url && !testBusy && !testPost.qa?.automated && /still running/i.test(testPost.qa?.notes ?? "");
  const flags = testPost?.qa?.automated ? (testPost.qa.flags ?? []) : null;
  async function runTest() {
    if (blocked) return onShowIssues();
    setTesting(true);
    try {
      await onTest(pick);
    } finally {
      setTesting(false);
    }
  }
  const lines = briefLines(config?.brief);
  const shown = useCountUp(plan.length);
  const chosen = !!theme?.palette.length;
  const about = theme
    ? (chosen ? withoutPaletteText(theme.description || "") : theme.description) ||
      (chosen ? "The pins' places, light and mood, in the month's colours below." : theme.direction?.slice(0, 180))
    : "The posts follow the brand kit.";
  const palette = theme?.palette.length ? theme.palette : client.colors;
  const dates = plan.map((x) => x.date).filter(Boolean) as string[];
  const occasions = useMemo(() => occasionsOf(month), [month]);
  return (
    <div className="journey-magic">
      <div className="magic-sparkles" aria-hidden>
        {Array.from({ length: 14 }, (_, i) => (
          <i
            key={i}
            style={
              {
                "--i": i,
                left: `${(i * 37 + 7) % 100}%`,
                top: `${(i * 53 + 11) % 92}%`,
                fontSize: `${10 + ((i * 7) % 14)}px`,
              } as React.CSSProperties
            }
          >
            ✦
          </i>
        ))}
      </div>
      <h1 className="journey-hello magic">
        <span className="journey-hello-text">Let the magic begin</span>{" "}
        <span className="journey-emoji" aria-hidden>
          ✨
        </span>
      </h1>
      <div className="journey-boxes cols-magic">
        <div className="magic-col">
        <div className="journey-box magic-box">
          <BoxTitle kit="output">The posts</BoxTitle>
          <p className="magic-big">{shown}</p>
          <p className="field-hint">
            {FORMAT_INFO[format].label} ({FORMAT_INFO[format].pixels}) · {client.name} · {monthLabel(month)}
            {dates.length ? `, from ${shortDate(dates[0])} to ${shortDate(dates[dates.length - 1])}` : ""}.
          </p>
          {occasions.length > 0 && <p className="field-hint">Occasions: {occasions.map((o) => o.name).join(", ")}.</p>}
        </div>
        <div className="journey-box magic-box">
          <BoxTitle kit="theme">The theme</BoxTitle>
          <p className="magic-theme">{theme?.title ?? "Brand identity"}</p>
          <p className="field-hint">{about}</p>
          <div className="magic-swatches">
            {palette.map((c, i) => (
              <span key={c.hex + i} style={{ background: c.hex, "--i": i } as React.CSSProperties} title={`${i === 0 ? "Background · " : ""}${c.name || c.hex}`} />
            ))}
          </div>
        </div>
        </div>
        <TestGrid batchId={batchId} plan={plan} overlay={overlay} logoSrc={logoSrc} reference={reference} blocked={blocked} onShowIssues={onShowIssues} />
        {testPost ? (
          <div className="journey-box magic-box magic-test">
            <BoxTitle kit="output">Test post {String(testPost.index).padStart(2, "0")}</BoxTitle>
            <div className="magic-test-body">
              <div className="magic-test-image">
                {testPost.url && !testBusy ? (
                  <a href={testPost.url} target="_blank" rel="noreferrer" title="Open full size">
                    <img src={testPost.url} alt={`Test post ${testPost.index}`} />
                  </a>
                ) : testPost.status === "failed" ? (
                  <span className="magic-test-wait">Failed: {testPost.error ?? "try again"}</span>
                ) : (
                  <span className="magic-test-wait">
                    <LoaderCircle className="spinning" size={18} /> Generating…
                  </span>
                )}
              </div>
              <div className="magic-test-review">
                {testBusy ? (
                  <p className="field-hint">The image arrives in about a minute, then I check it against the product photo.</p>
                ) : reviewing ? (
                  <p className="field-hint">
                    <LoaderCircle className="spinning" size={13} /> Checking the product, writing, bags, drinks and people…
                  </p>
                ) : flags ? (
                  flags.length ? (
                    <>
                      <strong className="magic-test-warn">Check these</strong>
                      <ul>
                        {flags.map((f, i) => (
                          <li key={i}>{f.text}</li>
                        ))}
                      </ul>
                      <button type="button" className="text-button" onClick={() => void onFixTest(fixNote(flags))}>
                        <Wand2 size={13} /> Fix these on the test
                      </button>
                    </>
                  ) : (
                    <strong className="magic-test-ok">
                      <Check size={14} /> Passed the automatic review
                    </strong>
                  )
                ) : testPost.url ? (
                  <p className="field-hint">{testPost.qa?.notes || "Look at it before you go on."}</p>
                ) : null}
                {testPost.url && !testBusy && (
                  <p className="field-hint">
                    {testPost.draft
                      ? "Made at 1K to check the look; it is made again at full size with the rest."
                      : "Made at full size: if it looks right it stays as the final image."}
                  </p>
                )}
              </div>
            </div>
          </div>
        ) : (
        <div className="journey-box magic-box">
          <BoxTitle kit="direction">The logic</BoxTitle>
          {lines.length ? (
            <ol className="magic-logic">
              {lines.map((l, i) => (
                <li key={i} style={{ "--i": i } as React.CSSProperties}>
                  {l}
                </li>
              ))}
            </ol>
          ) : (
            <p className="field-hint">The brand kit, the theme and the products steer every post.</p>
          )}
        </div>
        )}
      </div>
      <button
        type="button"
        className="primary journey-generate"
        disabled={going || !plan.length}
        data-blocked={blocked || undefined}
        onClick={async () => {
          if (blocked) return onShowIssues();
          setGoing(true);
          try {
            await onGenerate();
          } finally {
            setGoing(false);
          }
        }}
      >
        {going ? <LoaderCircle className="spinning" size={18} /> : <Sparkles size={18} />}
        {testPost?.url && !testBusy ? `Looks right · generate the other ${Math.max(0, plan.length - (testPost.draft ? 0 : 1))}` : `Generate ${plan.length} posts`}
      </button>
      <div className="magic-test-row">
        <label
          className="check-row magic-exact"
          title="The engine paints the scene with an empty place, then the real product photo is set into it with its shadow. The product can never change; nobody holds it. Posts with one product."
        >
          <input type="checkbox" checked={exact} onChange={(e) => onExact(e.target.checked)} />
          <strong>Exact product</strong>
        </label>
        <i className="magic-test-sep" aria-hidden />
        <span>{testPost ? "Not right? Test again:" : "Not sure yet? Test one post first:"}</span>
        <select value={pick} onChange={(e) => setPick(Number(e.target.value))} aria-label="Post to test">
          {plan.map((x) => (
            <option key={x.index} value={x.index}>
              Post {x.index} · {x.title.slice(0, 32)}
            </option>
          ))}
        </select>
        <button type="button" className="secondary" disabled={testing || testBusy || !plan.length} onClick={() => void runTest()}>
          {testing || testBusy ? <LoaderCircle className="spinning" size={14} /> : <FlaskConical size={14} />}
          {testPost ? "Test again" : "Test one post"}
        </button>
      </div>
    </div>
  );
}
