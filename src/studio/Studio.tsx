import { lazyScreen } from "@/lib/lazy";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Download,
  FolderOpen,
  ImagePlus,
  KeyRound,
  LoaderCircle,
  LogOut,
  Moon,
  Pause,
  Play,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Sun,
  Trash2,
  Upload,
} from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { del, get, post, postForm } from "@/api";
import { useTheme } from "@/theme";
import { loadLastBatch, loadSavedConfig, saveConfig, saveLastBatch } from "./persist";
import { makeReference } from "@/lib/image";
import { folderCount, isCampaignShot } from "@shared/paths";
import { buildZips, convertImage, saveBlob, saveZips, type ZipEntry, fitImage } from "@/lib/zip";
import {
  DEFAULT_PROMPT,
  cardsPerSource,
  exportsOriginals,
  type Config,
  isSkillCampaign,
  usesProductSets,
  usesBuilder,
} from "@shared/config";
import { estimateCost, formatUsd } from "@shared/pricing";
import {
  numberOutputs,
  outputExt,
  outputName,
  productKey,
  safeArchiveName,
  stemKey,
} from "@shared/naming";
import type {
  LookInfo,
  Batch,
  EngineModel,
  ModeOverride,
  MoodBoardInfo,
  Preset,
  SkillInfo,
  StateResponse,
  Task,
  User,
} from "@shared/types";
const AdminView = lazyScreen(() => import("./AdminView"));
import type { PickedFile } from "@/lib/files";
const BatchesView = lazyScreen(() => import("./BatchesView"));
import { ACCEPTED_TYPES, MAX_UPLOAD_BYTES } from "./constants";
import { useBatch } from "./useBatch";
import ModeCards, { applyModeOverrides } from "./ModeCards";
import BootScreen from "./BootScreen";
import { MODES } from "./constants";
import CreativePanel from "./CreativePanel";
import SourcesTab, { type Pending } from "./SourcesTab";
import ResultsTab from "./ResultsTab";
const ReviewDialog = lazyScreen(() => import("./ReviewDialog"));
import type { EngineInfo } from "./ConnectionDialog";
const ConnectionDialog = lazyScreen(() => import("./ConnectionDialog"));

/** The format a download is encoded in: null keeps the engine's file untouched. */
function exportFormat(c: Config): "jpg" | "webp" | null {
  if (c.output === "jpg" || c.output === "webp") return c.output;
  return c.outputSize !== "quality" ? "jpg" : null;
}

export default function Studio({ user, onSignedOut }: { user: User; onSignedOut: () => void }) {
  const [config, setConfig] = useState<Config>(loadSavedConfig);
  // Remember the settings and the open batch in this browser so a refresh lands where you left off.
  useEffect(() => saveConfig(config), [config]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [engine, setEngine] = useState<EngineInfo>({
    model: "",
    configured: false,
    source: "none",
    openai: "none",
    google: "none",
    fal: "none",
    review: false,
  });
  const [tab, setTab] = useState("sources");
  const [uploading, setUploading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [acting, setActing] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<Task | null>(null);
  const [batchName, setBatchName] = useState("");
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [connection, setConnection] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const [page, setPage] = useState<"studio" | "batches" | "admin">("studio");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [presets, setPresets] = useState<Preset[]>([]);
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [looks, setLooks] = useState<LookInfo[]>([]);
  const loadLooks = useCallback(async () => {
    try {
      setLooks((await get<{ looks: LookInfo[] }>("/api/studio/looks")).looks);
    } catch {
      setLooks([]);
    }
  }, []);
  const [spendThreshold, setSpendThreshold] = useState(20);
  const [zaidDirection, setZaidDirection] = useState("");
  const [moodBoard, setMoodBoard] = useState<MoodBoardInfo | null>(null);
  const [modeOverrides, setModeOverrides] = useState<Record<string, ModeOverride>>({});
  const [hero, setHero] = useState("");
  // Boot screen: wait for the first state load, the approach pictures and the hero video (or a timeout).
  const [stateReady, setStateReady] = useState(false);
  const [imagesReady, setImagesReady] = useState(false);
  const [heroReady, setHeroReady] = useState(false);
  const [bootTimedOut, setBootTimedOut] = useState(false);
  const booted = bootTimedOut || (stateReady && imagesReady && (heroReady || !hero));
  useEffect(() => {
    let left = MODES.length;
    const settle = () => {
      left -= 1;
      if (left <= 0) setImagesReady(true);
    };
    for (const id of MODES) {
      const img = new Image();
      img.onload = settle;
      img.onerror = settle;
      img.src = `/modes/${id}.jpg`;
    }
    const t = setTimeout(() => setBootTimedOut(true), 7000);
    return () => clearTimeout(t);
  }, []);
  const [models, setModels] = useState<EngineModel[]>([]);
  const [openingId, setOpeningId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Config | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const { batch, sources, tasks, active, open, close, action, remove } = useBatch();

  const loadState = useCallback(async () => {
    try {
      const d = await get<StateResponse>("/api/studio/state");
      setBatches(d.batches);
      setEngine(d.engine);
      setSpendThreshold(d.spendThreshold ?? 20);
      setZaidDirection(d.zaidDirection ?? "");
      if (d.moodBoard) setMoodBoard(d.moodBoard);
      const ov = d.modes ?? {};
      setModeOverrides(ov);
      setHero(d.hero ?? "");
      // A hidden approach must not stay selected for new batches.
      setConfig((c) => {
        if (!ov[c.mode]?.hidden) return c;
        const firstVisible = MODES.find((m) => !ov[m.id]?.hidden);
        return firstVisible ? { ...c, mode: firstVisible.id } : c;
      });
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const loadModels = useCallback(async () => {
    try {
      const d = await get<{ models: EngineModel[] }>("/api/studio/engine/models");
      setModels(d.models);
    } catch {
      setModels([]);
    }
  }, []);

  const loadSkills = useCallback(async () => {
    try {
      const list = (await get<{ skills: SkillInfo[] }>("/api/studio/skills")).skills;
      setSkills(list);
      // A hidden or deleted skill must not stay selected for new batches. The Mood board of
      // Creative direction is a built-in entry, not a team skill, so it is always kept.
      setConfig((c) =>
        list.length &&
        !(c.mode === "7" && c.skill === "zaid") &&
        !list.some((s) => s.id === c.skill)
          ? { ...c, skill: list[0].id }
          : c,
      );
    } catch {
      setSkills([]);
    }
  }, []);

  const loadPresets = useCallback(async () => {
    try {
      setPresets((await get<{ presets: Preset[] }>("/api/studio/presets")).presets);
    } catch {
      setPresets([]);
    }
  }, []);

  useEffect(() => {
    void loadState()
      .finally(() => setStateReady(true))
      .then(loadModels)
      .then(loadPresets)
      .then(loadSkills)
      .then(loadLooks);
  }, [loadState, loadModels, loadPresets, loadSkills, loadLooks]);

  // The batches page always shows fresh counts, including batches still generating in the background.
  useEffect(() => {
    if (page !== "batches") return;
    void loadState();
    const timer = setInterval(() => {
      if (!document.hidden) void loadState();
    }, 8000);
    return () => clearInterval(timer);
  }, [page, loadState]);

  // Keep the review dialog on the latest copy of its task while the batch refreshes.
  useEffect(() => {
    if (selected) {
      const fresh = tasks.find((t) => t.id === selected.id);
      if (fresh && fresh !== selected) setSelected(fresh);
    }
  }, [tasks, selected]);

  const viewConfig: Config = useMemo(
    () => draft ?? (batch ? (JSON.parse(batch.config) as Config) : config),
    [batch, config, draft],
  );
  const locked = (!!batch && !draft) || uploading || savingDraft;
  const canEditBatch = !!batch && batch.state !== "running" && !active;

  async function saveDraft() {
    if (!batch || !draft) return;
    setSavingDraft(true);
    try {
      await action("batch/config", { config: draft, name: batch.name });
      setDraft(null);
      await loadState();
      toast.success("Batch settings updated.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSavingDraft(false);
    }
  }
  const sourceUrl = (id: string, kind: "original" | "reference" = "reference") =>
    `/api/studio/file?batch=${batch?.id}&id=${id}&kind=${kind}`;
  const outputUrl = (t: Task) =>
    `/api/studio/file?batch=${batch?.id}&id=${t.id}&kind=result&v=${t.output?.split("/").at(-1)}`;

  // Every generated image can be downloaded; approval is an optional mark, not a gate.
  const ready = tasks.filter(
    (t) => !!t.output && (t.status === "ready" || t.status === "approved" || t.status === "review"),
  );
  const effectiveConfig: Config = { ...viewConfig, model: viewConfig.model || engine.model };
  const pendingLeads = pending.filter((p) => p.role === "lead").length;
  const pendingCost = estimateCost(effectiveConfig, pendingLeads * cardsPerSource(effectiveConfig));
  const toRun = tasks.filter((t) => t.status === "queued" || t.status === "failed");
  const spentSoFar = tasks.reduce((n, t) => n + (t.cost || 0), 0);
  const queueCost = estimateCost(
    effectiveConfig,
    toRun.length,
    toRun.map((t) => t.card),
  );
  const failed = tasks.filter((t) => t.status === "failed");
  const queued = tasks.filter((t) => t.status === "queued");
  const completed = tasks.filter((t) => !!t.output).length;

  function addFiles(picked: PickedFile[], root?: string | null) {
    // Skill campaigns and Zaid creative direction: a folder upload keeps only the _01/_02 shots.
    const fromFolders = picked.some((f) => f.path.includes("/"));
    let trimmed = 0;
    if (usesProductSets(viewConfig.mode) && fromFolders) {
      const kept = picked.filter((f) => !f.path.includes("/") || isCampaignShot(f.path));
      trimmed = picked.length - kept.length;
      picked = kept;
    }
    const names = new Set(pending.map((p) => stemKey(p.name)));
    const additions: Pending[] = [];
    let rejected = 0;
    for (const { file, path } of picked) {
      const name = path.replace(/^\/+/, "");
      const key = stemKey(name);
      if (!ACCEPTED_TYPES.includes(file.type) || file.size > MAX_UPLOAD_BYTES || names.has(key)) {
        rejected++;
        continue;
      }
      names.add(key);
      additions.push({ file, name, url: URL.createObjectURL(file), role: "lead" });
    }
    setPending((p) => [...p, ...additions]);
    const folders = folderCount(additions.map((a) => a.name));
    if (folders >= 2) {
      toast.success(`${folders} folders · ${additions.length} images added.`);
      if (root) setBatchName((n) => n || root);
    }
    if (trimmed)
      toast.info(`${trimmed} photos left out. Only _01 and _02 shots of each product are used.`);
    if (rejected)
      toast.warning(
        `${rejected} files skipped: unsupported, over 12 MB, or duplicate output name.`,
      );
  }

  useEffect(() => saveLastBatch(batch?.id ?? null), [batch?.id]);
  const restoredBatch = useRef(false);
  useEffect(() => {
    if (restoredBatch.current || !batches.length) return;
    restoredBatch.current = true;
    const last = loadLastBatch();
    if (last && batches.some((b) => b.id === last)) void openBatch(last);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batches]);

  async function openBatch(id: string) {
    if (uploading) return;
    setDraft(null);
    setSelection(new Set());
    setOpeningId(id);
    try {
      await open(id);
      setTab("results");
      setPage("studio");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setOpeningId(null);
    }
  }

  async function deleteBatchById(b: Batch) {
    if (
      !window.confirm(`Delete "${b.name}" with all originals and results? This cannot be undone.`)
    )
      return;
    try {
      if (batch?.id === b.id) await remove();
      else await del(`/api/studio/batch?batch=${encodeURIComponent(b.id)}`);
      await loadState();
      toast.success("Batch deleted.");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  function newBatch() {
    if (uploading) return;
    setDraft(null);
    close();
    setSelection(new Set());
    setTab("sources");
  }

  async function saveBatch() {
    if (!pending.length || uploading) return;
    setUploading(true);
    try {
      const id = batch
        ? batch.id
        : (
            await post<{ id: string }>("/api/studio/batch", {
              name: batchName || `Batch · ${new Date().toLocaleDateString("en-GB")}`,
              config: effectiveConfig,
            })
          ).id;
      let uploaded = 0;
      const remaining: Pending[] = [];
      const queue = [...pending];
      setProgress({ done: 0, total: queue.length });
      // Four uploads in flight at once: resizing happens in the browser while other files transfer.
      const worker = async () => {
        for (;;) {
          const p = queue.shift();
          if (!p) return;
          const form = new FormData();
          form.append("file", p.file);
          form.append("name", p.name);
          form.append("role", p.role);
          try {
            form.append("reference", await makeReference(p.file), "reference.jpg");
            await postForm(`/api/studio/upload?batch=${id}`, form);
            uploaded++;
            URL.revokeObjectURL(p.url);
          } catch (e) {
            remaining.push(p);
            toast.error(`${p.name}: ${(e as Error).message}`);
          }
          setProgress((pr) => (pr ? { ...pr, done: pr.done + 1 } : pr));
        }
      };
      await Promise.all(Array.from({ length: 4 }, worker));
      setPending(remaining);
      setProgress(null);
      await open(id);
      await loadState();
      if (uploaded) {
        toast.success(`${uploaded} originals saved. Ready to generate.`);
        setTab("results");
      } else toast.error("No images uploaded. Original selections are kept.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(false);
    }
  }

  async function runAction(path: string, body?: Record<string, unknown>) {
    setActing(true);
    try {
      await action(path, body);
      await loadState();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setActing(false);
    }
  }

  async function start() {
    if (
      !engine.configured &&
      engine.openai === "none" &&
      engine.google === "none" &&
      engine.fal === "none"
    ) {
      setConnection(true);
      return;
    }
    if (queueCost.known && spendThreshold > 0 && queueCost.total > spendThreshold) {
      const ok = window.confirm(
        `This run is estimated at ${formatUsd(queueCost.total)} for ${queueCost.images} images on ${effectiveConfig.model}. Continue?`,
      );
      if (!ok) return;
    }
    // Edits still open in the panel are what the user sees: apply them before the run starts.
    if (draft && batch) {
      setSavingDraft(true);
      try {
        await action("batch/config", { config: draft, name: batch.name });
        setDraft(null);
      } catch (e) {
        toast.error((e as Error).message);
        return;
      } finally {
        setSavingDraft(false);
      }
    }
    setTab("results");
    await runAction("start");
  }

  async function revise(edit: string) {
    if (!selected) return;
    await runAction("revise", { id: selected.id, edit });
    toast.info("Revision queued. The previous result stays until the new one arrives.");
  }

  /** Keep this image's skill prompt as a reusable look for its skill. */
  async function saveLook(t: Task) {
    const name = window.prompt("Name this look (for example: Paris corner, golden hour)");
    if (!name?.trim()) return;
    try {
      await post("/api/studio/looks", { task: t.id, name: name.trim() });
      await loadLooks();
      toast.success(`Saved look "${name.trim()}". Pick it under Direction for this skill.`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  /** Save one AI result with the same name and format the export would use. */
  async function downloadOne(t: Task) {
    const src = sources.find((x) => x.id === t.source);
    if (!t.output || !src) return;
    try {
      const srcExt = outputExt(t.output);
      let blob = await (await fetch(outputUrl(t))).blob();
      let ext = srcExt;
      const fit = viewConfig.outputSize !== "quality";
      // The size setting wins: "1 to 1.9 MB" fits every image (a PNG choice exports as JPG, since
      // PNG cannot be sized without losing resolution); "As generated" keeps the engine's file.
      const format = exportFormat(viewConfig);
      if (format && (fit || srcExt !== format)) {
        blob = fit
          ? await fitImage(blob, format, viewConfig.outputQuality || 90)
          : await convertImage(blob, format, viewConfig.outputQuality || 90);
        ext = format;
      }
      const name = outputName(src.name, outputNumbers().get(t) ?? 1, ext);
      saveBlob(blob, name.split("/").pop() ?? name);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  // Review navigation across generated images, in grid order.
  const reviewable = tasks.filter((t) => !!t.output);
  const selectedIndex = selected ? reviewable.findIndex((t) => t.id === selected.id) : -1;
  const goPrev = selectedIndex > 0 ? () => setSelected(reviewable[selectedIndex - 1]) : undefined;
  const goNext =
    selectedIndex >= 0 && selectedIndex < reviewable.length - 1
      ? () => setSelected(reviewable[selectedIndex + 1])
      : undefined;

  async function deleteBatch() {
    if (!batch || active) return;
    if (
      !window.confirm(
        `Delete "${batch.name}" with all originals and results? This cannot be undone.`,
      )
    )
      return;
    try {
      await remove();
      await loadState();
      setTab("sources");
      toast.success("Batch deleted.");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  /** Every generated image's number within its product, over the whole batch, so names are stable. */
  function outputNumbers(): Map<Task, number> {
    const byId = new Map(sources.map((x) => [x.id, x]));
    return numberOutputs(
      ready,
      (t) => byId.get(t.source)?.name ?? "",
      (t) => t.card,
    );
  }

  /** ZIP entries for a list of results, named and converted the way the export does it. */
  function zipEntriesFor(list: Task[]): ZipEntry[] {
    const byId = new Map(sources.map((x) => [x.id, x]));
    const numbers = outputNumbers();
    const format = exportFormat(viewConfig);
    return list.map((t) => {
      const srcExt = outputExt(t.output);
      const fit = viewConfig.outputSize !== "quality";
      const convert =
        format && (fit || srcExt !== format)
          ? { format, quality: viewConfig.outputQuality || 90, fit }
          : undefined;
      return {
        name: outputName(byId.get(t.source)!.name, numbers.get(t) ?? 1, convert?.format ?? srcExt),
        url: outputUrl(t),
        convert,
      };
    });
  }

  /** The generated images of one product set (same product id, e.g. _01 and _02) as one ZIP, folder kept. */
  async function downloadSet(t: Task) {
    if (exporting) return;
    const byId = new Map(sources.map((x) => [x.id, x]));
    const key = productKey(byId.get(t.source)?.name ?? "");
    const members = ready.filter((x) => productKey(byId.get(x.source)?.name ?? "") === key);
    if (!members.length) {
      toast.error("No generated images in this set yet.");
      return;
    }
    setExporting(true);
    try {
      const folder = (byId.get(t.source)?.name ?? "").split("/").slice(0, -1).pop() || key;
      const entries = zipEntriesFor(members);
      // The set's originals go in beside the AI images, in the same folder.
      const originals = sources.filter((s) => productKey(s.name) === key);
      for (const s of originals) entries.push({ name: s.name, url: sourceUrl(s.id, "original") });
      await saveZips(await buildZips(entries), `${safeArchiveName(folder)}-AI`);
      toast.success(`${members.length + originals.length} files of ${key} downloaded.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setExporting(false);
    }
  }

  async function downloadZip() {
    if (!batch || exporting) return;
    const chosen = ready.filter((t) => selection.size === 0 || selection.has(t.id));
    if (!chosen.length) {
      toast.error("No generated images to download yet.");
      return;
    }
    setExporting(true);
    try {
      const entries = zipEntriesFor(chosen);
      // Originals sit next to their AI images, in the same product folder, under their own name.
      const originalsIncluded = exportsOriginals(viewConfig);
      if (originalsIncluded)
        for (const s of sources) entries.push({ name: s.name, url: sourceUrl(s.id, "original") });
      const parts = await buildZips(entries);
      await saveZips(parts, `${safeArchiveName(batch.name)}-AI`);
      if (parts.length > 1)
        toast.success(`Export split into ${parts.length} ZIP files of up to 1.4 GB each.`);
      toast.success(`${chosen.length} results exported.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setExporting(false);
    }
  }

  async function signOut() {
    await post("/api/auth/logout").catch(() => {});
    onSignedOut();
  }

  const selectedSource = selected ? (sources.find((s) => s.id === selected.source) ?? null) : null;
  const running = batch?.state === "running";
  const inflight = tasks.filter((t) => t.status === "processing");
  const settled = tasks.filter(
    (t) => t.status === "ready" || t.status === "approved" || t.status === "failed",
  );
  const costTag = queueCost.images && queueCost.known ? ` · ≈ ${formatUsd(queueCost.total)}` : "";
  // A batch that already ran and stopped (paused on an error, or idle with work left) resumes rather than starts.
  const resumes = !!batch && batch.state === "paused" && queued.length > 0;
  const startLabel =
    (failed.length && !queued.length
      ? `Retry ${failed.length}`
      : resumes
        ? `Resume ${queued.length}`
        : `Generate ${queued.length || ""}`.trim()) + costTag;

  return (
    <div className={`studio ${settingsOpen ? "settings-open" : ""}`}>
      <BootScreen done={booted} />
      <header className="topbar">
        <a href="/" className="brand" aria-label="Level Social Media">
          <img className="max-logo" src="/logo-mark.png" alt="Level" width={96} height={32} />
          <span className="brand-divider" />
          <span className="studio-title">
            SOCIAL MEDIA<span>LEVEL MENA</span>
          </span>
        </a>
        <nav className="nav-tabs" aria-label="Pages">
          <button className={page === "studio" ? "active" : ""} onClick={() => setPage("studio")}>
            Studio
          </button>
          <button className={page === "batches" ? "active" : ""} onClick={() => setPage("batches")}>
            Batches <span>{batches.length}</span>
          </button>
          {user.role === "admin" && (
            <button className={page === "admin" ? "active" : ""} onClick={() => setPage("admin")}>
              Admin
            </button>
          )}
        </nav>
        <div className="top-actions">
          <span className="engine-tag">
            <Sparkles size={15} />{" "}
            {models.find((m) => m.slug === engine.model)?.name ?? engine.model ?? "…"}
          </span>
          <button
            className={`connection-button ${engine.configured || engine.openai !== "none" || engine.google !== "none" || engine.fal !== "none" ? "connected" : ""}`}
            onClick={() => setConnection(true)}
          >
            <KeyRound size={16} />
            {engine.configured ||
            engine.openai !== "none" ||
            engine.google !== "none" ||
            engine.fal !== "none"
              ? "Connected"
              : "Not connected"}
          </button>
          <button
            className="theme-button"
            onClick={toggleTheme}
            title={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
            aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
          >
            {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          <button className="user-button" onClick={() => void signOut()} title={user.email}>
            <LogOut size={15} /> {user.name}
          </button>
        </div>
      </header>

      <main>
        {page === "admin" ? (
          <>
            <div className="page-heading">
              <div>
                <div className="eyebrow">ADMINISTRATION</div>
                <h1>Team, spend and workspace settings.</h1>
                <p>Invite code, spend confirmation, retention, notifications and member access.</p>
              </div>
            </div>
            <Suspense fallback={null}>
              <AdminView me={user.id} />
            </Suspense>
          </>
        ) : page === "batches" ? (
          <>
            <div className="page-heading">
              <div>
                <div className="eyebrow">SAVED BATCHES</div>
                <h1>Every collection you have processed.</h1>
                <p>
                  Open a batch to review, revise or export. Generation continues on the server while
                  you are away.
                </p>
              </div>
              <button
                className="secondary"
                onClick={() => {
                  newBatch();
                  setPage("studio");
                }}
                disabled={uploading}
              >
                <ImagePlus size={17} />
                New batch
              </button>
            </div>
            <section className="batches-page">
              <Suspense fallback={null}>
                <BatchesView
                  batches={batches}
                  skills={skills}
                  modes={applyModeOverrides(modeOverrides)}
                  busyId={openingId}
                  onOpen={(id) => void openBatch(id)}
                  onDelete={(b) => void deleteBatchById(b)}
                />
              </Suspense>
            </section>
          </>
        ) : (
          <>
            {hero ? (
              <div className="hero-banner hero-with-title">
                <video
                  key={hero}
                  autoPlay
                  muted
                  loop
                  playsInline
                  preload="auto"
                  onCanPlay={() => setHeroReady(true)}
                  onError={() => {
                    setHero("");
                    setHeroReady(true);
                  }}
                >
                  <source src={`/api/studio/hero?f=webm&v=${hero}`} type="video/webm" />
                  <source src={`/api/studio/hero?v=${hero}`} type="video/mp4" />
                </video>
                <div className="hero-veil" />
                <div className="hero-content">
                  <div className="eyebrow">PRODUCT PHOTOGRAPHY / WORKSPACE</div>
                  <h1>From prompt to lifestyle.</h1>
                  <p>One collection. Every image. Your creative direction.</p>
                </div>
                <button className="secondary hero-cta" onClick={newBatch} disabled={uploading}>
                  <ImagePlus size={17} />
                  New batch
                </button>
              </div>
            ) : (
              <div className="page-heading">
                <div>
                  <div className="eyebrow">PRODUCT PHOTOGRAPHY / WORKSPACE</div>
                  <h1>From prompt to lifestyle.</h1>
                  <p>One collection. Every image. Your creative direction.</p>
                </div>
                <button className="secondary" onClick={newBatch} disabled={uploading}>
                  <ImagePlus size={17} />
                  New batch
                </button>
              </div>
            )}

            <ModeCards
              value={viewConfig.mode}
              disabled={locked}
              overrides={modeOverrides}
              canEdit={user.role === "admin"}
              onOverridesChanged={(ov) => {
                setModeOverrides(ov);
                setConfig((c) => {
                  if (!ov[c.mode]?.hidden) return c;
                  const firstVisible = MODES.find((m) => !ov[m.id]?.hidden);
                  return firstVisible ? { ...c, mode: firstVisible.id } : c;
                });
              }}
              onChange={(mode) =>
                setConfig((c) => ({
                  ...c,
                  mode,
                  input: mode === "1" || mode === "6" ? c.input : "model",
                  // Zaid creative direction opens on Zaid's own mood board; the campaigns never use it.
                  skill: mode === "7" ? "zaid" : c.skill === "zaid" ? "editorial" : c.skill,
                  // The skill prompt builder writes its own scene text; the default prompt would only confuse it.
                  prompt: isSkillCampaign(mode)
                    ? isSkillCampaign(c.mode)
                      ? c.prompt
                      : ""
                    : mode === "7"
                      ? zaidDirection
                      : mode === "9"
                        ? ""
                        : usesBuilder(c.mode) || !c.prompt
                          ? DEFAULT_PROMPT
                          : c.prompt,
                }))
              }
            />

            <div className="workbench">
              <button
                type="button"
                className="settings-fab"
                onClick={() => setSettingsOpen((v) => !v)}
                aria-expanded={settingsOpen}
              >
                <SlidersHorizontal size={16} />
                {settingsOpen ? "Close settings" : "Settings"}
              </button>
              {settingsOpen && (
                <div className="sheet-backdrop" onClick={() => setSettingsOpen(false)} />
              )}
              <CreativePanel
                looks={looks}
                onLooksChanged={() => void loadLooks()}
                config={viewConfig}
                locked={locked}
                saved={!!batch}
                models={models}
                defaultModel={engine.model}
                onChange={(patch) =>
                  draft
                    ? setDraft((d) => (d ? { ...d, ...patch } : d))
                    : setConfig((c) => ({ ...c, ...patch }))
                }
                editing={!!draft}
                canEdit={canEditBatch}
                saving={savingDraft}
                onEdit={() => batch && setDraft(JSON.parse(batch.config) as Config)}
                onSave={() => void saveDraft()}
                onCancel={() => setDraft(null)}
                presets={presets}
                onPresetsChanged={loadPresets}
                defaultDirection={zaidDirection}
                onDirectionSaved={setZaidDirection}
                moodBoard={moodBoard}
                onMoodBoardChanged={setMoodBoard}
                skills={skills}
                onSkillsChanged={(list, id) => {
                  setSkills(list);
                  if (id && !draft) setConfig((c) => ({ ...c, skill: id }));
                  else if (
                    !(viewConfig.mode === "7" && viewConfig.skill === "zaid") &&
                    !list.some((s) => s.id === viewConfig.skill) &&
                    !draft &&
                    list[0]
                  )
                    setConfig((c) => ({ ...c, skill: list[0].id }));
                }}
              />

              <section className="media-panel">
                <div className="media-heading">
                  <div>
                    <span className="step">03</span>
                    <h2>{batch ? batch.name : "Your image batch"}</h2>
                  </div>
                  {batches.length > 0 && (
                    <Select value={batch?.id || ""} onValueChange={openBatch} disabled={uploading}>
                      <SelectTrigger className="batch-picker" aria-label="Saved batches">
                        <FolderOpen size={15} />
                        <SelectValue placeholder="Saved batches" />
                      </SelectTrigger>
                      <SelectContent>
                        {batches.map((b) => (
                          <SelectItem key={b.id} value={b.id}>
                            {b.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </div>

                {error && (
                  <div role="alert" className="error-banner">
                    {error}
                    <button onClick={() => void loadState()}>Retry</button>
                  </div>
                )}
                {batch?.last_error && batch.state === "paused" && (
                  <div role="alert" className="error-banner">
                    Paused: {batch.last_error}
                    <button onClick={() => void runAction("retry")}>Resume</button>
                  </div>
                )}

                <Tabs value={tab} onValueChange={setTab} className="media-tabs">
                  <div className="tabbar">
                    <TabsList className="tabs-list">
                      <TabsTrigger value="sources">
                        Originals <span>{batch ? sources.length : pending.length}</span>
                      </TabsTrigger>
                      <TabsTrigger value="results">
                        Results <span>{completed}</span>
                      </TabsTrigger>
                    </TabsList>
                    <span className="format-note">JPG · PNG · WEBP</span>
                  </div>
                  <TabsContent value="sources">
                    <SourcesTab
                      batchOpen={!!batch}
                      config={viewConfig}
                      sources={sources}
                      pending={pending}
                      uploading={uploading}
                      batchName={batchName}
                      sourceUrl={(id) => sourceUrl(id)}
                      onFiles={addFiles}
                      onRemove={(url) => {
                        URL.revokeObjectURL(url);
                        setPending((a) => a.filter((x) => x.url !== url));
                      }}
                      onRole={(url, role) =>
                        setPending((a) => a.map((x) => (x.url === url ? { ...x, role } : x)))
                      }
                      onRoles={(urls, role) => {
                        const set = new Set(urls);
                        setPending((a) => a.map((x) => (set.has(x.url) ? { ...x, role } : x)));
                      }}
                      onBatchName={setBatchName}
                      skills={skills}
                      canAssignSkill={
                        !!batch && viewConfig.mode === "7" && batch.state !== "running"
                      }
                      onAssignSkill={(ids, skill) => action("sources/skill", { ids, skill })}
                      moodBoardHidden={!!moodBoard?.hidden}
                      moodBoardTitle={moodBoard?.title}
                    />
                  </TabsContent>
                  <TabsContent value="results">
                    <ResultsTab
                      tasks={tasks}
                      sources={sources}
                      mode={viewConfig.mode}
                      running={running}
                      selection={selection}
                      outputUrl={outputUrl}
                      sourceUrl={(id) => sourceUrl(id)}
                      onSelect={(id, on) =>
                        setSelection((a) => {
                          const n = new Set(a);
                          if (on) n.add(id);
                          else n.delete(id);
                          return n;
                        })
                      }
                      onClearSelection={() => setSelection(new Set())}
                      onOpen={setSelected}
                      onRetryTask={(t) => void runAction("task/retry", { id: t.id })}
                      onDownloadTask={(t) => void downloadOne(t)}
                      onDownloadSet={(t) => void downloadSet(t)}
                      skills={skills}
                      batchSkill={viewConfig.skill}
                      moodBoardHidden={!!moodBoard?.hidden}
                      moodBoardTitle={moodBoard?.title}
                      canAssignSkill={
                        !!batch && viewConfig.mode === "7" && batch.state !== "running"
                      }
                      onAssignSkill={(ids, skill) => action("sources/skill", { ids, skill })}
                    />
                  </TabsContent>
                </Tabs>

                {batch && pending.length > 0 && (
                  <div className="error-banner">
                    {pending.length} uploads need retry.
                    <button onClick={() => void saveBatch()} disabled={uploading}>
                      Retry uploads
                    </button>
                  </div>
                )}

                <footer className="batch-footer">
                  <div>
                    <strong>
                      {batch
                        ? `${ready.length} generated · download any time${spentSoFar ? ` · spent ≈ ${formatUsd(spentSoFar)}` : ""}${queueCost.images && queueCost.known ? ` · next run ≈ ${formatUsd(queueCost.total)}` : ""}`
                        : `${pending.length} images selected${pendingCost.images && pendingCost.known ? ` · ${pendingCost.images} AI results ≈ ${formatUsd(pendingCost.total)}` : ""}`}
                    </strong>
                    <span>
                      {running
                        ? "Generation continues on the server even if you close this tab."
                        : batch?.state === "paused" && batch.last_error
                          ? `Paused after an error: ${batch.last_error}`
                          : batch
                            ? queueCost.images && queueCost.known
                              ? `Estimate at ${formatUsd(queueCost.perImage)} per image on ${effectiveConfig.model}${queueCost.economy ? " (economy)" : ""}. Retries and revisions cost extra.`
                              : "Originals and results are saved."
                            : pendingCost.images && pendingCost.known
                              ? `Estimate at ${formatUsd(pendingCost.perImage)} per image on ${effectiveConfig.model}${pendingCost.economy ? " (economy)" : ""}. Originals will be saved before generation.`
                              : "Originals will be saved before generation."}
                    </span>
                  </div>
                  <div className="footer-actions">
                    {!batch ? (
                      <button
                        className="primary"
                        onClick={() => void saveBatch()}
                        disabled={!pending.length || uploading}
                      >
                        {uploading ? (
                          <LoaderCircle className="spinning" size={17} />
                        ) : (
                          <Upload size={17} />
                        )}
                        {progress ? `Saving ${progress.done} / ${progress.total}` : "Save batch"}
                      </button>
                    ) : (
                      <>
                        {running ? (
                          <>
                            <button className="primary" disabled aria-live="polite">
                              <LoaderCircle className="spinning" size={17} />
                              {`Generating · ${settled.length} of ${tasks.length}`}
                              {inflight.length ? ` · ${inflight.length} in progress` : ""}
                            </button>
                            <button
                              className="secondary"
                              onClick={() => void runAction("pause")}
                              disabled={acting}
                            >
                              <Pause size={17} />
                              Pause
                            </button>
                          </>
                        ) : (
                          <button
                            className="primary"
                            onClick={() =>
                              void (failed.length && !queued.length ? runAction("retry") : start())
                            }
                            disabled={acting || (!queued.length && !failed.length)}
                          >
                            {acting ? (
                              <LoaderCircle className="spinning" size={17} />
                            ) : engine.configured ? (
                              failed.length && !queued.length ? (
                                <RotateCcw size={17} />
                              ) : (
                                <Play size={17} />
                              )
                            ) : (
                              <KeyRound size={17} />
                            )}
                            {engine.configured ||
                            engine.openai !== "none" ||
                            engine.google !== "none" ||
                            engine.fal !== "none"
                              ? startLabel
                              : "Connect & generate"}
                          </button>
                        )}
                        <button
                          className="secondary"
                          onClick={() => void downloadZip()}
                          disabled={!ready.length || exporting}
                        >
                          {exporting ? (
                            <LoaderCircle className="spinning" size={17} />
                          ) : (
                            <Download size={17} />
                          )}
                          Download ZIP
                        </button>
                        <button
                          className="secondary danger"
                          onClick={() => void deleteBatch()}
                          disabled={active || acting}
                          aria-label="Delete batch"
                        >
                          <Trash2 size={17} />
                        </button>
                      </>
                    )}
                  </div>
                </footer>
              </section>
            </div>
          </>
        )}
        <footer className="page-footer">
          <span>level mena / social media</span>
          <span>AI results require visual approval before publishing.</span>
        </footer>
      </main>

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
          position={
            selectedIndex >= 0 ? { index: selectedIndex, total: reviewable.length } : undefined
          }
          onClose={() => setSelected(null)}
          onRevise={revise}
          onDownload={selected?.output ? () => void downloadOne(selected) : undefined}
          onDownloadSet={
            selected?.output &&
            ready.filter(
              (x) =>
                productKey(sources.find((y) => y.id === x.source)?.name ?? "") ===
                productKey(sources.find((y) => y.id === selected.source)?.name ?? ""),
            ).length > 1
              ? () => void downloadSet(selected)
              : undefined
          }
          onSaveLook={
            selected?.brief && usesBuilder(viewConfig.mode)
              ? () => void saveLook(selected)
              : undefined
          }
          onPrev={goPrev}
          onNext={goNext}
        />
      </Suspense>
    </div>
  );
}
