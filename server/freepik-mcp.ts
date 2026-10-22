/**
 * Magnific MCP adapter: the shared MCP-over-HTTP client (server/mcp-client.ts: JSON-RPC 2.0 over
 * the streamable HTTP transport, initialize, notifications/initialized, tools/list, tools/call)
 * against https://mcp.magnific.com, with the same governance as the API routes: admins only, every call
 * recorded as an op, confirmation before a tool that makes something or costs credits, browsing
 * free. Results that are stock assets land in the same `assets` library as the API's downloads.
 *
 * The server authenticates with OAuth 2.0 (Keycloak at auth.magnific.com/realms/mcp; verified
 * 22 Oct 2026: an unauthenticated POST answers 401 with a Bearer challenge). The studio signs in
 * itself (server/magnific-signin.ts on the shared helper server/oauth-signin.ts: one "Sign in to
 * Magnific" button, nothing pasted) and runs the tools on that sign-in's access token, refreshed
 * when due and once on a 401. A bearer token pasted by hand (`freepik_mcp_token`, the advanced
 * path) is still honoured as a fallback for one release. With neither the adapter answers "Not
 * connected" and a labelled demo tool list; no call leaves the server.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { Env } from "./env";
import { StudioError, errorMessage } from "./errors";
import { getSetting, setSetting, deleteSetting, FREEPIK_MCP_TOKEN_SETTING } from "./settings";
import { assertIntegrationEnabled, claimSubmission, integrationAccess, recordIntegrationOp, requireIntegrationAdmin, updateIntegrationOp } from "./integrations";
import { assetJson, costNotKnown, downloadEstimate, isFlattened, licenseOf, resolveFreepik, storeDownloaded, upsertStockItem, mimeOfName, type AssetJson, type AssetKind, type StockItem } from "./freepik";
import { McpClient, resultText, type McpCallResult, type McpTool } from "./mcp-client";
import { MAGNIFIC_CALLBACK_PATH, MAGNIFIC_MCP_URL, magnificSignIn } from "./magnific-signin";
import type { User } from "@shared/types";

export const MCP_URL = MAGNIFIC_MCP_URL;

/* ───────────── JSON-RPC over streamable HTTP: server/mcp-client.ts, shared with Higgsfield ───────────── */

export { McpClient, MCP_PROTOCOL, parseRpcBody, resultText } from "./mcp-client";
export type { McpCallResult, McpContent, McpTool } from "./mcp-client";
export { MAGNIFIC_CALLBACK_PATH, MAGNIFIC_RESOURCE_METADATA, MAGNIFIC_SCOPES, magnificSignIn } from "./magnific-signin";

/* ───────────── What a tool costs ───────────── */

export type ToolCost = "free" | "download" | "credits";

/** Browsing and account tools are free; a stock download follows the plan; anything that makes something costs credits. */
export function classifyTool(name: string): ToolCost {
  if (name === "stock_download") return "download";
  if (/^(stock_(search|get|show)|account_|simulate_|guides_|creation_status$|project_report$|feed_view_options$|tags_list$)/.test(name)) return "free";
  if (/_(list|show|get|search|state|status|wait|comments_list|share_get|shares_get)$/.test(name)) return "free";
  if (/^(video_cut|video_zoom|images_split_grid|video_metadata|video_extract_frames)$/.test(name)) return "free";
  return "credits";
}

export const COST_LABELS: Record<ToolCost, string> = { free: "Free", download: "Download: in the plan or credits, by plan", credits: "Credits" };

/** The labelled list shown with nothing connected; the live tools/list is the source of truth once connected. */
export const DEMO_TOOLS: (McpTool & { cost: ToolCost; demo: true })[] = [
  { name: "stock_search", description: "Search Freepik stock by keyword or by visual similarity. (demo list)", cost: "free", demo: true },
  { name: "stock_get", description: "Full details of a stock item: preview, size, formats, author. (demo list)", cost: "free", demo: true },
  { name: "stock_download", description: "Download a stock item, optionally saving it to a folder. (demo list)", cost: "download", demo: true },
  { name: "simulate_cost", description: "Estimate the credit cost of a tool before running it. (demo list)", cost: "free", demo: true },
  { name: "account_balance", description: "The credit balance of the Magnific account. (demo list)", cost: "free", demo: true },
  { name: "images_generate", description: "Make a picture from a prompt: costs credits by model and size. (demo list)", cost: "credits", demo: true },
];

export const MCP_NOT_CONNECTED = "Not connected: sign in to Magnific under Connection → Freepik → Magnific MCP (one button; or, the advanced path, paste a bearer token there). No tool runs until then.";

/** A credit figure in a simulate_cost answer ("12 credits", {"credits": 12}, {"cost": 12}). */
export function creditsIn(r: McpCallResult): number | null {
  const sc = r.structuredContent as { credits?: unknown; cost?: unknown; estimated_credits?: unknown } | undefined;
  for (const v of [sc?.credits, sc?.cost, sc?.estimated_credits]) if (typeof v === "number" && Number.isFinite(v)) return v;
  const text = resultText(r);
  try {
    const j = JSON.parse(text) as { credits?: unknown; cost?: unknown; estimated_credits?: unknown; total?: unknown };
    for (const v of [j.credits, j.cost, j.estimated_credits, j.total]) if (typeof v === "number" && Number.isFinite(v)) return v;
  } catch {
    /* plain words */
  }
  const m = /(\d+(?:\.\d+)?)\s*credits?/i.exec(text);
  return m ? Number(m[1]) : null;
}

/* ───────────── Results into the one library ───────────── */

interface Candidate {
  id: string;
  title: string;
  kind: AssetKind;
  preview: string;
  author: string;
  license: string | undefined;
  width: number | null;
  height: number | null;
  url?: string;
  filename?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : typeof v === "number" ? String(v) : undefined;
}

function candidateOf(o: Record<string, unknown>): Candidate | null {
  const id = str(o.id) ?? str(o.resource_id) ?? str(o.resourceId);
  if (!id || !/^\d{1,12}$/.test(id)) return null;
  const preview = str(o.preview) ?? str(o.previewUrl) ?? str(o.preview_url) ?? str(o.thumbnail) ?? str((o.image as Record<string, unknown> | undefined)?.url) ?? str(o.imageUrl) ?? "";
  const url = str(o.url) ?? str(o.downloadUrl) ?? str(o.download_url) ?? str(o.signed_url);
  const type = str(o.type) ?? str(o.content_type) ?? str(o.kind) ?? "photo";
  const kind: AssetKind = type === "vector" || type === "icon" ? "vector" : type === "psd" ? "psd" : type === "design" || type === "template" ? "template" : "photo";
  const lic = str(o.license) ?? (o.premium === true ? "premium" : o.premium === false ? "freemium" : undefined);
  const dims = o.dimensions as Record<string, unknown> | undefined;
  return {
    id,
    title: (str(o.title) ?? str(o.name) ?? `Stock item ${id}`).slice(0, 200),
    kind,
    preview,
    author: str((o.author as Record<string, unknown> | undefined)?.name) ?? str(o.author) ?? "",
    license: lic,
    width: typeof dims?.width === "number" ? dims.width : typeof o.width === "number" ? o.width : null,
    height: typeof dims?.height === "number" ? dims.height : typeof o.height === "number" ? o.height : null,
    url: url && /^https?:\/\//.test(url) && !/freepik\.com\/(premium|free)-/.test(url) ? url : undefined,
    filename: str(o.filename),
  };
}

/** Every object in a tool result that looks like a stock item (an id with a preview, a url or a title). */
export function stockCandidates(r: McpCallResult, args: Record<string, unknown> = {}): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 6 || v === null || typeof v !== "object") return;
    if (Array.isArray(v)) {
      for (const x of v) walk(x, depth + 1);
      return;
    }
    const o = v as Record<string, unknown>;
    const cand = candidateOf(o);
    if (cand && (cand.preview || cand.url || str(o.title) || str(o.name)) && !seen.has(cand.id)) {
      seen.add(cand.id);
      out.push(cand);
    }
    for (const x of Object.values(o)) walk(x, depth + 1);
  };
  if (r.structuredContent) walk(r.structuredContent, 0);
  for (const c of r.content) {
    if (c.type !== "text" || typeof c.text !== "string") continue;
    try {
      walk(JSON.parse(c.text), 0);
    } catch {
      /* prose */
    }
  }
  // A download answer may carry only the url: the id is the argument.
  const argId = str(args.id);
  if (argId && !seen.has(argId)) {
    const text = resultText(r);
    const url = /https?:\/\/\S+/.exec(text)?.[0];
    if (url) out.push({ id: argId, title: `Stock item ${argId}`, kind: str(args.type) === "vector" || str(args.type) === "icon" ? "vector" : str(args.type) === "psd" ? "psd" : "photo", preview: "", author: "", license: undefined, width: null, height: null, url });
  }
  return out;
}

/**
 * Stock items in a tool's answer into the library: a search or a detail becomes a known asset (no
 * file yet); a download's file URL is fetched once into the bucket, on the same row the API would use.
 */
export async function normaliseAssets(env: Env, user: User, tool: string, args: Record<string, unknown>, r: McpCallResult, fetchFn: typeof fetch, client: string | null = null): Promise<AssetJson[]> {
  if (!/^stock_/.test(tool)) return [];
  const out: AssetJson[] = [];
  for (const cand of stockCandidates(r, args)) {
    const item: StockItem = {
      id: cand.id,
      kind: cand.kind,
      title: cand.title,
      author: cand.author,
      license: licenseOf(cand.license),
      preview: cand.preview,
      width: cand.width,
      height: cand.height,
      orientation: cand.width && cand.height ? (cand.width > cand.height ? "landscape" : cand.width < cand.height ? "portrait" : "square") : "unknown",
      flattened: isFlattened(cand.kind),
      formats: [],
      url: "",
      demo: false,
    };
    let row = await upsertStockItem(env, item, user, client);
    if (tool === "stock_download" && cand.url && !row.file_key) {
      try {
        const f = await fetchFn(cand.url, { signal: AbortSignal.timeout(120_000) });
        if (f.ok) {
          const mime = (f.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
          const filename = cand.filename || /\/([^/?#]+)(?:[?#]|$)/.exec(cand.url)?.[1] || `${cand.id}`;
          row = await storeDownloaded(env, row, { bytes: await f.arrayBuffer(), mime: mime === "application/octet-stream" ? mimeOfName(filename) : mime, filename });
        }
      } catch (e) {
        console.error("[freepik-mcp] file not stored", cand.id, errorMessage(e));
      }
    }
    out.push(assetJson(row));
  }
  return out;
}

/* ───────────── The session: the sign-in's token first, the pasted token as the fallback ───────────── */

let fetchForTests: typeof fetch | null = null;
/** Tests inject fetch for the MCP server and the sign-in alike; null restores the real one. */
export function useMcpFetch(fn: typeof fetch | null): void {
  fetchForTests = fn;
  magnificSignIn.useFetch(fn);
}
const fetcher = () => fetchForTests ?? fetch;

export type McpTokenSource = "signin" | "token";

/** Which credential the tools run on: the sign-in while it is usable, else the pasted token, else nothing. */
export async function tokenSource(env: Env): Promise<McpTokenSource | null> {
  if (await magnificSignIn.isSignedIn(env)) return "signin";
  return (await getSetting(env, FREEPIK_MCP_TOKEN_SETTING)) ? "token" : null;
}

/**
 * The MCP server on whichever credential exists. On the sign-in, a 401 refreshes the access token
 * once and repeats the same call once (a token refresh, never a job retry: the server refused the
 * call before running it). A pasted token is not refreshed: its 401 says to sign in instead.
 */
export class MagnificMcp {
  private client: McpClient | null = null;
  private refreshed = false;
  private constructor(
    private readonly env: Env,
    readonly source: McpTokenSource,
    private readonly fetchFn: typeof fetch,
  ) {}

  /** Null when nothing is connected (no call leaves the server). */
  static async open(env: Env, fetchFn: typeof fetch = fetcher()): Promise<MagnificMcp | null> {
    const source = await tokenSource(env);
    return source ? new MagnificMcp(env, source, fetchFn) : null;
  }

  private async connect(force = false): Promise<McpClient> {
    const token = this.source === "signin" ? await magnificSignIn.accessToken(this.env, force) : ((await getSetting(this.env, FREEPIK_MCP_TOKEN_SETTING)) ?? "");
    if (!token) throw new StudioError(MCP_NOT_CONNECTED, 409, false, { connected: false });
    this.client = new McpClient(token, this.fetchFn, MCP_URL, {
      label: "Magnific MCP",
      unauthorizedHint: this.source === "signin" ? "the sign-in may have expired; sign in again under Connection → Freepik → Magnific MCP." : "the pasted token expired: sign in to Magnific under Connection → Freepik → Magnific MCP instead (or paste a fresh token under Advanced).",
    });
    return this.client;
  }

  private async withAuth<T>(fn: (c: McpClient) => Promise<T>): Promise<T> {
    const c = this.client ?? (await this.connect());
    try {
      return await fn(c);
    } catch (e) {
      if (this.source === "signin" && e instanceof StudioError && e.status === 401 && e.data?.httpStatus === 401 && !this.refreshed) {
        this.refreshed = true;
        return fn(await this.connect(true));
      }
      throw e;
    }
  }

  listTools(): Promise<McpTool[]> {
    return this.withAuth((c) => c.listTools());
  }

  callTool(name: string, args: Record<string, unknown>): Promise<McpCallResult> {
    return this.withAuth((c) => c.callTool(name, args));
  }
}

/* ───────────── Routes: /api/studio/freepik/mcp ───────────── */

type Variables = { user: User };
export const freepikMcpRoutes = new Hono<{ Bindings: Env; Variables: Variables }>();

async function gate(c: { get(k: "user"): User; env: Env }): Promise<User> {
  const u = requireIntegrationAdmin(c, "freepik");
  await assertIntegrationEnabled(c.env, "freepik");
  return u;
}

/** Signed in?, the account, until when, whether the sign-in renews itself, whether a pasted token exists too. Every member. */
freepikMcpRoutes.get("/status", async (c) => {
  const user = c.get("user");
  const signin = await magnificSignIn.status(c.env, user);
  const token = !!(await getSetting(c.env, FREEPIK_MCP_TOKEN_SETTING));
  const access = await integrationAccess(c.env, user, "freepik");
  return c.json({
    ...signin,
    token,
    source: signin.signedIn ? "signin" : token ? "token" : null,
    admin: user.role === "admin",
    switch: { enabled: access.enabled },
    access,
    url: MCP_URL,
    callback: MAGNIFIC_CALLBACK_PATH,
  });
});

/**
 * Starts the sign-in (server/oauth-signin.ts): the authorize link for a new tab, or, when the
 * redirect registration is refused, the device flow's user code with what was refused. Admins.
 */
freepikMcpRoutes.post("/signin/start", async (c) => {
  const user = await gate(c);
  const body = (await c.req.json().catch(() => ({}))) as { fresh?: unknown };
  return c.json({ ok: true, ...(await magnificSignIn.start(c.env, user, { fresh: body.fresh === true })) });
});

/** The device flow's poll: one token request per call; the page calls it every `interval` seconds. Admins. */
freepikMcpRoutes.post("/signin/poll", async (c) => {
  const user = await gate(c);
  return c.json({ ok: true, ...(await magnificSignIn.poll(c.env, user)) });
});

/** Where the browser lands after Magnific: the code is exchanged, the tokens kept, back to the studio (`/?magnific=connected|error`). */
freepikMcpRoutes.get("/callback", async (c) => {
  const result = await magnificSignIn.callback(c.env, c.get("user"), c.req.query());
  return c.redirect(magnificSignIn.returnPath(result), 302);
});

/** The sign-in's tokens are dropped (the registered client and any pasted token stay); a ledger row says who. Admins. */
freepikMcpRoutes.post("/signout", async (c) => {
  const user = requireIntegrationAdmin(c, "freepik");
  await magnificSignIn.signOut(c.env, user);
  return c.json({ ok: true });
});

/** The tools, with what each costs; the demo list when nothing is connected. */
freepikMcpRoutes.get("/tools", async (c) => {
  const user = await gate(c);
  const mcp = await MagnificMcp.open(c.env);
  if (!mcp) return c.json({ connected: false, demo: true, reason: MCP_NOT_CONNECTED, url: MCP_URL, source: null, tools: DEMO_TOOLS });
  const tools = await mcp.listTools();
  await recordIntegrationOp(c.env, { provider: "freepik", kind: "mcp:tools/list", user: user.id, estimate: 0, reported: 0, status: "done", note: `${tools.length} tools` });
  return c.json({ connected: true, demo: false, reason: "", url: MCP_URL, source: mcp.source, tools: tools.map((t) => ({ ...t, cost: classifyTool(t.name), demo: false })) });
});

/** The advanced path: a pasted token is kept only after the server accepted it on initialize + tools/list (no credits). */
freepikMcpRoutes.post("/token", async (c) => {
  await gate(c);
  const { token } = await (async () => {
    const parsed = z.object({ token: z.string().trim().min(20).max(8000) }).safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) throw new StudioError("Paste the bearer token first.");
    return parsed.data;
  })();
  const probe = new McpClient(token, fetcher(), MCP_URL);
  const info = await probe.initialize();
  const tools = await probe.listTools();
  await setSetting(c.env, FREEPIK_MCP_TOKEN_SETTING, token);
  return c.json({ ok: true, server: info.serverInfo ?? null, tools: tools.length });
});

freepikMcpRoutes.delete("/token", async (c) => {
  await gate(c);
  await deleteSetting(c.env, FREEPIK_MCP_TOKEN_SETTING);
  return c.json({ ok: true });
});

const callSchema = z.object({
  tool: z.string().regex(/^[a-z0-9_]{2,80}$/),
  arguments: z.record(z.string(), z.unknown()).default({}),
  confirm: z.boolean().optional(),
  client: z.string().max(120).optional(),
  batch: z.string().max(120).optional(),
  post: z.number().int().min(1).optional(),
});

/**
 * One tool call under governance: a browsing tool runs at once (op recorded, estimate 0); a stock
 * download follows the plan's estimate; a generative tool is estimated with simulate_cost and
 * needs `confirm: true`; an unknown cost blocks. Stock items in the answer join the library.
 */
freepikMcpRoutes.post("/call", async (c) => {
  const user = await gate(c);
  const parsed = callSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) throw new StudioError(`Invalid request: ${parsed.error.issues[0]?.path.join(".") || "body"} ${parsed.error.issues[0]?.message ?? "is invalid"}.`);
  const d = parsed.data;
  const mcp = await MagnificMcp.open(c.env);
  if (!mcp) throw new StudioError(MCP_NOT_CONNECTED, 409, false, { connected: false });
  const cost = classifyTool(d.tool);
  const base = { provider: "freepik" as const, kind: `mcp:${d.tool}`, user: user.id, batch: d.batch ?? null, post: d.post ?? null };
  let estimate: number | null = 0;
  if (cost === "download") {
    const fp = await resolveFreepik(c.env, fetcher());
    estimate = downloadEstimate(fp.plan, true);
    if (estimate === null) {
      await recordIntegrationOp(c.env, { ...base, estimate: null, status: "refused", note: "cost not known" });
      throw new StudioError(costNotKnown(fp.plan), 409, false, { blocked: true, plan: fp.plan });
    }
  } else if (cost === "credits") {
    estimate = null;
    try {
      const sim = await mcp.callTool("simulate_cost", { tool: d.tool, arguments: d.arguments });
      estimate = sim.isError ? null : creditsIn(sim);
    } catch (e) {
      console.error("[freepik-mcp] simulate_cost", errorMessage(e));
    }
    if (estimate === null) {
      await recordIntegrationOp(c.env, { ...base, estimate: null, status: "refused", note: "cost not known: simulate_cost gave no figure" });
      throw new StudioError(`Cost not known: Magnific could not estimate ${d.tool}, so it was not run. Every generation draws on the Magnific credit balance.`, 409, false, { blocked: true });
    }
  }
  if (cost !== "free" && d.confirm !== true) {
    const opId = await recordIntegrationOp(c.env, { ...base, estimate, status: "proposed", note: JSON.stringify(d.arguments).slice(0, 300) });
    throw new StudioError(cost === "download" ? (estimate === 0 ? "Confirm the download: in the plan (no credits; counts toward the 100 a day)." : `Confirm the download: about ${estimate} credits.`) : `Confirm ${d.tool}: about ${estimate} credits from the Magnific balance.`, 409, false, { needsConfirm: true, estimate, opId, cost });
  }
  if (cost !== "free" && !(await claimSubmission(c.env, `freepik:mcp:${d.tool}:${JSON.stringify(d.arguments)}`, 120_000))) throw new StudioError("This call is already in progress.", 409);
  const opId = await recordIntegrationOp(c.env, { ...base, estimate, status: cost === "free" ? "done" : "running", note: JSON.stringify(d.arguments).slice(0, 300) });
  try {
    const result = await mcp.callTool(d.tool, d.arguments);
    const assets = await normaliseAssets(c.env, user, d.tool, d.arguments, result, fetcher(), d.client ?? null);
    if (cost !== "free") await updateIntegrationOp(c.env, opId, { status: result.isError ? "failed" : "done", reported: estimate, note: resultText(result).slice(0, 300) });
    return c.json({ ok: !result.isError, tool: d.tool, cost, estimate, opId, source: mcp.source, result, assets });
  } catch (e) {
    if (cost !== "free") await updateIntegrationOp(c.env, opId, { status: "failed", note: errorMessage(e) });
    throw e;
  }
});
