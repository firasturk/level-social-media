import { lazyScreen } from "@/lib/lazy";
import SetupChecklist from "./SetupChecklist";
import MonthVersions from "./MonthVersions";
import MonthPanel from "./MonthPanel";
import type { TypoStyle } from "@shared/typography";
import { askConfirm } from "@/lib/confirm";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiError, del, get, post, postForm, postPaid, put } from "@/api";
import { useTheme } from "@/theme";
import { makeReference } from "@/lib/image";
import { buildZips, saveBlob, saveZips, type ZipEntry } from "@/lib/zip";
import { canvasBlob, loadFont, loadImage, renderOverlay, facesOf } from "@/lib/overlay";
import { buildFeedPdf, type FeedPost } from "@/lib/feedPdf";
import { HEADLINE_FONTS, resolveOverlay } from "@shared/overlay";
import { postConfig, type Config, type Size } from "@shared/config";
import { currentMonth, lineageUnknown, monthLabel, olderIdea, postFileName, type Format, type Post } from "@shared/posts";
import { blocking, monthIssues, sceneContext } from "@shared/issues";
import { formatUsd, rateFor, setPricesHidden, testSize } from "@shared/pricing";
import type {
  Ambassador,
  Batch,
  Client,
  EngineModel,
  StateResponse,
  PersonSpend,
  QA,
  Take,
  Task,
  Theme,
  User,
} from "@shared/types";
import Sidebar, { type Page } from "./Sidebar";
import BootScreen from "./BootScreen";
import BrandPanel, { type OutputSettings } from "./BrandPanel";
import PlanView, { displayName } from "./PlanView";
import Journey from "./Journey";
import Flow from "./Flow";
import type { JourneyPost } from "./JourneyResults";
import Radio, { stopRadio } from "./Radio";
import BriefCard from "./BriefCard";
import StudioBoard, { ApprovalView, WordsView, type StudioTab } from "./StudioBoard";
import BrandChip from "./BrandChip";
import StyleScreen from "./StyleGallery";
import { askNotifications, chime, notify } from "@/lib/celebrate";
import { Compass, FolderOpen, PanelLeft } from "lucide-react";
import { useBatch } from "./useBatch";
import { ACCEPTED_TYPES, MAX_UPLOAD_BYTES } from "./constants";
import type { EngineInfo } from "./ConnectionDialog";
const AdminView = lazyScreen(() => import("./AdminView"));
const BatchesView = lazyScreen(() => import("./BatchesView"));
const ReviewDialog = lazyScreen(() => import("./ReviewDialog"));
import type { PostEditorTools, Group as EditorGroup } from "./ReviewDialog";
const ConnectionDialog = lazyScreen(() => import("./ConnectionDialog"));

const CLIENT_KEY = "lsm-client";
/** The start journey shows once per browser session (a new tab or a new sign-in starts one). */
const JOURNEY_KEY = "lsm-journey-done";

function journeyDone(): boolean {
  try {
    return sessionStorage.getItem(JOURNEY_KEY) === "1";
  } catch {
    return true;
  }
}
/** The journey was open when the page was left: a refresh brings the team back into it. */
const JOURNEY_OPEN_KEY = "lsm-journey-open";
function journeyOpen(): boolean {
  try {
    return sessionStorage.getItem(JOURNEY_OPEN_KEY) === "1";
  } catch {
    return false;
  }
}
const MONTH_KEY = "lsm-month";
/** The style library has its own address: the team opens it straight from a link or a bookmark. */
const STYLES_PATH = "/styles";
const atStyles = () => window.location.pathname.replace(/\/$/, "") === STYLES_PATH;
/** The admin's Approvals page has its own address too. */
const APPROVALS_PATH = "/approvals";
const atApprovals = () => window.location.pathname.replace(/\/$/, "") === APPROVALS_PATH;
const pathOf = (p: Page) => (p === "styles" ? STYLES_PATH : p === "approvals" ? APPROVALS_PATH : "/");
const pageAt = (): Page | null => (atStyles() ? "styles" : atApprovals() ? "approvals" : null);

function remembered(key: string): string {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
}
function remember(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

/** The studio: a client, a month, its plan of posts. */
export default function Workspace({
  user,
  onSignedOut,
}: {
  user: User;
  onSignedOut: () => void;
}) {
  const [page, setPage] = useState<Page>(() => pageAt() ?? "studio");
  // The address follows the page (and Back returns from the styles), so /styles can be bookmarked.
  useEffect(() => {
    const want = pathOf(page);
    if (want !== (pageAt() ? pathOf(pageAt()!) : "/")) window.history.pushState(null, "", want);
  }, [page]);
  useEffect(() => {
    const onPop = () => setPage((p) => pageAt() ?? (p === "styles" || p === "approvals" ? "studio" : p));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [spend, setSpend] = useState<PersonSpend[]>([]);
  /** Deleted months waiting in the bin, restorable. */
  const [trash, setTrash] = useState<Batch[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [themes, setThemes] = useState<Theme[]>([]);
  const [models, setModels] = useState<EngineModel[]>([]);
  /** Version stamp of the admin's hero video, shown at the top of the studio ("" for none). */
  const [hero, setHero] = useState("");
  const [engine, setEngine] = useState<EngineInfo>({
    model: "",
    configured: false,
    source: "none",
    openai: "none",
    google: "none",
    fal: "none",
    review: false,
  });
  const [connection, setConnection] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const [stateReady, setStateReady] = useState(false);
  const [bootTimedOut, setBootTimedOut] = useState(false);
  const [clientId, setClientId] = useState<string>(() => remembered(CLIENT_KEY));
  // The studio makes grids for the month we are in: it opens on the current calendar month, never on a later one.
  const [month, setMonth] = useState<string>(() => currentMonth());
  /** Which grid of a client's month is open, when the month holds several ("client|month" → batch id). */
  const [gridPick, setGridPick] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState("");
  const [exporting, setExporting] = useState(false);
  const [acting, setActing] = useState(false);
  const [selected, setSelected] = useState<Task | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [showOverlay, setShowOverlay] = useState(true);
  const [themeRefs, setThemeRefs] = useState<{ id: string; name: string | null }[]>([]);
  const { batch, sources, tasks, active, open, close, refresh, action, remove } = useBatch();
  const [journey, setJourney] = useState(() => (!journeyDone() || journeyOpen()) && !pageAt());
  /** The four-stage workflow (Start, Direction, Plan, Studio) instead of the journey: an admin flag. */
  const [workflowV2, setWorkflowV2] = useState(false);
  /** Autopilot stops at the plan for a look (admin setting), and the spend threshold a run must stay under by itself. */
  const [autopilotReview, setAutopilotReview] = useState(false);
  const [spendThreshold, setSpendThreshold] = useState(20);
  /** A preview deployment: a strip says that no picture is made here. */
  const [previewMode, setPreviewMode] = useState(false);
  /** The brand kit panel beside the posts: folded away once a month has pictures, unless the team opened it. */
  const [kitOpen, setKitOpen] = useState<boolean | null>(null);
  /** Notes for the ideas writer, kept with the month's things in the side panel. */
  const [monthNotes, setMonthNotes] = useState("");
  // Only "Skip to the studio" or Generate leaves the journey: a refresh keeps the team in it.
  useEffect(() => {
    try {
      if (journey) sessionStorage.setItem(JOURNEY_OPEN_KEY, "1");
      else sessionStorage.removeItem(JOURNEY_OPEN_KEY);
    } catch {
      /* private mode */
    }
  }, [journey]);
  /** Opens the journey straight on the month's feed. */
  const openFeed = useCallback(() => {
    try {
      localStorage.setItem("lsm-journey-step", JSON.stringify({ client: clientId, month, step: 11 }));
    } catch {
      /* private mode */
    }
    setJourney(true);
  }, [clientId, month]);

  /** Leaves the journey for the studio, scrolled to the month's posts (or to one post). */
  const finishJourney = useCallback((focus?: number) => {
    try {
      sessionStorage.setItem(JOURNEY_KEY, "1");
    } catch {
      /* private mode */
    }
    setJourney(false);
    setPage("studio");
    // The posts sit under the brand kit and the products: the studio opens on them.
    let tries = 0;
    const go = () => {
      const el = document.getElementById(focus ? `post-card-${focus}` : "month-posts");
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        if (focus) {
          el.classList.add("post-card-focus");
          setTimeout(() => el.classList.remove("post-card-focus"), 2400);
        }
      } else if (tries++ < 20) setTimeout(go, 150);
    };
    setTimeout(go, 200);
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setBootTimedOut(true), 7000);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => remember(CLIENT_KEY, clientId), [clientId]);
  useEffect(() => {
    document.body.classList.toggle("preview-on", previewMode);
  }, [previewMode]);
  useEffect(() => setKitOpen(null), [clientId, month]);
  useEffect(() => remember(MONTH_KEY, month), [month]);

  const loadState = useCallback(async () => {
    try {
      const d = await get<StateResponse>("/api/studio/state");
      setBatches(d.batches);
      setTrash(d.trash ?? []);
      setSpend(d.spend ?? []);
      setEngine(d.engine);
      setWorkflowV2(!!d.workflowV2);
      setPricesHidden(!!d.pricesHidden);
      setAutopilotReview(!!d.autopilotReview);
      setSpendThreshold(Number(d.spendThreshold ?? 20));
      setPreviewMode(!!d.preview);
      setHero(d.hero ?? "");
      const list = d.clients ?? [];
      setClients(list);
      setClientId((id) => {
        const active = list.filter((c) => c.status === "active");
        return active.some((c) => c.id === id) ? id : (active[0]?.id ?? "");
      });
    } catch (e) {
      toast.error((e as Error).message);
    }
  }, []);
  const loadModels = useCallback(async () => {
    try {
      setModels((await get<{ models: EngineModel[] }>("/api/studio/engine/models")).models);
    } catch {
      setModels([]);
    }
  }, []);
  const loadThemes = useCallback(async (client: string) => {
    if (!client) return setThemes([]);
    try {
      setThemes(
        (await get<{ themes: Theme[] }>(`/api/studio/posts/themes?client=${encodeURIComponent(client)}`))
          .themes,
      );
    } catch {
      setThemes([]);
    }
  }, []);

  useEffect(() => {
    void loadState()
      .finally(() => setStateReady(true))
      .then(loadModels);
  }, [loadState, loadModels]);
  useEffect(() => {
    void loadThemes(clientId);
  }, [clientId, loadThemes]);
  const [ambassadors, setAmbassadors] = useState<Ambassador[]>([]);
  useEffect(() => {
    if (!clientId) return setAmbassadors([]);
    let live = true;
    get<{ ambassadors: Ambassador[] }>(`/api/studio/ambassadors?client=${encodeURIComponent(clientId)}`)
      .then((r) => live && setAmbassadors(r.ambassadors))
      .catch(() => live && setAmbassadors([]));
    return () => {
      live = false;
    };
  }, [clientId]);
  // The batches page keeps fresh counts while months generate in the background.
  useEffect(() => {
    if (page !== "batches") return;
    void loadState();
    const timer = setInterval(() => {
      if (!document.hidden) void loadState();
    }, 8000);
    return () => clearInterval(timer);
  }, [page, loadState]);

  const client = clients.find((c) => c.id === clientId) ?? null;
  const monthFonts = batch?.config ? (JSON.parse(batch.config) as Config).monthFonts : undefined;
  const gridMonth = !!(batch?.config && (JSON.parse(batch.config) as Config).gridRef);
  const overlaySpec = useMemo(() => {
    const spec = resolveOverlay(client?.overlay);
    const src = client?.badge ? `/api/studio/clients/${client.id}/badge?v=${client.updated}` : null;
    // A month that follows a grid may use the grid's fonts instead of the brand's.
    const headline = monthFonts
      ? { ...spec.headline, font: monthFonts.headline, weight: HEADLINE_FONTS.find((f) => f.family === monthFonts.headline)?.weight ?? spec.headline.weight }
      : spec.headline;
    const subline = monthFonts ? { ...spec.subline, font: monthFonts.body } : spec.subline;
    // A grid month's words sit on the picture like the grid's own, without a dark fade behind them
    // (the overlay switches their colour when it would not read).
    return { ...spec, headline, subline, badge: { ...spec.badge, src }, ...(gridMonth ? { scrim: 0 } : {}) };
  }, [client, monthFonts?.headline, monthFonts?.body, gridMonth]); // eslint-disable-line react-hooks/exhaustive-deps
  const logoSrc = client?.logo ? `/api/studio/clients/${client.id}/logo?v=${client.updated}` : null;
  // Brand font files are registered with the browser once per client so the canvas can use them.
  useEffect(() => {
    for (const f of client?.fontFiles ?? [])
      void loadFont(f.name, `/api/studio/clients/${client!.id}/fonts/${f.id}/file`);
  }, [client]);
  /** Every grid of a client's month, newest first. */
  const gridsOf = useCallback((c: string, m: string) => batches.filter((b) => b.client === c && b.month === m), [batches]);
  const planOf = useCallback(
    (c: string, m: string) => {
      const list = gridsOf(c, m);
      if (!list.length) return null;
      const picked = gridPick[`${c}|${m}`];
      return list.find((b) => b.id === picked) ?? list[0];
    },
    [gridsOf, gridPick],
  );
  /** Opens one grid of the current client's month. */
  const pickGrid = useCallback((id: string) => {
    const b = batches.find((x) => x.id === id);
    if (!b?.client || !b.month) return;
    setGridPick((g) => ({ ...g, [`${b.client}|${b.month}`]: id }));
  }, [batches]);
  // The open plan follows the client and the month.
  useEffect(() => {
    const plan = planOf(clientId, month);
    if (plan && batch?.id !== plan.id) void open(plan.id).catch(() => close());
    else if (!plan && batch) close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, month, planOf]);
  // Keep the review dialog on the latest copy of its task.
  useEffect(() => {
    if (selected) {
      const fresh = tasks.find((t) => t.id === selected.id);
      if (fresh && fresh !== selected) setSelected(fresh);
    }
  }, [tasks, selected]);

  const config: Config | null = useMemo(
    () => (batch ? (JSON.parse(batch.config) as Config) : null),
    [batch],
  );
  const plan: Post[] = config?.plan ?? [];
  const settings: OutputSettings = {
    model: config?.model || engine.model,
    format: (config?.format ?? "4:5") as Format,
    size: (config?.size ?? "2K") as Size,
    postCount: config?.postCount ?? 12,
    exact: !!config?.exact,
  };
  const [draftSettings, setDraftSettings] = useState<Partial<OutputSettings>>({});
  useEffect(() => setDraftSettings({}), [batch?.id]);
  const shownSettings = { ...settings, ...draftSettings };
  const useFlow = workflowV2;
  /** Which stage the workflow opens on when a rail button asked for one; otherwise where the month is. */
  const [flowStage, setFlowStage] = useState<0 | 1 | 2 | null>(null);
  /** The classic journey, opened on purpose from the Studio while the workflow is on. */
  const [classic, setClassic] = useState(false);
  /** The Studio board's tab and whether the old month toolbar is unfolded under More. */
  const [studioTab, setStudioTab] = useState<StudioTab>("posts");
  const [toolsOpen, setToolsOpen] = useState(false);
  const themeId = config?.theme ?? (draftSettings as { theme?: string }).theme ?? themes[0]?.id ?? "";
  // The month's cast: ambassadors that still exist, in the order picked.
  const castIds = (
    config?.ambassadors ?? (draftSettings as { ambassadors?: string[] }).ambassadors ?? []
  ).filter((id) => ambassadors.some((a) => a.id === id));
  const loadThemeRefs = useCallback(async (id: string) => {
    if (!id) return setThemeRefs([]);
    try {
      const d = await get<{ references: { id: string; name: string | null }[] }>(
        `/api/studio/references?skill=${encodeURIComponent(id)}`,
      );
      setThemeRefs(d.references);
    } catch {
      setThemeRefs([]);
    }
  }, []);
  useEffect(() => {
    void loadThemeRefs(themeId);
  }, [themeId, themes, loadThemeRefs]);

  const googleReady = !!engine.vertex || engine.google !== "none";
  const engineConnected =
    engine.configured || googleReady || engine.openai !== "none" || engine.fal !== "none";

  const sourceUrl = (id: string, kind = "reference") =>
    `/api/studio/file?batch=${batch?.id}&id=${id}&kind=${kind}`;
  const outputUrl = (t: Task) =>
    `/api/studio/file?batch=${batch?.id}&id=${t.id}&kind=result&v=${t.output?.split("/").at(-1)}`;
  /** The same picture at card size: a smaller JPEG the server keeps, so the grid opens fast. */
  const outputThumb = (t: Task) => `${outputUrl(t)}&w=1080`;

  /** The month's plan, created on first use. */
  async function ensurePlan(): Promise<string> {
    if (batch) return batch.id;
    if (!client) throw new Error("Pick a client first.");
    const existing = planOf(client.id, month);
    if (existing) {
      await open(existing.id);
      return existing.id;
    }
    const cfg = postConfig(client.id, month, {
      theme: themeId || undefined,
      model: shownSettings.model || undefined,
      format: shownSettings.format,
      ratio: shownSettings.format,
      size: shownSettings.size,
      postCount: shownSettings.postCount,
      ambassadors: castIds.length ? castIds : undefined,
    });
    const { id } = await post<{ id: string }>("/api/studio/batch", { config: cfg });
    await loadState();
    await open(id);
    return id;
  }

  /** A fresh grid in the same month: the grids already made stay, each with its own posts, pictures and client link. */
  async function newGrid(): Promise<string> {
    if (!client) throw new Error("Pick a client first.");
    const n = gridsOf(client.id, month).length + 1;
    const cfg = postConfig(client.id, month, {
      theme: themeId || undefined,
      model: shownSettings.model || undefined,
      format: shownSettings.format,
      ratio: shownSettings.format,
      size: shownSettings.size,
      postCount: shownSettings.postCount,
      ambassadors: castIds.length ? castIds : undefined,
    });
    const { id } = await post<{ id: string }>("/api/studio/batch", { config: cfg, name: `${client.name} · ${month} · grid ${n}` });
    setGridPick((g) => ({ ...g, [`${client.id}|${month}`]: id }));
    await loadState();
    await open(id);
    return id;
  }

  /** The client's latest month before this one, when this month has no plan yet. */
  const previousMonth = useMemo(() => {
    if (!clientId || planOf(clientId, month)) return null;
    const earlier = batches
      .filter((b) => b.client === clientId && b.month && b.month < month)
      .map((b) => b.month!)
      .sort();
    return earlier.at(-1) ?? null;
  }, [batches, clientId, month, planOf]);

  /** "Continue with the same direction": the new month starts from the last one. */
  async function continueMonth() {
    if (!clientId) return;
    setBusy("continue");
    try {
      const r = await post<{ id: string; from: string; products: number }>("/api/studio/posts/continue", {
        client: clientId,
        month,
      });
      await loadState();
      await open(r.id);
      toast.success(
        `${monthLabel(month)} continues ${monthLabel(r.from)}: same theme, colours, props and ambassadors${r.products ? `, ${r.products} products` : ""}.`,
      );
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function updateSettings(
    patch: Partial<OutputSettings> & {
      theme?: string;
      ambassadors?: string[];
      exact?: boolean;
      shots?: string[];
      occasions?: { picked: string[]; custom: { id: string; date: string; name: string; elements?: string }[] };
      /** A grid from the style library ("style:<id>"), or null to stop following one. */
      gridRef?: string | null;
      monthFonts?: { headline: string; body: string } | null;
      /** The month's standing rules for the words. */
      notes?: string;
    },
  ) {
    setDraftSettings((d) => ({ ...d, ...patch }));
    if (!batch) return;
    try {
      await put("/api/studio/posts/settings", { batch: batch.id, ...patch });
      await refresh();
      setDraftSettings({});
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  /** Any image the browser can decode is accepted: other formats and big files become JPGs first. */
  async function normalizeUpload(f: File): Promise<File> {
    if (ACCEPTED_TYPES.includes(f.type) && f.size <= MAX_UPLOAD_BYTES) return f;
    try {
      const jpeg = await makeReference(f, 4096, 0.92);
      return new File([jpeg], f.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
    } catch {
      throw new Error(
        `${f.name}: this browser cannot read the file (HEIC and RAW need exporting as JPG or PNG first).`,
      );
    }
  }

  async function uploadProducts(files: File[]) {
    if (!files.length) return;
    setBusy("upload");
    try {
      const id = await ensurePlan();
      let uploaded = 0;
      for (const raw of files) {
        let f: File;
        try {
          f = await normalizeUpload(raw);
        } catch (e) {
          toast.error((e as Error).message);
          continue;
        }
        const form = new FormData();
        form.append("file", f);
        form.append("name", f.name);
        form.append("role", "lead");
        try {
          form.append("reference", await makeReference(f), "reference.jpg");
          await postForm(`/api/studio/upload?batch=${id}`, form);
          uploaded++;
        } catch (e) {
          toast.error(`${f.name}: ${(e as Error).message}`);
        }
      }
      await refresh();
      if (uploaded) toast.success(`${uploaded} product photo${uploaded > 1 ? "s" : ""} added.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function removeProduct(id: string) {
    if (!batch || !(await askConfirm("Remove this product photo and the posts generated from it?")))
      return;
    try {
      await del(`/api/studio/posts/product?batch=${encodeURIComponent(batch.id)}&id=${encodeURIComponent(id)}`);
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  /** A different idea for one post (same type and product), then that post is generated again. */
  async function newIdea(index: number) {
    if (!batch) return;
    if (!googleReady && engine.openai === "none") {
      setConnection(true);
      return;
    }
    setBusy("reidea");
    try {
      const r = await post<{ post: Post }>("/api/studio/posts/reidea", { batch: batch.id, index });
      // Its shot is written again for the new idea (when the theme has pins to borrow from).
      await post("/api/studio/posts/shots", { batch: batch.id, indexes: [index] }).catch(() => {});
      await refresh();
      toast.success(`New idea for post ${index}: "${r.post.title}". Generating it.`);
      if (engineConnected) {
        await post("/api/studio/posts/generate", { batch: batch.id, indexes: [index], regenerate: true });
        await refresh();
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  /** A post whose type changed (or whose offer was filled) is written again for it; no image yet. */
  /** The card's product or people changed: the post's words and idea follow what is on the card now. */
  const [rewriting, setRewriting] = useState<number[]>([]);
  async function refitPosts(indexes: number[]) {
    if (!batch || !indexes.length) return;
    setRewriting((r) => [...new Set([...r, ...indexes])]);
    try {
      for (const index of indexes) {
        try {
          const r = await post<{ post: Post }>("/api/studio/posts/refit", { batch: batch.id, index });
          toast.success(`Post ${index} rewritten for ${[r.post.product, ...(r.post.products ?? [])].filter(Boolean).join(" + ") || "no product"}: "${r.post.title}".`);
        } catch (e) {
          toast.error(`Post ${index}: ${(e as Error).message}`);
        }
      }
      await refresh();
    } finally {
      setRewriting((r) => r.filter((i) => !indexes.includes(i)));
    }
  }
  // A picture made or remade in the studio gets its caption written from it, unless the caption is the designer's.
  const captionsAsked = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!batch) return;
    const due = plan.filter((p) => {
      const t = tasks.find((x) => x.post === p.index);
      if (!t?.output || ["queued", "processing", "finalizing"].includes(t.status) || p.captionHand || p.captionFrom === t.output) return false;
      const key = `${t.id}:${t.output}`;
      if (captionsAsked.current.has(key)) return false;
      captionsAsked.current.add(key);
      return true;
    });
    if (!due.length) return;
    void post("/api/studio/posts/captions", { batch: batch.id, indexes: due.map((p) => p.index) })
      .then(() => refresh())
      .catch((e) => console.error("[captions]", (e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch?.id, tasks, plan]);
  // Pictures reviewed before the review learned to see faces get them once, so the words keep off faces.
  const facesAsked = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!batch) return;
    const missing = tasks.some((t) => {
      if (!t.output || !t.qa || ["queued", "processing", "finalizing"].includes(t.status)) return false;
      try {
        return !Array.isArray((JSON.parse(t.qa) as { faces?: unknown }).faces);
      } catch {
        return false;
      }
    });
    if (!missing || facesAsked.current.has(batch.id)) return;
    facesAsked.current.add(batch.id);
    void post<{ filled: number }>("/api/studio/posts/faces", { batch: batch.id })
      .then((r) => (r.filled ? refresh() : undefined))
      .catch((e) => console.error("[faces]", (e as Error).message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch?.id, tasks]);
  async function rewritePost(index: number, next: Post[]) {
    if (!batch) return;
    setBusy("reidea");
    try {
      await put("/api/studio/posts/plan", { batch: batch.id, plan: next });
      const r = await post<{ post: Post }>("/api/studio/posts/reidea", { batch: batch.id, index });
      await refresh();
      toast.success(`Post ${index} rewritten as ${r.post.type === "offer" ? "an offer" : r.post.type}. Generate it when ready.`);
    } catch (e) {
      toast.error((e as Error).message);
      await refresh();
    } finally {
      setBusy("");
    }
  }

  async function generateIdeas(notes: string, force = false, append = false): Promise<boolean> {
    if (!googleReady && engine.openai === "none") {
      setConnection(true);
      return false;
    }
    setBusy("ideas");
    try {
      const id = await ensurePlan();
      // A month that follows a grid is planned from the grid, tile by tile.
      // Added posts are written as ideas in the month's world, whatever planned the month (a grid or a brief).
      const r = await post<{ plan: Post[] }>(config?.gridRef && !append ? "/api/studio/posts/grid-ideas" : "/api/studio/posts/ideas", {
        batch: id,
        ref: config?.gridRef,
        notes: notes || undefined,
        count: shownSettings.postCount,
        force: force || undefined,
        append: append || undefined,
      });
      await refresh();
      toast.success(append ? `${r.plan.length} posts now: the new ones are written, the rest stay as they are. Generate makes the new pictures.` : `${r.plan.length} ideas ready. Edit anything, then generate the posts.`);
      if (config?.gridRef && !append) await fillProducts(id);
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally {
      setBusy("");
    }
  }

  /** A grid's posts get their products by themselves: earlier months' or the client's Drive photos. */
  async function fillProducts(id: string) {
    try {
      const r = await post<{ filled: { index: number; product: string; source: string }[] }>("/api/studio/posts/products/fill", { batch: id });
      if (r.filled.length) {
        await refresh();
        toast.success(
          `${r.filled.length} post${r.filled.length > 1 ? "s" : ""} got ${r.filled.length > 1 ? "their" : "its"} product by itself (${r.filled.map((f) => `${f.index}: ${f.product}`).join(", ")}). Replace any from its shot.`,
        );
      }
    } catch (e) {
      toast.error(`Products: ${(e as Error).message}`);
    }
  }

  /** force: a month planned from a request is planned again over the grid (the workflow confirms this first). */
  async function gridIdeas(refId: string, notes: string, force = false) {
    if (!googleReady && engine.openai === "none") {
      setConnection(true);
      return;
    }
    setBusy("grid");
    try {
      const id = await ensurePlan();
      const r = await post<{ plan: Post[] }>("/api/studio/posts/grid-ideas", {
        batch: id,
        ref: refId,
        notes: notes || undefined,
        count: shownSettings.postCount,
        force: force || undefined,
      });
      await refresh();
      toast.success(`${r.plan.length} posts planned from the reference grid.`);
      await fillProducts(id);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function clearGrid() {
    if (!batch) return;
    try {
      await put("/api/studio/posts/settings", { batch: batch.id, gridRef: null });
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  /** New styles waiting for the admin's approval (the daily update and New ideas). */
  const [pendingStyles, setPendingStyles] = useState(0);
  const loadPending = useCallback(async () => {
    if (user.role !== "admin") return;
    try {
      const [styles, lessons] = await Promise.all([get<{ n: number }>("/api/studio/styles/pending"), get<{ n: number }>("/api/studio/lessons/pending").catch(() => ({ n: 0 }))]);
      setPendingStyles(styles.n + lessons.n);
    } catch {
      /* the badge waits for the next check */
    }
  }, [user.role]);
  useEffect(() => {
    void loadPending();
    const t = setInterval(() => void loadPending(), 10 * 60_000);
    return () => clearInterval(t);
  }, [loadPending]);

  /** Gallery styles for posts: each is written for its post's product (null takes the style off). */
  /** ask: offer to make the pictures right away; the workflow's Plan stage does that itself, so it passes false. */
  async function assignStyles(assign: { index: number; style: string | null }[], ask = true) {
    if (!batch || !assign.length) return;
    const t = toast.loading(
      assign.length > 1 ? `Writing ${assign.length} styles for your products…` : "Writing the style for this product…",
    );
    try {
      await post("/api/studio/posts/style", { batch: batch.id, assign });
      await refresh();
      const styled = assign.filter((a) => a.style).map((a) => a.index);
      if (!styled.length) {
        toast.success("Style taken off.", { id: t });
        return;
      }
      // The style is saved already (idea and shot written); making the picture is a separate step.
      toast.success("Style saved on the post.", { id: t });
      if (!ask) return;
      const ok = await askConfirm(
        `The style is saved. Make ${styled.length === 1 ? "the picture" : `${styled.length} pictures`} in it now, or keep the style and make ${styled.length === 1 ? "it" : "them"} with the next Generate?`,
        { ok: "Generate now", cancel: "Keep the style, generate later", danger: false },
      );
      if (ok) await generatePosts(styled, true, false);
    } catch (e) {
      toast.error((e as Error).message, { id: t });
    }
  }

  async function savePlan(next: Post[]) {
    if (!batch) return;
    try {
      await put("/api/studio/posts/plan", { batch: batch.id, plan: next });
      await refresh();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function generatePosts(indexes?: number[], regenerate?: boolean, askFirst = true, test = false, retake = false, approve = false, retakes?: boolean, run = crypto.randomUUID()): Promise<void> {
    if (!batch) return;
    if (!engineConnected) {
      setConnection(true);
      return;
    }
    if (regenerate && !indexes && askFirst) {
      const ok = await askConfirm(
        `Generate all ${plan.length} posts again? The current images are replaced.`,
        { ok: "Regenerate all", danger: false },
      );
      if (!ok) return;
    }
    askNotifications();
    setBusy("generate");
    try {
      const r = await post<{ planned: number; skipped?: number[]; missingProduct?: { index: number; product: string }[]; draft?: boolean }>("/api/studio/posts/generate", {
        batch: batch.id,
        indexes,
        regenerate,
        test: test || undefined,
        retake: retake || undefined,
        approve: approve || undefined,
        retakes,
        run,
      });
      await refresh();
      if (test && r.planned)
        toast.success(`Test post ${indexes![0]} generating${r.draft ? " at 1K" : ""}. It is checked automatically when it arrives.`);
      else if (r.planned) toast.success(`${r.planned} post${r.planned > 1 ? "s" : ""} generating.`);
      if (r.missingProduct?.length)
        toast.warning(
          `Not generated, the product photo is missing: ${r.missingProduct.map((m) => `post ${m.index} (${m.product})`).join(", ")}. Upload it, or pick another product on the post.`,
          { duration: 12000 },
        );
      if (r.skipped?.length)
        toast.warning(`Offer post${r.skipped.length > 1 ? "s" : ""} ${r.skipped.join(", ")} not generated: fill the offer's products, price and contents first.`);
    } catch (e) {
      // Above the spend limit: the server started nothing; one approval here starts the same run.
      const err = e as ApiError;
      const d = (err.data ?? {}) as { needsApproval?: boolean; images?: number; estimate?: number; maximum?: number; threshold?: number };
      if (err.status === 409 && d.needsApproval && !approve) {
        setBusy("");
        const ok = await askConfirm(
          `${d.images} picture${d.images === 1 ? "" : "s"}: about ${formatUsd(d.estimate ?? 0)}, at most ${formatUsd(d.maximum ?? d.estimate ?? 0)} if each is retaken once by itself after the review (list prices, an estimate). This is above the $${d.threshold} limit set in Admin.`,
          { ok: `Approve and generate · up to ${formatUsd(d.maximum ?? d.estimate ?? 0)}`, danger: false, cancel: "Not now" },
        );
        if (ok) return generatePosts(indexes, regenerate, false, test, retake, true, retakes, run);
        return;
      }
      toast.error(err.message);
    } finally {
      setBusy("");
    }
  }

  /** The test post of the journey's last screen: its image and what the automatic review found. */
  /** A finished picture made for an earlier revision of its post's idea (recorded lineage, never a timestamp). */
  const oldImage = (t: { status: string; output?: string | null; made_for?: number | null }, index: number) => {
    const p = plan.find((x) => x.index === index);
    return !["queued", "processing", "finalizing"].includes(t.status) && !!p && olderIdea(t, p, config);
  };
  const testPost = useMemo(() => {
    const i = config?.testPost;
    if (!i || !plan.some((p) => p.index === i)) return null;
    const t = tasks.find((x) => x.post === i);
    // A test made for older ideas, or one that failed (it keeps an older picture), tests nothing.
    if (t && (oldImage(t, i) || (!!t.error && !["queued", "processing", "finalizing"].includes(t.status)))) return null;
    let qa: QA | null = null;
    try {
      qa = t?.qa ? (JSON.parse(t.qa) as QA) : null;
    } catch {
      qa = null;
    }
    return {
      index: i,
      status: t?.status ?? "queued",
      url: t?.output ? outputUrl(t) : null,
      error: t?.error ?? null,
      qa,
      draft: !!config && testSize(config.model, config.size) === "1K" && config.size !== "1K",
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, tasks, plan]);

  /** The journey's last screens: every post's image, its state and what the review found. */
  const journeyPosts = useMemo<JourneyPost[]>(
    () =>
      plan.map((p) => {
        const t = tasks.find((x) => x.post === p.index);
        let qa: QA | null = null;
        try {
          qa = t?.qa ? (JSON.parse(t.qa) as QA) : null;
        } catch {
          qa = null;
        }
        // An image made for older ideas is not this post's: it shows as not made yet.
        const old = !!t && oldImage(t, p.index);
        return {
          index: p.index,
          taskId: t?.id ?? null,
          // A take that failed keeps the last picture: it is shown as failed, never as this idea's image.
          status: old ? "none" : t?.error && !["queued", "processing", "finalizing"].includes(t.status) ? "failed" : (t?.status ?? "none"),
          url: t?.output && !old ? outputThumb(t) : null,
          output: old ? null : (t?.output ?? null),
          error: t?.error ?? null,
          flags: qa?.automated ? (qa.flags ?? []) : null,
          faces: qa?.faces ?? [],
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [plan, tasks, batch?.id],
  );

  async function testOnePost(index: number) {
    const has = tasks.some((t) => t.post === index && t.output);
    await generatePosts([index], has, false, true);
  }

  /** The journey's last screen: every post that has no image yet, or whose idea is newer. */
  async function generateFromJourney() {
    askNotifications();
    const plannedAt = config?.plannedAt ?? 0;
    // The brief, the grid or the count changed after the ideas were written: Generate writes fresh
    // ideas from the brief and the grid first, then makes them all (the current posts stay under Earlier versions).
    const gridChanged = !!config?.gridRef && (config?.gridAt ?? 0) > plannedAt;
    const countChanged = plan.length > 0 && plan.length !== shownSettings.postCount;
    if (batch && plan.length && (gridChanged || countChanged)) {
      const n = shownSettings.postCount;
      const ok = await askConfirm(
        `${gridChanged ? "The grid was picked after these ideas were written." : `The month is set to ${n} posts but has ${plan.length} ideas.`} Write ${n} fresh ideas from the brief and the grid, then make them? The current posts and pictures stay under Earlier versions.`,
        { ok: `Write ${n} fresh ideas and make them`, danger: false },
      );
      if (ok) {
        setBusy("ideas");
        try {
          const r = await post<{ plan: Post[] }>(config?.gridRef ? "/api/studio/posts/grid-ideas" : "/api/studio/posts/ideas", {
            batch: batch.id,
            ref: config?.gridRef,
            count: n,
            force: true,
          });
          await refresh();
          if (config?.gridRef) await fillProducts(batch.id);
          toast.success(`${r.plan.length} fresh ideas written. Making them…`);
        } catch (e) {
          toast.error((e as Error).message);
          setBusy("");
          return;
        }
        setBusy("");
        return generatePosts(undefined, true, false);
      }
    }
    // A take that failed (it keeps an older picture and says why) is made again too.
    const failed = (t: (typeof tasks)[number]) => t.status === "failed" || (!!t.error && !["queued", "processing", "finalizing"].includes(t.status));
    const stale = tasks.some((t) => t.post && plan.some((p) => p.index === t.post && (olderIdea(t, p, config) || failed(t))));
    if (!stale) return generatePosts(undefined, false, false);
    // Only what is older than the ideas, missing or failed is made again: a fresh test post stays.
    const due = plan
      .filter((p) => {
        const t = tasks.find((x) => x.post === p.index);
        return !t || failed(t) || olderIdea(t, p, config) || (testPost?.draft && testPost.index === p.index);
      })
      .map((p) => p.index);
    await generatePosts(due.length ? due : undefined, true, false);
  }

  // When the month's posts finish while the team works elsewhere: a chime and a notification.
  const wasRunning = useRef<{ id: string; running: boolean } | null>(null);
  useEffect(() => {
    const running = batch?.state === "running" || active;
    if (batch && wasRunning.current?.id === batch.id && wasRunning.current.running && !running) {
      const ready = tasks.filter((t) => t.post && t.output).length;
      if (ready) {
        chime();
        notify(`${client?.name ?? "Posts"} · ${month}`, `${ready} posts are ready to review.`);
        toast.success(`${ready} posts are ready to review.`);
      }
    }
    wasRunning.current = batch ? { id: batch.id, running } : null;
  }, [batch, active, tasks, client?.name, month]);

  /** Restart a paused month: queued posts carry on, failed ones get a fresh prompt. */
  async function resumeMonth() {
    if (!batch) return;
    setBusy("resume");
    try {
      await action("retry");
      toast.success("Generation resumed.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function revise(edit: string) {
    if (!selected) return;
    setActing(true);
    try {
      await action("revise", { id: selected.id, edit });
      toast.info("Revision queued. The current image stays until the new one arrives.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setActing(false);
    }
  }

  async function exportMonth() {
    if (!batch || !client || exporting) return;
    // Only posts of the current plan: a plan cut from 12 to 6 leaves the old images behind.
    const ready = tasks
      .filter((t) => !!t.output && t.post && plan.some((p) => p.index === t.post))
      .sort((a, b) => a.post! - b.post!);
    if (!ready.length) {
      toast.error("No generated posts yet.");
      return;
    }
    setExporting(true);
    try {
      const entries: ZipEntry[] = [];
      for (const t of ready) {
        const p = plan.find((x) => x.index === t.post);
        const withText =
          overlaySpec.template !== "none" && p?.overlay !== false && !!(p?.headline || p?.subline || logoSrc);
        if (withText) {
          const canvas = await renderOverlay(
            outputUrl(t),
            overlaySpec,
            { headline: p?.headline, subline: p?.subline },
            logoSrc,
            undefined,
            { patch: p?.ov, faces: facesOf(t.qa) },
          );
          entries.push({
            name: postFileName(client.slug, month, t.post!, "jpg"),
            blob: await canvasBlob(canvas, 0.92),
            convert: { format: "jpg", quality: 90, fit: true },
          });
          entries.push({
            name: `clean/${postFileName(client.slug, month, t.post!, "jpg")}`,
            url: outputUrl(t),
            convert: { format: "jpg", quality: 90, fit: true },
          });
        } else
          entries.push({
            name: postFileName(client.slug, month, t.post!, "jpg"),
            url: outputUrl(t),
            convert: { format: "jpg", quality: 90, fit: true },
          });
      }
      entries.push({
        name: `${client.slug}_${month}_captions.csv`,
        url: `/api/studio/posts/captions.csv?batch=${encodeURIComponent(batch.id)}`,
      });
      await saveZips(await buildZips(entries), `${client.slug}_${month}`);
      toast.success(`${ready.length} posts exported with captions.csv.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setExporting(false);
    }
  }

  /** One long PDF page: cover, Instagram-style feed of the month, a note per post, thank-you. */
  async function exportFeedPdf() {
    if (!batch || !client || exporting) return;
    // Only posts of the current plan: a plan cut from 12 to 6 leaves the old images behind.
    const ready = tasks
      .filter((t) => !!t.output && t.post && plan.some((p) => p.index === t.post))
      .sort((a, b) => a.post! - b.post!);
    if (!ready.length) {
      toast.error("No generated posts yet.");
      return;
    }
    setExporting(true);
    try {
      const posts: FeedPost[] = [];
      for (const t of ready) {
        const p = plan.find((x) => x.index === t.post);
        if (!p) continue;
        const withText =
          showOverlay &&
          overlaySpec.template !== "none" &&
          p.overlay !== false &&
          !!(p.headline || p.subline || logoSrc);
        const image = withText
          ? await renderOverlay(
              outputUrl(t),
              overlaySpec,
              { headline: p.headline, subline: p.subline },
              logoSrc,
              1080,
              { patch: p.ov, faces: facesOf(t.qa) },
            )
          : await loadImage(outputUrl(t));
        posts.push({ post: p, image });
      }
      const theme = themes.find((t) => t.id === themeId);
      const blob = await buildFeedPdf({
        client,
        month,
        logo: logoSrc ? await loadImage(logoSrc).catch(() => null) : null,
        direction: config?.notes || theme?.direction || theme?.description || "",
        posts,
      });
      saveBlob(blob, `${client.slug}_${month}_feed.pdf`);
      toast.success("Feed PDF downloaded.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setExporting(false);
    }
  }

  /** The client's approval link: copied to the clipboard. */
  /** Each finished post's words set as typography by the AI (behind or across the product, repeated, outlined). */
  async function typographyMonth(style?: TypoStyle, indexes?: number[]) {
    if (!batch) return;
    const t = toast.loading("Setting the typography: reading each picture and its product's outline…");
    try {
      const r = await postPaid<{ set: { index: number; style: string; word: string; font: string }[]; plain: number[]; failed: number[] }>("/api/studio/posts/typography", {
        batch: batch.id,
        indexes,
        force: !!indexes || undefined,
        style,
      }, "Typography: reading each product's outline");
      if (!r) {
        toast.dismiss(t);
        return;
      }
      await refresh();
      toast.success(
        r.set.length
          ? `Typography on ${r.set.length} post${r.set.length > 1 ? "s" : ""}${r.plain.length ? `; ${r.plain.length} keep the plain headline` : ""}. Change any in "Text on image".`
          : "Every post keeps its plain headline: nothing new to set.",
        { id: t },
      );
      if (r.failed.length) toast.error(`Typography failed on post${r.failed.length > 1 ? "s" : ""} ${r.failed.join(", ")}: try again.`);
    } catch (e) {
      toast.error((e as Error).message, { id: t });
    }
  }

  /** The month's typography on or off: off shows every post's plain headline again. */
  async function switchTypography(on: boolean) {
    if (!batch) return;
    try {
      await post("/api/studio/posts/typography/switch", { batch: batch.id, on });
      await refresh();
      toast.success(on ? "Typography on." : "Typography off: every post shows its plain headline.");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  /** The review's flags on a task, or none. */
  const flagsOf = (t: Task) => {
    try {
      const qa = t.qa ? (JSON.parse(t.qa) as QA) : null;
      return qa?.automated ? (qa.flags ?? []) : [];
    } catch {
      return [];
    }
  };
  /** One post's picture changed as the review asks. */
  const fixPost = async (index: number, edit: string) => {
    if (!batch) return;
    if (!engineConnected) {
      setConnection(true);
      return;
    }
    // The brief is built again from the plan as it is now (its people, products, idea and lessons),
    // and the review's findings ride along as the fresh take's note.
    try {
      await post("/api/studio/posts/generate", { batch: batch.id, indexes: [index], regenerate: true, note: edit });
      await refresh();
      toast.success(`Making post ${index} again.`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  /** The team accepts a flagged post as it is. */
  const acceptPost = async (index: number) => {
    if (!batch) return;
    try {
      await post("/api/studio/posts/accept", { batch: batch.id, index });
      await refresh();
      toast.success(`Post ${index} accepted.`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  /** An earlier picture back on its post. */
  const restorePicture = async (index: number, key: string) => {
    if (!batch) return;
    try {
      await post("/api/studio/posts/versions/restore", { batch: batch.id, index, key });
      await refresh();
      toast.success(`Post ${index}: the previous picture is back.`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };
  // The brand kit folds away once the month has pictures, unless the team opened it.
  const kitShown = kitOpen ?? !tasks.some((t) => t.post && t.output);
  // How long the posts being made still need: from the pace of the ones finished this session.
  const finishedAt = useRef<number[]>([]);
  const madeNow = tasks.filter((t) => t.post && t.output && !["queued", "processing", "finalizing"].includes(t.status)).length;
  const madeBefore = useRef(madeNow);
  useEffect(() => {
    if (madeNow > madeBefore.current) finishedAt.current.push(Date.now());
    madeBefore.current = madeNow;
  }, [madeNow]);
  const etaMinutes = (() => {
    const left = tasks.filter((t) => t.post && ["queued", "processing", "finalizing"].includes(t.status)).length;
    if (!left) return null;
    const times = finishedAt.current;
    // Six posts are made at once, about 45 s each, until the real pace is seen.
    const ms = times.length >= 2 ? left * ((times[times.length - 1] - times[0]) / (times.length - 1)) : Math.ceil(left / 6) * 45_000;
    return Math.max(1, Math.round(ms / 60_000));
  })();

  const typography = {
    on: !config?.typographyOff,
    set: plan.some((p) => p.ov?.typo || p.ov?.typoOff),
    onSet: (style?: TypoStyle) => typographyMonth(style),
    onSwitch: switchTypography,
  };

  /** The client's link, straight into WhatsApp. */
  /** The client's change requests are read, written into their posts and those posts are made again. */
  async function doClientChanges() {
    if (!batch) return;
    setBusy("client");
    try {
      const r = await post<{ indexes: number[]; changes: { index: number; summary: string }[] }>("/api/studio/posts/client-changes", { batch: batch.id });
      await refresh();
      for (const ch of r.changes) toast.success(`Post ${ch.index}: ${ch.summary || "changed as the client asked"}`, { duration: 12000 });
      if (engineConnected && r.indexes.length) {
        const ok = await askConfirm(
          `The client's changes are saved into post${r.indexes.length > 1 ? "s" : ""} ${r.indexes.join(", ")}. Make ${r.indexes.length === 1 ? "that picture" : `these ${r.indexes.length} pictures`} again now?`,
          { ok: "Generate now", cancel: "Keep the changes, generate later", danger: false },
        );
        if (ok) await generatePosts(r.indexes, true, false);
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function whatsAppMonth() {
    if (!batch) return;
    try {
      const r = await post<{ url: string }>("/api/studio/posts/share", { batch: batch.id });
      const text = `${client?.name ?? ""} · ${monthLabel(month)}: the month's posts are ready for your approval. Open the link, approve each post or ask for a change: ${r.url}`;
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, "_blank", "noopener");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function shareMonth() {
    if (!batch) return;
    try {
      const r = await post<{ url: string }>("/api/studio/posts/share", { batch: batch.id });
      try {
        await navigator.clipboard.writeText(r.url);
        toast.success("Approval link copied. Send it to the client.", { description: r.url });
      } catch {
        toast.info("Approval link", { description: r.url, duration: 20000 });
      }
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function deletePlan() {
    if (!batch || active) return;
    if (!(await askConfirm(`Move ${client?.name ?? ""} · ${month} to the bin? Its posts and pictures stay there and you can bring the month back from the Months page for 30 days.`, { ok: "Move to the bin" }))) return;
    try {
      await remove();
      await loadState();
      toast.success("Month moved to the bin. Restore it from the Months page.");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  /** A month back from the bin. */
  async function restorePlan(b: Batch) {
    try {
      await post(`/api/studio/batch/restore`, { batch: b.id });
      await loadState();
      toast.success(`${b.name} is back.`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  /** A month purged from the bin for good: its pictures and rows are gone. */
  async function purgePlan(b: Batch) {
    if (!(await askConfirm(`Delete "${b.name}" for good? Its pictures, products and posts cannot be brought back after this.`, { ok: "Delete for good" }))) return;
    try {
      await del(`/api/studio/batch?batch=${encodeURIComponent(b.id)}&forever=1`);
      await loadState();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function openPlan(id: string) {
    const b = batches.find((x) => x.id === id);
    if (!b) return;
    setOpeningId(id);
    try {
      if (b.client) setClientId(b.client);
      if (b.month) setMonth(b.month);
      if (b.client && b.month) setGridPick((g) => ({ ...g, [`${b.client}|${b.month}`]: id }));
      await open(id);
      setPage("studio");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setOpeningId(null);
    }
  }

  async function deletePlanById(b: Batch) {
    if (!(await askConfirm(`Move "${b.name}" to the bin? You can bring it back from here for 30 days.`, { ok: "Move to the bin" }))) return;
    try {
      if (batch?.id === b.id) await remove();
      else await del(`/api/studio/batch?batch=${encodeURIComponent(b.id)}`);
      await loadState();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function signOut() {
    stopRadio();
    await post("/api/auth/logout").catch(() => {});
    onSignedOut();
  }

  const selectedSource = selected ? (sources.find((s) => s.id === selected.source) ?? null) : null;
  const reviewable = tasks.filter((t) => !!t.output);
  const selectedIndex = selected ? reviewable.findIndex((t) => t.id === selected.id) : -1;
  /** A tool of the card asked for from the editor: the Text studio, Animate or Video open on that post. */
  const [requested, setRequested] = useState<{ kind: "text" | "animate" | "video"; index: number; at: number } | null>(null);
  const prevOutputKey = (t: Task) => `lsm-prev-output:${t.id}`;
  const prevOutputOf = (t: Task): string | null => {
    try {
      const k = localStorage.getItem(prevOutputKey(t));
      return k && k !== t.output ? k : null;
    } catch {
      return null;
    }
  };
  const [selectedPost, setSelectedPost] = useState<number | null>(null);
  /** The open post's takes, from the server (the editor's Versions list, Previous picture and Compare). */
  const [takes, setTakes] = useState<{ index: number; list: Take[] } | null>(null);
  const openPostIndex = selected?.post ?? selectedPost ?? null;
  const openOutput = selected?.output ?? null;
  useEffect(() => {
    if (!batch || openPostIndex === null) {
      setTakes(null);
      return;
    }
    let live = true;
    void get<{ takes: Take[] }>(`/api/studio/posts/takes?batch=${encodeURIComponent(batch.id)}&index=${openPostIndex}`)
      .then((r) => live && setTakes({ index: openPostIndex, list: r.takes }))
      .catch(() => live && setTakes(null));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batch?.id, openPostIndex, openOutput]);
  /** A post opened in the editor without a picture (no task yet), and the group the editor opens on. */
  const [editorGroup, setEditorGroup] = useState<EditorGroup | undefined>(undefined);
  const openEditor = (index: number, group?: EditorGroup) => {
    const t = tasks.find((x) => x.post === index && x.output);
    setEditorGroup(group);
    if (t) {
      setSelectedPost(null);
      setSelected(t);
    } else {
      setSelected(null);
      setSelectedPost(index);
    }
  };
  const closeEditor = () => {
    setSelected(null);
    setSelectedPost(null);
    setEditorGroup(undefined);
  };
  /** The post editor's four groups: the open task's post with every tool the card offers. */
  const editorPost = selected?.post ? plan.find((p) => p.index === selected.post) : selectedPost !== null ? plan.find((p) => p.index === selectedPost) : undefined;
  const editor: PostEditorTools | undefined =
    editorPost && batch
      ? (() => {
          const index = editorPost.index;
          const t: Task | null = selected;
          const ask = (kind: "text" | "animate" | "video") => () => {
            setSelected(null);
            setRequested({ kind, index, at: Date.now() });
          };
          let acceptedBy = "";
          try {
            const qa = t?.qa ? (JSON.parse(t.qa) as { acceptedBy?: string; notes?: string }) : null;
            acceptedBy = qa?.acceptedBy ?? (qa?.notes?.startsWith("Accepted by ") ? qa.notes.slice(12).replace(/\.$/, "") : "");
          } catch {
            /* unreadable review */
          }
          // The take before the current picture, from the server; the browser's memory is only a fallback for older months.
          const postTakes = takes?.index === index ? takes.list : [];
          const prevTake = t?.output ? postTakes.find((x) => x.status === "made" && x.key && x.key !== t.output)?.key ?? null : null;
          const prev = prevTake ?? (t ? prevOutputOf(t) : null);
          return {
            post: editorPost,
            initialGroup: editorGroup,
            onMake: !t?.output
              ? () => {
                  closeEditor();
                  void generatePosts([index], false, false);
                }
              : undefined,
            products: sources.filter((s) => (s.kind ?? "product") === "product").map((s) => ({ id: s.id, name: displayName(s.name) })),
            cast: ambassadors.filter((a) => castIds.includes(a.id)).map((a) => a.name),
            perPicture: rateFor(shownSettings.model)?.[shownSettings.size] ?? 0,
            onSavePost: (patch) => savePlan(plan.map((p) => (p.index === index ? { ...p, ...patch } : p))),
            onEdit: (note) => fixPost(index, note),
            onAccept: t && flagsOf(t).length && !acceptedBy ? () => acceptPost(index) : undefined,
            onNewIdea: () => {
              setSelected(null);
              void newIdea(index);
            },
            onPrevious: prev && t
              ? async () => {
                  const was = t.output;
                  await restorePicture(index, prev);
                  try {
                    if (was) localStorage.setItem(prevOutputKey(t), was);
                  } catch {
                    /* private mode */
                  }
                }
              : undefined,
            onOpenText: ask("text"),
            onAnimate: ask("animate"),
            onVideo: ask("video"),
            versions: <MonthVersions batchId={batch.id} plannedAt={config?.plannedAt} overlay={overlaySpec} logoSrc={logoSrc} onRestored={refresh} />,
            acceptedBy: acceptedBy || undefined,
            takes: postTakes,
            onUseTake: (key) => restorePicture(index, key),
            onCheckWords: t?.output
              ? async (propose) => {
                  // The post as it will be published, words and logo drawn by the browser, is what the art director sees.
                  const canvas = await renderOverlay(outputUrl(t), overlaySpec, { headline: editorPost.headline, subline: editorPost.subline }, editorPost.overlay === false ? null : logoSrc, 900, { patch: editorPost.ov, faces: facesOf(t.qa) });
                  const r = await post<{ check: { ok: boolean }; post: Post; proposal: { ov?: Post["ov"]; changes: string[] } | null; applied?: string[] }>("/api/studio/posts/text-check", { batch: batch.id, index, image: canvas.toDataURL("image/jpeg", 0.82), propose });
                  await refresh();
                  return { note: r.post.textCheck?.note ?? "", ok: r.check.ok, proposal: r.proposal, applied: r.applied };
                }
              : undefined,
            lineage: !t?.output ? "none" : lineageUnknown(t) ? "unknown" : olderIdea(t, editorPost, config ?? null) ? "older" : "current",
          };
        })()
      : undefined;
  const running = batch?.state === "running" || active;

  return (
    <div className="studio">
      <BootScreen done={bootTimedOut || stateReady} />
      {previewMode && (
        <div className="preview-strip" role="status">
          Preview: image and video generation is blocked at the server. With no key connected, planning and analysis answer from demo fixtures (free); if you add a Google or OpenAI key in Connection, those text calls are billed by that provider.
        </div>
      )}
      <Sidebar
        page={page}
        pendingStyles={pendingStyles}
        onPage={setPage}
        user={user}
        batches={batches.length}
        engine={engine}
        models={models}
        onConnection={() => setConnection(true)}
        theme={theme}
        onToggleTheme={toggleTheme}
        onSignOut={() => void signOut()}
        clients={clients}
        client={clientId}
        locked={busy === "upload"}
        onClient={setClientId}
        onClientsChanged={setClients}
      />
      <main>
        {page === "admin" ? (
          <>
            <div className="workspace-head">
              <div>
                <div className="eyebrow">Workspace</div>
                <h1>Admin</h1>
                <p>Team, spend confirmation, retention, notifications and member access.</p>
              </div>
            </div>
            <Suspense fallback={null}>
              <AdminView me={user.id} />
            </Suspense>
          </>
        ) : page === "approvals" && user.role === "admin" ? (
          <section className="style-page">
            <StyleScreen
              open
              approvals
              admin
              clients={clients.filter((c) => c.status === "active").map((c) => ({ id: c.id, name: c.name }))}
              onPendingChange={() => void loadPending()}
              onClose={() => {
                setPage("studio");
                void loadPending();
              }}
            />
          </section>
        ) : page === "styles" ? (
          <>
            <div className="workspace-head">
              <div>
                <div className="eyebrow">Pick your style</div>
                <h1>Styles</h1>
                <p>
                  Product-photo styles read from Pinterest. Remove one and a new one takes its place; select some to update them or bring new ideas.
                  Picked for a post, a style is written for that post's own product and brand.
                </p>
              </div>
            </div>
            <section className="style-page">
              <StyleScreen
                open
                admin={user.role === "admin"}
                clients={clients.filter((c) => c.status === "active").map((c) => ({ id: c.id, name: c.name }))}
                onPendingChange={() => void loadPending()}
                onClose={() => {
                  setPage("studio");
                  void loadPending();
                }}
              />
            </section>
          </>
        ) : page === "batches" ? (
          <>
            <div className="workspace-head">
              <div>
                <div className="eyebrow">History</div>
                <h1>Months</h1>
                <p>Every client's months of posts. Open one to review, revise or export.</p>
              </div>
            </div>
            <section className="batches-page">
              <Suspense fallback={null}>
                <BatchesView
                  batches={batches}
                  clients={clients}
                  spend={user.role === "admin" ? spend : undefined}
                  busyId={openingId}
                  onOpen={(id) => void openPlan(id)}
                  onDelete={(b) => void deletePlanById(b)}
                  trash={trash}
                  onRestore={(b) => void restorePlan(b)}
                  onPurge={(b) => void purgePlan(b)}
                />
              </Suspense>
            </section>
          </>
        ) : !client ? (
          <div className="workspace-head">
            <div>
              <div className="eyebrow">Client</div>
              <h1>Add a client</h1>
              <p>Use the + next to Clients in the left rail. Each client gets a brand kit, themes and months of posts.</p>
            </div>
          </div>
        ) : (
          <>
            {useFlow && (
              <nav className="studio-rail" aria-label="Stages">
                <div className="flow-rail">
                  {["Start", "Direction", "Plan", "Studio"].map((name, i) => (
                    <button
                      key={name}
                      type="button"
                      className={`flow-stage ${i === 3 ? "now" : "done"}`}
                      disabled={i === 3}
                      title={i === 3 ? "You are in the Studio" : `Back to ${name}`}
                      onClick={() => {
                        setFlowStage(i as 0 | 1 | 2);
                        setClassic(false);
                        setJourney(true);
                      }}
                    >
                      <span className="flow-stage-n">{i + 1}</span> {name}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  className="text-button"
                  title="The step-by-step journey from before the workflow; everything it does is also in the four stages"
                  onClick={() => {
                    setClassic(true);
                    setJourney(true);
                  }}
                >
                  Classic journey
                </button>
                <span className="studio-rail-right">
                  {previewMode && <span className="flow-sample-pill">Sample data (fictional)</span>}
                  <BrandChip client={client} ambassadors={ambassadors} onOpen={() => setKitOpen(true)} />
                </span>
              </nav>
            )}
            {!useFlow && (() => {
              /** "Start new journey" begins at the first screen; "Open the journey" resumes where it was left. */
              const startNew = () => {
                try {
                  localStorage.setItem("lsm-journey-step", JSON.stringify({ client: clientId, month, step: 0 }));
                } catch {
                  /* private mode */
                }
                setFlowStage(0);
                setClassic(false);
                setJourney(true);
              };
              const actions = (
                <div className="hero-actions">
                  <button type="button" className="secondary" onClick={startNew}>
                    <Compass size={15} /> {useFlow ? "Start" : "Start new journey"}
                  </button>
                  <button type="button" className="primary" onClick={() => { setFlowStage(null); setClassic(false); setJourney(true); }} title={useFlow ? "Open the workflow: Start, Direction, Plan, then the Studio" : "Open the journey where it was left, to go through its screens and change things"}>
                    <FolderOpen size={15} /> {useFlow ? "Open the workflow" : "Open the journey"}
                  </button>
                </div>
              );
              const text = (
                <div className="hero-text">
                  <div className="eyebrow">Client</div>
                  <h1>{client.name}</h1>
                  <p>Brand kit and theme on the left; the month's products and posts on the right.</p>
                </div>
              );
              return hero ? (
                <div className="hero-banner">
                  <video src={`/api/studio/hero?v=${hero}`} autoPlay muted loop playsInline preload="metadata" aria-hidden="true" />
                  <div className="hero-veil" />
                  <p className="hero-claim" aria-hidden="true">
                    <span>AI is the future.</span>
                    <span>Level is ahead.</span>
                  </p>
                  {text}
                  {actions}
                </div>
              ) : (
                <div className="workspace-head">
                  {text}
                  {actions}
                </div>
              );
            })()}
            {!useFlow && (
            <SetupChecklist
              client={client}
              ambassadors={ambassadors}
              onOpenKit={(kit) => {
                setKitOpen(true);
                setTimeout(() => {
                  const el = (kit && document.querySelector(`[data-kit="${kit}"]`)) || document.querySelector(".brand-panel");
                  el?.scrollIntoView({ behavior: "smooth", block: "start" });
                }, 150);
              }}
              onOpenJourney={(step) => {
                try {
                  localStorage.setItem("lsm-journey-step", JSON.stringify({ client: clientId, month, step }));
                } catch {
                  /* private mode */
                }
                setJourney(true);
              }}
            />
            )}
            {!useFlow && config && (
              <BriefCard
                config={config}
                theme={themes.find((t) => t.id === themeId) ?? null}
                plan={plan}
                onShare={() => void shareMonth()}
                onWhatsApp={() => void whatsAppMonth()}
                {...(() => {
                  const issues = monthIssues({
                    config,
                    client: client ? { logo: client.logo, tone: client.tone, colors: client.colors, service: client.service } : null,
                    theme: (() => {
                      const t = themes.find((x) => x.id === themeId);
                      return t ? { references: t.references, shots: t.shots, analysed: t.analysed, latestRef: t.latestRef, palette: t.palette } : null;
                    })(),
                    products: sources.filter((s) => (s.kind ?? "product") === "product").map((s) => displayName(s.name)),
                    cast: ambassadors.filter((a) => castIds.includes(a.id)).map((a) => ({ name: a.name, gender: a.gender, image: a.image, description: a.description, modest: a.modest })),
                    scene: sceneContext({ config, theme: themes.find((x) => x.id === themeId) ?? null, products: sources.filter((s) => (s.kind ?? "product") === "product"), client }),
                  });
                  return { blockers: blocking(issues).map((x) => x.text), notes: issues.filter((x) => x.warn).map((x) => x.text) };
                })()}
                made={plan.filter((p) => tasks.some((t) => t.post === p.index && t.output)).length}
                toCheck={tasks.filter((t) => t.post && t.output && !["queued", "processing", "finalizing"].includes(t.status) && flagsOf(t).length).length}
                making={tasks.filter((t) => t.post && ["queued", "processing", "finalizing"].includes(t.status)).length}
                eta={etaMinutes}
                onFeed={openFeed}
                kitOpen={kitShown}
                onKit={() => setKitOpen(!kitShown)}
                onClientChanges={() => void doClientChanges()}
                clientChangesBusy={busy === "client"}
              />
            )}
            {useFlow && (() => {
              const inFlight = (t: Task) => ["queued", "processing", "finalizing"].includes(t.status);
              const groups = new Set(plan.filter((x) => x.group).map((x) => x.group!.id));
              const counts = { posts: plan.filter((x) => !x.group).length + groups.size, designs: plan.length, made: 0, making: 0, look: 0, older: 0, failed: 0, planned: 0 };
              for (const x of plan) {
                const t = tasks.find((y) => y.post === x.index && (y.output || inFlight(y))) ?? tasks.find((y) => y.post === x.index) ?? null;
                if (!t) counts.planned += 1;
                else if (inFlight(t)) counts.making += 1;
                else if (!t.output) counts.failed += 1;
                else if (olderIdea(t, x, config)) counts.older += 1;
                else if (flagsOf(t).length) counts.look += 1;
                else counts.made += 1;
              }
              const makeCount = counts.planned + counts.failed + counts.older;
              const perPicture = rateFor(shownSettings.model)?.[shownSettings.size] ?? 0;
              const changes = Object.values(config?.approvals ?? {}).filter((a) => a.status === "changes").length;
              const toPlan = () => {
                setFlowStage(2);
                setClassic(false);
                setJourney(true);
              };
              return (
                <StudioBoard
                  tab={studioTab}
                  onTab={setStudioTab}
                  counts={counts}
                  makeCount={makeCount}
                  makeCost={makeCount * perPicture}
                  onMake={toPlan}
                  onExport={() => void exportMonth()}
                  exporting={exporting}
                  onClientLink={() => void shareMonth()}
                  onFeed={openFeed}
                  changes={changes}
                  onClientChanges={() => void doClientChanges()}
                  clientChangesBusy={busy === "client"}
                  more={
                    <>
                      <button type="button" onClick={() => setToolsOpen((o) => !o)}>
                        {toolsOpen ? "Hide the month tools" : "Month tools (upload, ideas, grid, overlay, typography, PDF)"}
                      </button>
                      <button type="button" onClick={() => void whatsAppMonth()} disabled={!counts.made}>
                        Send the client link on WhatsApp
                      </button>
                      <button type="button" onClick={() => void exportFeedPdf()} disabled={!counts.made || exporting}>
                        Feed PDF
                      </button>
                      <button type="button" onClick={() => document.getElementById("plan-upload-products")?.click()}>
                        Upload product photos
                      </button>
                      <button type="button" onClick={() => setKitOpen(!kitShown)}>
                        {kitShown ? "Hide the side panel" : "Products, versions and brand kit"}
                      </button>
                      <button type="button" onClick={() => void newGrid()} disabled={running}>
                        New grid in this month
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setClassic(true);
                          setJourney(true);
                        }}
                      >
                        Classic journey
                      </button>
                      <button type="button" className="danger" onClick={() => void deletePlan()} disabled={running}>
                        Delete this month
                      </button>
                    </>
                  }
                >
                  {null}
                </StudioBoard>
              );
            })()}
            <div className={`workbench posts-workbench ${kitShown ? "" : "kit-closed"}`}>
              {kitShown ? (
              <div className="kit-column">
              <MonthPanel
                products={sources.filter((s) => (s.kind ?? "product") === "product")}
                sourceUrl={(id) => sourceUrl(id)}
                onUpload={() => document.getElementById("plan-upload-products")?.click()}
                onRemoveProduct={(id) => void removeProduct(id)}
                busy={busy === "upload"}
                notes={monthNotes}
                onNotes={setMonthNotes}
                gridRef={config?.gridRef ?? null}
                onClearGrid={() => void clearGrid()}
                versions={batch ? <MonthVersions batchId={batch.id} plannedAt={config?.plannedAt} overlay={overlaySpec} logoSrc={logoSrc} onRestored={refresh} /> : null}
              />
              <BrandPanel
                client={client}
                onClientsChanged={setClients}
                themes={themes}
                theme={themeId}
                onTheme={(id) => void updateSettings({ theme: id })}
                onThemesChanged={setThemes}
                settings={shownSettings}
                models={models}
                onSettings={(patch) => void updateSettings(patch)}
                locked={running}
                ambassadors={ambassadors}
                onAmbassadorsChanged={setAmbassadors}
                cast={castIds}
                onCast={(ids) => void updateSettings({ ambassadors: ids })}
              />
              </div>
              ) : (
                <button type="button" className="kit-rail" onClick={() => setKitOpen(true)} title="Open the side panel: products, notes, earlier versions and the brand kit">
                  <PanelLeft size={16} />
                  <span>Products · versions · brand kit</span>
                </button>
              )}
              <div className="plan-column">
                {useFlow && studioTab === "words" && batch && <WordsView plan={plan} tasks={tasks} outputThumb={outputThumb} onSavePlan={savePlan} />}
                {useFlow && studioTab === "approval" && <ApprovalView plan={plan} tasks={tasks} approvals={config?.approvals} outputThumb={outputThumb} onClientLink={() => void shareMonth()} onWhatsApp={() => void whatsAppMonth()} onOpen={(i) => openEditor(i)} />}
                {useFlow && studioTab === "versions" && (batch ? <MonthVersions batchId={batch.id} plannedAt={config?.plannedAt} overlay={overlaySpec} logoSrc={logoSrc} onRestored={refresh} /> : <p className="flow-muted studio-empty">No month yet.</p>)}
                <div className={useFlow && studioTab !== "posts" ? "studio-hidden" : ""}>
                <PlanView
                toolbar={!useFlow || toolsOpen}
                notes={monthNotes}
                batchId={batch?.id ?? null}
                onRefresh={refresh}
                outputThumb={outputThumb}
                onStyles={assignStyles}
                client={client}
                month={month}
                onMonth={setMonth}
                grids={gridsOf(clientId, month).map((b) => ({ id: b.id, name: b.name }))}
                gridId={batch?.id ?? null}
                onGrid={pickGrid}
                onNewGrid={() => newGrid().then(() => undefined)}
                plan={plan}
                postCount={shownSettings.postCount}
                format={shownSettings.format}
                tasks={tasks}
                sources={sources}
                running={running}
                busy={busy}
                exporting={exporting}
                sourceUrl={(id) => sourceUrl(id)}
                outputUrl={outputUrl}
                overlay={overlaySpec}
                logoSrc={logoSrc}
                showOverlay={showOverlay}
                onShowOverlay={setShowOverlay}
                themeRefs={themeRefs}
                gridRef={config?.gridRef ?? null}
                revision={config ?? null}
                requested={requested}
                onGridIdeas={(ref, notes) => void gridIdeas(ref, notes)}
                fileBase={`${client.slug}_${month}`}
                palette={themes.find((x) => x.id === themeId)?.palette ?? []}
                onClientsChanged={setClients}
                onUploadProducts={(files) => void uploadProducts(files)}
                onGenerateIdeas={(notes) => void generateIdeas(notes)}
                onNewIdea={(i) => void newIdea(i)}
                cast={ambassadors.filter((a) => castIds.includes(a.id))}
                onPostCount={(n) => void updateSettings({ postCount: n })}
                onSavePlan={(p) => savePlan(p)}
                onAccept={acceptPost}
                onGeneratePosts={(i, r) => void generatePosts(i, r, true, false, !!r && i?.length === 1)}
                onOpen={setSelected}
                compact={useFlow}
                onEdit={openEditor}
                onExport={() => void exportMonth()}
                onExportPdf={() => void exportFeedPdf()}
                typography={typography}
                onFix={fixPost}
                onRestorePicture={restorePicture}
                onDeletePlan={() => void deletePlan()}
                paused={batch?.state === "paused" ? batch.last_error || "The engine paused this month." : null}
                themeChanged={(() => {
                  const t = themes.find((x) => x.id === themeId);
                  return !!t && t.updated > (config?.plannedAt ?? 0);
                })()}
                onResume={() => void resumeMonth()}
                approvals={config?.approvals}
                monthOccasions={config?.occasions}
                onRewrite={(i, next) => void rewritePost(i, next)}
                onRefit={refitPosts}
                rewriting={rewriting}
                />
                </div>
              </div>
            </div>
          </>
        )}
        <footer className="page-footer">
          <span>level mena / social media</span>
          <span>Every post is reviewed by a designer before publishing.</span>
        </footer>
      </main>

      <Radio className={journey ? (useFlow && !classic ? "in-flow" : "in-journey") : ""} />
      {journey && useFlow && !classic && stateReady && client && (
        <Flow
          initialStage={flowStage ?? undefined}
          cast={ambassadors.filter((a) => castIds.includes(a.id))}
          ambassadors={ambassadors}
          themeRefs={themeRefs}
          previewMode={previewMode}
          onNewGrid={async () => {
            await newGrid();
          }}
          clients={clients.filter((c) => c.status === "active").map((c) => ({ id: c.id, name: c.name }))}
          onClient={setClientId}
          onMonth={setMonth}
          onBrandKit={() => {
            finishJourney();
            setKitOpen(true);
            setTimeout(() => document.querySelector(".brand-panel")?.scrollIntoView({ behavior: "smooth", block: "start" }), 300);
          }}
          onGridIdeas={(ref, notes) => gridIdeas(ref, notes, true)}
          onStyles={(assign) => assignStyles(assign, false)}
          overlay={overlaySpec}
          logoSrc={logoSrc}
          onNotes={(notes) => void updateSettings({ notes })}
          onMakePosts={(indexes) => generatePosts(indexes, true, false)}
          onAddPosts={async (n) => {
            await updateSettings({ postCount: plan.length + n });
            await generateIdeas("", false, true);
          }}
          onGenerateOne={(index) => generatePosts([index], !!tasks.find((t) => t.post === index)?.output, false)}
          reloadThemes={() => loadThemes(clientId)}
          user={user}
          client={client}
          month={month}
          batchId={batch?.id ?? null}
          config={config}
          plan={plan}
          tasks={tasks}
          products={sources.filter((s) => (s.kind ?? "product") === "product")}
          sourceUrl={(id) => sourceUrl(id)}
          outputThumb={outputThumb}
          themes={themes}
          themeId={themeId}
          onTheme={(id) => void updateSettings({ theme: id })}
          onThemesChanged={setThemes}
          format={shownSettings.format}
          model={shownSettings.model}
          modelName={models.find((m) => m.slug === shownSettings.model)?.name}
          size={shownSettings.size}
          postCount={shownSettings.postCount}
          previousMonth={previousMonth}
          onContinue={continueMonth}
          ensurePlan={ensurePlan}
          refresh={async () => {
            await refresh();
          }}
          onUpload={uploadProducts}
          onGrid={pickGrid}
          onGenerateIdeas={(force, notes, append) => generateIdeas(notes ?? config?.notes ?? "", force, append)}
          onSavePlan={(next) => savePlan(next)}
          onGenerate={(retakes) => generatePosts(undefined, false, false, false, false, false, retakes)}
          onTest={testOnePost}
          engineReady={engineConnected}
          onDone={finishJourney}
        />
      )}
      {journey && (!useFlow || classic) && stateReady && clients.some((c) => c.status === "active") && (
        <Journey
          autopilotReview={autopilotReview}
          spendThreshold={spendThreshold}
          user={user}
          pendingStyles={pendingStyles}
          onPendingChange={() => void loadPending()}
          clients={clients}
          clientId={clientId}
          onClient={setClientId}
          onClientsChanged={setClients}
          month={month}
          onMonth={setMonth}
          batchId={batch?.id ?? null}
          config={config}
          previousMonth={previousMonth}
          onContinue={continueMonth}
          continuing={busy === "continue"}
          ensurePlan={ensurePlan}
          grids={gridsOf(clientId, month).map((b) => ({ id: b.id, name: b.name }))}
          onGrid={pickGrid}
          onNewGrid={() => newGrid().then(() => undefined)}
          refresh={async () => {
            await refresh();
          }}
          products={sources.filter((s) => (s.kind ?? "product") === "product")}
          sourceUrl={(id) => sourceUrl(id)}
          onUpload={uploadProducts}
          onRemoveProduct={(id) => void removeProduct(id)}
          uploading={busy === "upload"}
          postCount={shownSettings.postCount}
          format={shownSettings.format}
          onSettings={(patch) => void updateSettings(patch)}
          themes={themes}
          themeId={themeId}
          onTheme={(id) => void updateSettings({ theme: id })}
          onThemesChanged={setThemes}
          ambassadors={ambassadors}
          onAmbassadorsChanged={setAmbassadors}
          cast={castIds}
          onCast={(ids) => void updateSettings({ ambassadors: ids })}
          plan={plan}
          onGenerateIdeas={(force, notes, append) => generateIdeas(notes ?? config?.notes ?? "", force, append)}
          onSavePlan={(next) => void savePlan(next)}
          ideasBusy={busy === "ideas"}
          rewriting={busy === "reidea"}
          onRewrite={(i, next) => void rewritePost(i, next)}
          onStyles={assignStyles}
          onGenerate={generateFromJourney}
          testPost={testPost}
          onTest={testOnePost}
          onFixTest={async (edit) => {
            const t = tasks.find((x) => x.post === testPost?.index);
            if (!t || !batch) return;
            try {
              await action("revise", { id: t.id, edit });
              toast.success("Fixing the test post.");
            } catch (e) {
              toast.error((e as Error).message);
            }
          }}
          engineReady={engineConnected}
          posts={journeyPosts}
          onRetake={(index) => generatePosts([index], true, false, false, true)}
          onFix={fixPost}
          onAccept={acceptPost}
          onRemovePost={async (index) => {
            if (!batch) return;
            try {
              await post("/api/studio/posts/remove", { batch: batch.id, index });
              await refresh();
              toast.success(`Post ${index} left out; the month goes on with the rest.`);
            } catch (e) {
              toast.error((e as Error).message);
            }
          }}
          onShare={shareMonth}
          typography={typography}
          onExport={exportMonth}
          overlay={overlaySpec}
          logoSrc={logoSrc}
          onDone={finishJourney}
        />
      )}

      <Suspense fallback={null}>
        <ConnectionDialog
          open={connection}
          engine={engine}
          onClose={() => setConnection(false)}
          onChanged={async () => {
            await loadState();
            await loadModels();
          }}
        />
        <ReviewDialog
          task={selected}
          source={selectedSource}
          busy={acting}
          originalUrl={selected ? sourceUrl(selected.source, "original") : ""}
          resultUrl={selected ? outputUrl(selected) : ""}
          position={selectedIndex >= 0 ? { index: selectedIndex, total: reviewable.length } : undefined}
          onClose={closeEditor}
          onRevise={revise}
          editor={editor}
          onRemake={
            selected?.post
              ? () => {
                  const i = selected.post!;
                  // The picture being replaced stays one click away (Previous picture), as on the card.
                  try {
                    if (selected.output) localStorage.setItem(prevOutputKey(selected), selected.output);
                  } catch {
                    /* private mode */
                  }
                  setSelected(null);
                  void generatePosts([i], true, false, false, true);
                }
              : undefined
          }
          onPrev={selectedIndex > 0 ? () => setSelected(reviewable[selectedIndex - 1]) : undefined}
          onNext={
            selectedIndex >= 0 && selectedIndex < reviewable.length - 1
              ? () => setSelected(reviewable[selectedIndex + 1])
              : undefined
          }
        />
      </Suspense>
    </div>
  );
}
