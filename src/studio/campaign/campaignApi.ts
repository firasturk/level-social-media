/** Campaign Autopilot's routes (server/campaign.ts), admin-only. */
import { get, post, put } from "@/api";
import type { ImagePlanItem, VideoPlanItem, BudgetCap, CampaignPlan, CampaignSetup, CostLine, CostUnit, PlanCounts, PlanRef, Price, PriceBook, ProductPick } from "@shared/campaign-plan";
import type { StillRef } from "@shared/campaign-assemble";

export interface CampaignStep {
  step: string;
  item: string;
  shot: string | null;
  kind: "post" | "image" | "frame" | "clip" | "assemble" | "render";
  label: string;
  status: "waiting" | "ready" | "running" | "done" | "failed" | "paused" | "skipped";
  unit: CostUnit | null;
  estimate: number | null;
  spent: number;
  reserved: number;
  attempts: number;
  maxAttempts: number;
  post: number | null;
  ref: { kind: string; id: string } | null;
  output: string | null;
  note: string | null;
  stills?: StillRef[];
  error: string | null;
  stale: boolean;
}

export interface Proposal {
  items: string[];
  retries: number;
  kept: string[];
  counts: PlanCounts;
  costs: { lines: CostLine[]; totals: Partial<Record<CostUnit, { estimate: number; steps: number; unknown: number }>>; unknown: CostLine[] };
  caps: BudgetCap[];
  signature: string;
  stepCount: number;
  unaccepted: { step: string; label: string; unit: CostUnit }[];
}

export interface Campaign {
  id: string;
  batch: string;
  status: "draft" | "approved" | "producing" | "paused" | "done" | "failed" | "discarded";
  simulate: boolean;
  pauseReason: string | null;
  error: string | null;
  setup: CampaignSetup;
  plan: CampaignPlan;
  prices: PriceBook;
  pricesAt: number | null;
  approval: { signature: string; needsApproval: string[]; current: boolean; at: number | null; terms: { items: string[]; retries: number; caps: BudgetCap[] } } | null;
  proposal: Proposal;
  outsideTheCap: string[];
  units: Record<CostUnit, string>;
  ledger: Partial<Record<CostUnit, { approved: number; reserved: number; remaining: number; uncertain: number }>>;
  steps: CampaignStep[];
  created: number;
  updated: number;
}

export interface Sources {
  products: (ProductPick & { listId: string })[];
  media: (PlanRef & { listId: string })[];
  looks: { id: string; name: string }[];
  tracks: { id: string; title: string; artist: string; moods: string[]; bpm: number | null; licence: string }[];
}

export interface Engines {
  billing: "credits" | "cloud";
  images: { kind: "engine"; model: string; name: string }[];
  frames: { kind: "mg-camera"; model: string; name: string }[];
  clips: { provider: "higgsfield-mcp" | "higgsfield"; model: string; name: string }[];
}

const base = "/api/studio/campaigns";
type One = { campaign: Campaign };

export const listCampaigns = (batch: string) => get<{ campaigns: { id: string; status: string; created: number; summary: string; simulate: boolean }[] }>(`${base}?batch=${encodeURIComponent(batch)}`);
export const campaignSources = (batch: string) => get<Sources>(`${base}/sources?batch=${encodeURIComponent(batch)}`);
export const campaignEngines = () => get<Engines>(`${base}/engines`);
export const createCampaign = (batch: string, setup: CampaignSetup) => post<One>(base, { batch, setup });
export function loadCampaign(id: string, opts: { items?: string[]; retries?: number } = {}): Promise<One> {
  const qs = new URLSearchParams();
  if (opts.items) qs.set("items", opts.items.join(","));
  if (opts.retries !== undefined) qs.set("retries", String(opts.retries));
  return get<One>(`${base}/${id}${qs.size ? `?${qs}` : ""}`);
}
export const savePlan = (id: string, plan: CampaignPlan, rev: number) => put<One & { changes: { material: string[]; words: string[]; added: string[]; removed: string[] } }>(`${base}/${id}/plan`, { plan, rev });
export const regenerate = (id: string, rev: number, item: string, shot?: string, note?: string) => post<One>(`${base}/${id}/regenerate`, { rev, item, ...(shot ? { shot } : {}), ...(note ? { note } : {}) });
export const retargetItem = (id: string, item: ImagePlanItem | VideoPlanItem, product: ProductPick | null) => post<{ item: ImagePlanItem | VideoPlanItem; note: string }>(`${base}/${id}/retarget`, { item, product });
export const refreshPrices = (id: string) => post<One & { notes: string[] }>(`${base}/${id}/prices`);
export const approveCampaign = (id: string, body: { items: string[]; retries: number; signature: string; acceptedUnknown: { step: string; unit: CostUnit; amount: number }[] }) => post<One & { already?: boolean }>(`${base}/${id}/approve`, body);
export const tickCampaign = (id: string) => post<One>(`${base}/${id}/tick`);
export const pauseCampaign = (id: string) => post<One>(`${base}/${id}/pause`);
export const resumeCampaign = (id: string) => post<One>(`${base}/${id}/resume`);
export const retryStep = (id: string, step: string, extra = false) => post<One>(`${base}/${id}/steps/${encodeURIComponent(step)}/retry`, { extra });
export const renderedStep = (id: string, step: string, videoId: string) => post<One>(`${base}/${id}/steps/${encodeURIComponent(step)}/rendered`, { videoId });
export const discardCampaign = (id: string) => post<{ ok: true }>(`${base}/${id}/discard`);

export type { Price };
