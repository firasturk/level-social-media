import { lazyScreen } from "@/lib/lazy";
import { askConfirm } from "@/lib/confirm";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { del, get, post, postForm, put } from "@/api";
import { useTheme } from "@/theme";
import { makeReference } from "@/lib/image";
import { buildZips, saveBlob, saveZips, type ZipEntry } from "@/lib/zip";
import { canvasBlob, loadFont, loadImage, renderOverlay } from "@/lib/overlay";
import { buildFeedPdf, type FeedPost } from "@/lib/feedPdf";
import { resolveOverlay } from "@shared/overlay";
import { postConfig, type Config, type Size } from "@shared/config";
import { currentMonth, monthLabel, postFileName, type Format, type Post } from "@shared/posts";
import { testSize } from "@shared/pricing";
import type {
  Ambassador,
  Batch,
  Client,
  EngineModel,
  StateResponse,
  QA,
  Task,
  Theme,
  User,
} from "@shared/types";
import Sidebar, { type Page } from "./Sidebar";
import BootScreen from "./BootScreen";
import BrandPanel, { type OutputSettings } from "./BrandPanel";
import PlanView from "./PlanView";
import Journey from "./Journey";
import type { JourneyPost } from "./JourneyResults";
import Radio, { stopRadio } from "./Radio";
import BriefCard from "./BriefCard";
import StyleScreen from "./StyleGallery";
import { askNotifications, chime, notify } from "@/lib/celebrate";
import { Compass } from "lucide-react";
import { useBatch } from "./useBatch";
import { ACCEPTED_TYPES, MAX_UPLOAD_BYTES } from "./constants";
import type { EngineInfo } from "./ConnectionDialog";
const AdminView = lazyScreen(() => import("./AdminView"));
const BatchesView = lazyScreen(() => import("./BatchesView"));
const ReviewDialog = lazyScreen(() => import("./ReviewDialog"));
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
  const [page, setPage] = useState<Page>(() => (atStyles() ? "styles" : "studio"));
  // The address follows the page (and Back returns from the styles), so /styles can be bookmarked.
  useEffect(() => {
    const want = page === "styles";
    if (want !== atStyles()) window.history.pushState(null, "", want ? STYLES_PATH : "/");
  }, [page]);
  useEffect(() => {
    const onPop = () => setPage((p) => (atStyles() ? "styles" : p === "styles" ? "studio" : p));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [clients, setClients] = useState<Client[]>([]);
  const [themes, setThemes] = useState<Theme[]>([]);
  const [models, setModels] = useState<EngineModel[]>([]);
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
  const [month, setMonth] = useState<string>(() => remembered(MONTH_KEY) || currentMonth());
  const [busy, setBusy] = useState("");
  const [exporting, setExporting] = useState(false);
  const [acting, setActing] = useState(false);
  const [selected, setSelected] = useState<Task | null>(null);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [showOverlay, setShowOverlay] = useState(true);
  const [themeRefs, setThemeRefs] = useState<{ id: string; name: string | null }[]>([]);
  const { batch, sources, tasks, active, open, close, refresh, action, remove } = useBatch();
  const [journey, setJourney] = useState(() => (!journeyDone() || journeyOpen()) && !atStyles());
  // Only "Skip to the studio" or Generate leaves the journey: a refresh keeps the team in it.
  useEffect(() => {
    try {
      if (journey) sessionStorage.setItem(JOURNEY_OPEN_KEY, "1");
      else sessionStorage.removeItem(JOURNEY_OPEN_KEY);
    } catch {
      /* private mode */
    }
  }, [journey]);
  const finishJourney = useCallback(() => {
    try {
      sessionStorage.setItem(JOURNEY_KEY, "1");
    } catch {
      /* private mode */
    }
    setJourney(false);
    setPage("studio");
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setBootTimedOut(true), 7000);
    return () => clearTimeout(t);
  }, []);
  useEffect(() => remember(CLIENT_KEY, clientId), [clientId]);
  useEffect(() => remember(MONTH_KEY, month), [month]);

  const loadState = useCallback(async () => {
    try {
      const d = await get<StateResponse>("/api/studio/state");
      setBatches(d.batches);
      setEngine(d.engine);
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
  const overlaySpec = useMemo(() => {
    const spec = resolveOverlay(client?.overlay);
    const src = client?.badge ? `/api/studio/clients/${client.id}/badge?v=${client.updated}` : null;
    return { ...spec, badge: { ...spec.badge, src } };
  }, [client]);
  const logoSrc = client?.logo ? `/api/studio/clients/${client.id}/logo?v=${client.updated}` : null;
  // Brand font files are registered with the browser once per client so the canvas can use them.
  useEffect(() => {
    for (const f of client?.fontFiles ?? [])
      void loadFont(f.name, `/api/studio/clients/${client!.id}/fonts/${f.id}/file`);
  }, [client]);
  const planOf = useCallback(
    (c: string, m: string) => batches.find((b) => b.client === c && b.month === m) ?? null,
    [batches],
  );
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

  async function generateIdeas(notes: string): Promise<boolean> {
    if (!googleReady && engine.openai === "none") {
      setConnection(true);
      return false;
    }
    setBusy("ideas");
    try {
      const id = await ensurePlan();
      // A month that follows a grid is planned from the grid, tile by tile.
      const r = await post<{ plan: Post[] }>(config?.gridRef ? "/api/studio/posts/grid-ideas" : "/api/studio/posts/ideas", {
        batch: id,
        ref: config?.gridRef,
        notes: notes || undefined,
        count: shownSettings.postCount,
      });
      await refresh();
      toast.success(`${r.plan.length} ideas ready. Edit anything, then generate the posts.`);
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    } finally {
      setBusy("");
    }
  }

  async function gridIdeas(refId: string, notes: string) {
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
      });
      await refresh();
      toast.success(`${r.plan.length} posts planned from the reference grid.`);
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
      setPendingStyles((await get<{ n: number }>("/api/studio/styles/pending")).n);
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
  async function assignStyles(assign: { index: number; style: string | null }[]) {
    if (!batch || !assign.length) return;
    const t = toast.loading(
      assign.length > 1 ? `Writing ${assign.length} styles for your products…` : "Writing the style for this product…",
    );
    try {
      await post("/api/studio/posts/style", { batch: batch.id, assign });
      await refresh();
      toast.success(assign.some((a) => a.style) ? "Style written for the product." : "Style taken off.", { id: t });
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

  async function generatePosts(indexes?: number[], regenerate?: boolean, askFirst = true, test = false) {
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
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  /** The test post of the journey's last screen: its image and what the automatic review found. */
  const testPost = useMemo(() => {
    const i = config?.testPost;
    if (!i || !plan.some((p) => p.index === i)) return null;
    const t = tasks.find((x) => x.post === i);
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
        return {
          index: p.index,
          taskId: t?.id ?? null,
          status: t?.status ?? "none",
          url: t?.output ? outputUrl(t) : null,
          output: t?.output ?? null,
          error: t?.error ?? null,
          flags: qa?.automated ? (qa.flags ?? []) : null,
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
    const stale = tasks.some((t) => t.post && plan.some((p) => p.index === t.post) && t.updated < plannedAt);
    if (!stale) return generatePosts(undefined, false, false);
    // Only what is older than the ideas, missing or failed is made again: a fresh test post stays.
    const due = plan
      .filter((p) => {
        const t = tasks.find((x) => x.post === p.index);
        return !t || t.status === "failed" || t.updated < plannedAt || (testPost?.draft && testPost.index === p.index);
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
            { patch: p?.ov },
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
              { patch: p.ov },
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
    if (!(await askConfirm(`Delete ${client?.name ?? ""} · ${month} with its products and posts?`, { ok: "Delete" }))) return;
    try {
      await remove();
      await loadState();
      toast.success("Month deleted.");
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
      await open(id);
      setPage("studio");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setOpeningId(null);
    }
  }

  async function deletePlanById(b: Batch) {
    if (!(await askConfirm(`Delete "${b.name}" with its products and posts?`, { ok: "Delete" }))) return;
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
  const running = batch?.state === "running" || active;

  return (
    <div className="studio">
      <BootScreen done={bootTimedOut || stateReady} />
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
                  busyId={openingId}
                  onOpen={(id) => void openPlan(id)}
                  onDelete={(b) => void deletePlanById(b)}
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
            <div className="workspace-head">
              <div>
                <div className="eyebrow">Client</div>
                <h1>{client.name}</h1>
                <p>Brand kit and theme on the left; the month's products and posts on the right.</p>
              </div>
              <button type="button" className="secondary" onClick={() => setJourney(true)}>
                <Compass size={15} /> Start journey
              </button>
            </div>
            {config && (
              <BriefCard
                config={config}
                theme={themes.find((t) => t.id === themeId) ?? null}
                plan={plan}
                onShare={() => void shareMonth()}
              />
            )}
            <div className="workbench posts-workbench">
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
              <PlanView
                onStyles={assignStyles}
                client={client}
                month={month}
                onMonth={setMonth}
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
                plannedAt={config?.plannedAt ?? null}
                onGridIdeas={(ref, notes) => void gridIdeas(ref, notes)}
                onClearGrid={() => void clearGrid()}
                fileBase={`${client.slug}_${month}`}
                onUploadProducts={(files) => void uploadProducts(files)}
                onRemoveProduct={(id) => void removeProduct(id)}
                onGenerateIdeas={(notes) => void generateIdeas(notes)}
                onNewIdea={(i) => void newIdea(i)}
                cast={ambassadors.filter((a) => castIds.includes(a.id))}
                onPostCount={(n) => void updateSettings({ postCount: n })}
                onSavePlan={(p) => void savePlan(p)}
                onGeneratePosts={(i, r) => void generatePosts(i, r)}
                onOpen={setSelected}
                onExport={() => void exportMonth()}
                onExportPdf={() => void exportFeedPdf()}
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
              />
            </div>
          </>
        )}
        <footer className="page-footer">
          <span>level mena / social media</span>
          <span>Every post is reviewed by a designer before publishing.</span>
        </footer>
      </main>

      <Radio className={journey ? "in-journey" : ""} />
      {journey && stateReady && clients.some((c) => c.status === "active") && (
        <Journey
          user={user}
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
          onGenerateIdeas={() => generateIdeas(config?.notes ?? "")}
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
          onRetake={(index) => generatePosts([index], true, false)}
          onFix={async (index, edit) => {
            const t = tasks.find((x) => x.post === index);
            if (!t) return;
            try {
              await action("revise", { id: t.id, edit });
              toast.success(`Fixing post ${index}.`);
            } catch (e) {
              toast.error((e as Error).message);
            }
          }}
          onShare={shareMonth}
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
          onClose={() => setSelected(null)}
          onRevise={revise}
          onRemake={
            selected?.post
              ? () => {
                  const i = selected.post!;
                  setSelected(null);
                  void generatePosts([i], true, false);
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
