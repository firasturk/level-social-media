/**
 * The AI tools' logic: the catalog (which tools each provider lists today, the option lists, the
 * balances), the picked tool and its options, the estimate ("About N credits · balance M" or "cost
 * not known"), the confirm and the run, the post's jobs polled while one is pending, the result on
 * the canvas, "Use as the post's picture" / "Save as a product photo", and the prefill a preset
 * card sends ("Use this style"). Members see the list and "Admins only for now": `locked` is true
 * per provider and no run is possible.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ApiError } from "@/api";
import { askConfirm } from "@/lib/confirm";
import { PHOTO_TOOLS, photoTool, TOOL_PROVIDER_LABELS, type PhotoToolJob, type ToolCatalog, type ToolChoice, type ToolDef, type ToolOption, type ToolProvider } from "@shared/photo-tools";
import type { PhotoPresetCard, PresetUse } from "@shared/photo-presets";
import { heldMessage } from "@shared/client-hold";
import { patchSession } from "../editing-session";
import { applyToolResult, listPhotoPresets, recheckToolJob, toolCatalog, toolEstimate, toolJobs, toolRun, type ConfirmAsk } from "./photoApi";

export interface PhotoToolsOptions {
  batchId?: string | null;
  post: number;
  /** The post has a picture to work on. */
  hasPicture: boolean;
  /** The month changed (a picture replaced, a product added). */
  onChanged?: () => void | Promise<void>;
  active: boolean;
}

export interface Estimate {
  credits: number | null;
  balance: number | null;
  text: string;
}

export function usePhotoTools({ batchId, post, hasPicture, onChanged, active }: PhotoToolsOptions) {
  const [catalog, setCatalog] = useState<ToolCatalog | null>(null);
  const [catalogError, setCatalogError] = useState("");
  const [loadingCatalog, setLoadingCatalog] = useState(false);
  const [provider, setProvider] = useState<ToolProvider>("higgsfield");
  const [toolId, setToolId] = useState<string>("hf-upscale");
  const [options, setOptions] = useState<Record<string, string>>({});
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [running, setRunning] = useState(false);
  const [jobs, setJobs] = useState<PhotoToolJob[]>([]);
  const [jobId, setJobId] = useState<string | null>(null);
  const [using, setUsing] = useState<"picture" | "product" | null>(null);
  const [checking, setChecking] = useState<string | null>(null);
  const [soulStyles, setSoulStyles] = useState<ToolChoice[]>([]);
  const [styleNames, setStyleNames] = useState<Record<string, string>>({});
  const loaded = useRef(false);
  const timer = useRef<number | null>(null);

  const loadCatalog = useCallback(async (refresh = false) => {
    setLoadingCatalog(true);
    setCatalogError("");
    try {
      setCatalog(await toolCatalog(refresh));
    } catch (e) {
      setCatalogError((e as Error).message);
    } finally {
      setLoadingCatalog(false);
    }
  }, []);
  useEffect(() => {
    if (!active || loaded.current) return;
    loaded.current = true;
    void loadCatalog();
    // The Soul styles fill the Generate tool's style choice (the same list as the Styles presets).
    listPhotoPresets("styles")
      .then((r) => {
        setSoulStyles(r.items.map((c) => ({ id: c.id, label: c.title })));
        setStyleNames(Object.fromEntries(r.items.map((c) => [c.id, c.title])));
      })
      .catch(() => undefined);
  }, [active, loadCatalog]);

  const loadJobs = useCallback(async () => {
    if (!batchId) return;
    try {
      const r = await toolJobs(batchId, post);
      setJobs(r.jobs);
    } catch (e) {
      console.error("[photo-tools]", (e as Error).message);
    }
  }, [batchId, post]);
  useEffect(() => {
    if (!active) return;
    void loadJobs();
  }, [active, loadJobs]);
  const job = useMemo(() => jobs.find((j) => j.id === jobId) ?? null, [jobs, jobId]);
  const pending = jobs.some((j) => j.status === "queued" || j.status === "running");
  // A pending job is asked about every few seconds until it lands (the server settles it on each ask).
  useEffect(() => {
    if (timer.current) window.clearTimeout(timer.current);
    if (!pending) return;
    timer.current = window.setTimeout(() => {
      void (async () => {
        const before = new Map(jobs.map((j) => [j.id, j.status]));
        await loadJobs();
        setJobs((now) => {
          for (const j of now) {
            const was = before.get(j.id);
            if (was && was !== j.status && j.status === "done") toast.success(`${j.label} done.`);
            if (was && was !== j.status && j.status === "failed") toast.error(j.error || `${j.label} failed.`);
          }
          return now;
        });
      })();
    }, 3000);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [pending, jobs, loadJobs]);

  const tool: ToolDef = useMemo(() => photoTool(toolId) ?? PHOTO_TOOLS[0], [toolId]);
  const tools = useMemo(() => PHOTO_TOOLS.filter((t) => t.provider === provider), [provider]);
  const pickTool = useCallback((id: string) => {
    const t = photoTool(id);
    if (!t) return;
    setProvider(t.provider);
    setToolId(id);
    setOptions({});
    setEstimate(null);
  }, []);
  const pickProvider = useCallback((p: ToolProvider) => {
    setProvider(p);
    const firstTool = PHOTO_TOOLS.find((t) => t.provider === p);
    if (firstTool) setToolId(firstTool.id);
    setOptions({});
    setEstimate(null);
  }, []);
  const setOption = useCallback((id: string, value: string) => {
    setOptions((o) => ({ ...o, [id]: value }));
    setEstimate(null);
  }, []);
  /** A preset card's "Use this …": the tool and its options filled, the panel ready to estimate. */
  const prefill = useCallback((use: PresetUse, card?: PhotoPresetCard) => {
    const t = photoTool(use.tool);
    if (!t) return;
    setProvider(t.provider);
    setToolId(t.id);
    setOptions({ ...use.options });
    setEstimate(null);
    if (card && use.options.styleId) setStyleNames((s) => ({ ...s, [use.options.styleId]: card.title }));
  }, []);

  /** The choices of an option: fixed, or from the catalog's lists. */
  const choicesOf = useCallback(
    (o: ToolOption): ToolChoice[] => {
      if (o.choices) return o.choices;
      if (o.fromCatalog === "soulStyles") return soulStyles;
      if (!catalog) return [];
      return catalog[o.fromCatalog!] ?? [];
    },
    [catalog, soulStyles],
  );

  const providerState = catalog ? catalog[provider] : null;
  const admin = !!catalog?.admin;
  const lockedFor = useCallback((p: ToolProvider) => !!catalog && (!catalog.admin || !catalog[p].enabled), [catalog]);
  const locked = lockedFor(provider);
  const available = providerState ? providerState.available[tool.id] : null;
  const missing = tool.options.filter((o) => o.required && !options[o.id]?.trim()).map((o) => o.label);
  const canAsk = !!batchId && hasPicture && !locked && !!providerState?.connected && missing.length === 0 && !running && !estimating;

  async function getEstimate() {
    if (!batchId) return;
    setEstimating(true);
    try {
      const e = await toolEstimate({ batch: batchId, index: post, tool: tool.id, options });
      setEstimate({ credits: e.credits, balance: e.balance, text: e.text });
    } catch (e) {
      const err = e as ApiError;
      const d = (err.data ?? {}) as ConfirmAsk;
      if (err.status === 409 && d.connected === false) toast.error(err.message);
      else toast.error(err.message);
    } finally {
      setEstimating(false);
    }
  }

  async function runTool(confirm = false): Promise<void> {
    if (!batchId) return;
    setRunning(true);
    try {
      const r = await toolRun({ batch: batchId, index: post, tool: tool.id, options, confirm });
      setJobs((j) => [r.job, ...j.filter((x) => x.id !== r.job.id)]);
      setJobId(r.job.id);
      setEstimate(null);
      if (r.job.status === "done") toast.success(`${r.job.label} done.`);
      else if (r.job.status === "failed") toast.error(r.job.error || `${r.job.label} failed.`);
      else toast.success(`${r.job.label} is on its way; it takes a few seconds to a minute.`);
    } catch (e) {
      const err = e as ApiError;
      const d = (err.data ?? {}) as ConfirmAsk;
      if (err.status === 409 && (d.needsConfirm || d.needsEstimate)) {
        const who = TOOL_PROVIDER_LABELS[tool.provider];
        const ok = await askConfirm(
          d.needsEstimate ? `${tool.label} on post ${post}'s picture: ${who} names no price for it. Run it at an unknown cost from the ${who} credits?` : `${tool.label} on post ${post}'s picture: about ${d.credits} credits from the ${who} balance${d.balance != null ? ` (${d.balance} available)` : ""}. The result is shown first; the post's picture changes only when you use it.`,
          { ok: d.needsEstimate ? "Run it anyway, cost unknown" : `Run · ${d.credits} credits`, danger: false, cancel: "Not now" },
        );
        if (ok) return runTool(true);
        return;
      }
      if (err.status === 504 && d.outcomeUnknown) {
        toast.error(err.message);
        await loadJobs();
        return;
      }
      toast.error(err.message);
    } finally {
      setRunning(false);
    }
  }

  async function applyResult(as: "picture" | "product") {
    if (!job || !batchId) return;
    setUsing(as);
    try {
      const r = await applyToolResult(job.id, { as, batch: batchId, post });
      if (as === "picture" && r.held && r.key) {
        // The client answered this post: the result waits beside their version; the card offers "Send it for review".
        const message = r.message || heldMessage(r.held);
        patchSession(batchId, post, { held: { kind: "picture", reason: r.held, message, key: r.key } });
        toast.message(message, { duration: 9000 });
      } else if (as === "picture") toast.success(`Post ${post}'s picture replaced. The previous one is under Versions.`);
      else toast.success(`Saved as a product photo of the month${r.source ? `: ${r.source.name}` : ""}.`);
      await onChanged?.();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUsing(null);
    }
  }

  /** "Check again" on a job recorded as failed: the provider says whether it finished after all (a status read, free; nothing is run again). */
  async function checkAgain(j: PhotoToolJob) {
    setChecking(j.id);
    try {
      const r = await recheckToolJob(j.id);
      setJobs((all) => all.map((x) => (x.id === r.job.id ? r.job : x)));
      setJobId(r.job.id);
      if (r.outcome === "done") toast.success(r.message);
      else if (r.outcome === "failed") toast.error(r.message);
      else toast.message(r.message);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setChecking(null);
    }
  }

  return {
    catalog,
    catalogError,
    loadingCatalog,
    reloadCatalog: () => loadCatalog(true),
    provider,
    pickProvider,
    providerState,
    admin,
    locked,
    lockedFor,
    tools,
    tool,
    toolId,
    pickTool,
    available,
    options,
    setOption,
    choicesOf,
    styleNames,
    missing,
    canAsk,
    estimate,
    estimating,
    getEstimate,
    running,
    runTool: () => runTool(false),
    jobs,
    job,
    setJob: (j: PhotoToolJob | null) => setJobId(j?.id ?? null),
    reloadJobs: loadJobs,
    pending,
    using,
    applyResult,
    checking,
    checkAgain,
    prefill,
    canUseAsPicture: !!batchId && admin && !!job && job.status === "done" && !!job.output,
  };
}

export type PhotoTools = ReturnType<typeof usePhotoTools>;
