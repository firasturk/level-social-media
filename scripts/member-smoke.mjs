/**
 * A browser smoke test of what a team member (role "member") is shown, in headless Chromium, on
 * the built app (dist/client, from `npm run build`) with the studio's answers mocked. The owner's
 * rule: employees do not need engines, technical settings or prompt engineering; those controls
 * are the admin's and a member does not see them at all.
 *
 * The same walk runs twice over the same month (three planned posts, a theme with two unread
 * pins, one product photo): Start → Direction → Plan → Studio, once signed in as a member and
 * once as an admin. For the member none of the technical controls may exist anywhere on those
 * screens (not in the text, not in a title, not in a hidden attribute), the side panel has no
 * Output section, and the connection entry of the left menu is text, not a button. For the admin
 * every one of them must be there: the test proves the gate, not an accident of the mock.
 * What a member needs to finish a post stays for both: the planner, "Write the ideas again",
 * "Add posts", "Save the plan, make nothing" and the Make button.
 *
 * No Worker, no D1, no provider is involved: any request outside this server fails the run.
 * Screenshots land in --out (default ./test-results/member).
 *
 * Usage:  npm run build && node scripts/member-smoke.mjs [--out dir]
 */
import { createServer } from "node:http";
import { execSync } from "node:child_process";
import { mkdir, readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { deflateSync } from "node:zlib";

async function loadPlaywright() {
  try {
    return await import("playwright");
  } catch {
    const root = execSync("npm root -g", { encoding: "utf8" }).trim();
    return import(pathToFileURL(join(root, "playwright", "index.mjs")).href);
  }
}
const { chromium } = await loadPlaywright();

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : fallback;
};
const outDir = opt("--out", join(process.cwd(), "test-results", "member"));
await mkdir(outDir, { recursive: true });
const executablePath = process.env.PW_CHROMIUM || "/opt/pw-browsers/chromium";
const dist = join(process.cwd(), "dist", "client");

/** A real PNG of one colour with a darker band. */
function png(w, h, rgb = [120, 110, 100]) {
  const table = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (bytes) => {
    let c = 0xffffffff;
    for (const b of bytes) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const out = new Uint8Array(12 + data.length);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    out.set([...type].map((ch) => ch.charCodeAt(0)), 4);
    out.set(data, 8);
    dv.setUint32(8 + data.length, crc(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const iv = new DataView(ihdr.buffer);
  iv.setUint32(0, w);
  iv.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = new Uint8Array(h * (1 + w * 3));
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const band = y > h * 0.4 && y < h * 0.6;
      raw.set(band ? rgb.map((v) => Math.round(v * 0.6)) : rgb, y * (1 + w * 3) + 1 + x * 3);
    }
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return Buffer.from(out);
}
const PICTURE = png(540, 675, [143, 191, 106]);

const NOW = Date.now();
/** Who is signed in for the walk under way: set before each one. */
let ROLE = "member";
const user = () => ({ id: "u1", email: "smoke@example.test", name: ROLE === "admin" ? "Admin Smoke" : "Member Smoke", role: ROLE });
const CLIENT = { id: "c1", slug: "habibah", name: "Habibah", logo: false, badge: false, colors: [{ name: "Pistachio", hex: "#8fbf6a" }, { name: "Cream", hex: "#f4ecd8" }, { name: "Cocoa", hex: "#4a2f22" }], fonts: {}, tone: "Warm and plain.", dos: "", donts: "", style: "", gridRhythm: "", language: "en", status: "active", position: 0, batches: 1, updated: NOW, overlay: null, fontFiles: [], places: [] };
// A theme whose pins were added after it was last read: an admin is offered "Analyse the pins";
// its shots make every post without its own shot a "no shot yet" note ("Write the shots" for an admin).
const THEME = { id: "th1", client: "c1", title: "Winter table", caption: "", description: "Warm winter light.", direction: "Warm winter light on a marble table.", library: "", props: "", wardrobe: "", shots: ["A low side light on marble, the product in the middle."], palette: [], paletteAuto: true, hidden: false, references: 2, updated: NOW, analysed: NOW - 60_000, latestRef: NOW - 1000 };
const post = (i, title) => ({ index: i, type: "lifestyle", title, brief: "The pistachio kunafa on a marble table in warm winter light.", caption: "A caption", hashtags: "#kunafa", product: "pistachio", headline: `Headline ${i}`, date: `2026-12-${String(4 * i).padStart(2, "0")}`, ideaAt: 1 });
const PLAN = [post(1, "Pistachio week"), post(2, "The winter table"), post(3, "A slice to share")];
const config = { mode: "post", input: "model", prompt: "", ratio: "4:5", size: "2K", count: 1, backdrop: "", market: "auto", skill: "editorial", economy: false, output: "jpg", outputQuality: 90, outputSize: "fit", colors: "", modelDescription: "", center: true, client: "c1", month: "2026-12", postCount: 3, format: "4:5", model: "nano-banana-pro", theme: "th1", plan: PLAN, plannedAt: 1 };
const batch = () => ({ id: "b1", name: "Habibah · December 2026", config: JSON.stringify(config), client: "c1", month: "2026-12", theme: "th1", state: "idle", last_error: null, created: NOW, updated: NOW });
const SOURCE = { id: "s1", name: "pistachio.jpg", mime: "image/jpeg", size: 1000, role: "lead", kind: "product", created: NOW };
/** The Plan's reading of the month: three ready pictures, each with what will guide it. */
const PREVIEW = {
  posts: PLAN.map((p) => ({ index: p.index, title: p.title, status: "ready", kind: "picture", paid: true, reference: "theme reference", images: [{ role: "product", key: "k1" }], highestImage: 1, existing: false, guide: [{ id: "product", label: "Product photo", items: [{ text: "pistachio, set in as it is", from: "product photo" }] }] })),
  planned: 3,
  paid: 3,
  blocked: [],
  notes: [],
  issues: [],
  estimate: { model: "nano-banana-pro", size: "2K", perImage: 0.13, total: 0.39, maximum: 0.78, known: true, retakes: 1 },
  spend: { approved: 0, reserved: 0, remaining: 0 },
};

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2", ".json": "application/json", ".ico": "image/x-icon" };

async function startStatic() {
  const server = createServer(async (req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    const path = decodeURIComponent(u.pathname);
    const json = (body) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (path.startsWith("/api/")) {
      if (path === "/api/studio/file" || /^\/api\/studio\/references\/[^/]+\/file$/.test(path)) {
        res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" });
        res.end(PICTURE);
        return;
      }
      const access = { admin: true, enabled: true, reason: "" };
      const MOCK = {
        "/api/auth/me": { user: user(), registrationOpen: false },
        "/api/studio/state": { user: user(), batches: [batch()], trash: [], spend: [], spendThreshold: 20, clients: [CLIENT], engine: { model: "nano-banana-pro", configured: true, source: "stored", openai: "none", google: "stored", fal: "none", review: false, vertex: null }, preview: false, workflowV2: true },
        "/api/studio/batch": { batch: batch(), sources: [SOURCE], tasks: [] },
        "/api/studio/engine/models": { models: [{ slug: "nano-banana-pro", name: "Nano Banana Pro", enabled: true }] },
        "/api/team/bootstrap": { me: { id: "u1", name: user().name, role: ROLE }, users: [], channels: [], unread: 0, tasksOpen: 0, cursor: NOW },
        "/api/team/sync": { cursor: NOW, messages: [], notifications: [], channels: [], unread: 0, tasksOpen: 0 },
        "/api/team/notifications": { notifications: [] },
        "/api/studio/styles/pending": { n: 0 },
        "/api/studio/styles/start-pictures": { brief: [], refs: [], style: null, grid: null },
        "/api/studio/lessons/pending": { n: 0 },
        "/api/studio/posts/themes": { themes: [THEME] },
        "/api/studio/references": { references: [{ id: "r1", name: "Pin one" }, { id: "r2", name: "Pin two" }] },
        "/api/studio/posts/takes": { takes: [] },
        "/api/studio/posts/versions": { versions: [] },
        "/api/studio/posts/drafts": { draft: null },
        "/api/studio/posts/plan-preview": PREVIEW,
        "/api/studio/posts/shots": { ok: true, plan: PLAN },
        "/api/studio/posts/test-grid": { grid: null },
        "/api/studio/posts/removed": { removed: [] },
        "/api/studio/media/clip": { ok: true, clip: null },
        "/api/studio/posts/video/summary": { posts: {} },
        "/api/studio/posts/video/list": { videos: [], engines: [], prices: {}, admin: true, access, billing: "credits" },
        "/api/studio/profiles/c1": { profile: null },
        "/api/studio/profile/c1": { profile: null },
        "/api/studio/memory": { rules: [], lessons: [], notes: [], preferences: [] },
        "/api/studio/photolab/status": { connected: false, provider: "demo", reason: "No key", prices: {}, approximate: true, access },
        "/api/studio/freepik/status": { connected: false, demo: true, reason: "No key", admin: true, access: "admin", plan: "unknown", planLabel: "", downloadEstimate: null, entitlements: {}, mcp: { connected: false, url: "" }, switch: { enabled: true, reason: "" } },
        "/api/studio/ambassadors": { ambassadors: [] },
        "/api/studio/publish/status": { connected: false },
        "/api/studio/publish": { publications: [] },
        "/api/studio/ocr/status": { connected: false, provider: "none", reason: "Not connected" },
      };
      const body = MOCK[path] ?? (path.includes("/list") || path.endsWith("s") ? [] : {});
      json(body);
      return;
    }
    let file = normalize(join(dist, path));
    if (!file.startsWith(dist)) file = join(dist, "index.html");
    try {
      const s = await stat(file);
      if (s.isDirectory()) file = join(file, "index.html");
      await stat(file);
    } catch {
      file = join(dist, "index.html");
    }
    const data = await readFile(file);
    res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
    res.end(data);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

const served = await startStatic();
const url = served.url;
const browser = await chromium.launch({ executablePath, headless: true });
const errors = [];
const outside = [];
const ALLOWED = [url, "data:", "blob:", "https://fonts.googleapis.com/", "https://fonts.gstatic.com/"];
const result = {};

/** The technical controls a member must never be shown, and an admin must. */
const TECHNICAL = ["Format and engine", "Read the scenes before paying", "Write the shots", "Make the test grid", "Exact product", "Analyse the pins"];
/** More of the same, checked the same way: gone for a member, there for an admin. */
const ALSO_TECHNICAL = ["Read again", "Make one test picture", "What will guide this picture", "When inputs meet on one post, this wins", "Client's brand colours", "retake the picture once by itself", "Image engine", "Posts per month"];
/** What a member needs to finish a post: there for both. */
const KEPT = ["Talk to the planner", "Write the ideas again", "Add posts", "Save the plan, make nothing"];

/**
 * One walk through the four stages as `role`. Returns, for each screen, everything the page holds
 * (its whole markup: the visible text, the titles and the other attributes) and what is on show.
 */
async function walk(role) {
  ROLE = role;
  const say = (m) => errors.push(`[${role}] ${m}`);
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.on("pageerror", (e) => say(`page error: ${String(e)}`));
  page.on("console", (m) => m.type() === "error" && !/favicon|404|Failed to load resource/i.test(m.text()) && say(`console error: ${m.text()}`));
  page.on("request", (r) => {
    const u = r.url();
    if (!ALLOWED.some((a) => u.startsWith(a))) outside.push(u);
  });
  await page.addInitScript(() => {
    try {
      localStorage.setItem("lsm-client", "c1");
      localStorage.setItem("lsm-menu", "open");
    } catch {
      /* storage blocked */
    }
  });
  const screens = {};
  /** The screen as it stands: its markup (for "nowhere on the page") and its visible text (for "is shown"). */
  const capture = async (name) => {
    // The workflow's screens scroll inside themselves: one picture of the top, one of the end. The Studio is one long page.
    const step = page.locator(".journey.flow .journey-step");
    if (await step.count()) {
      await step.evaluate((el) => el.scrollTo(0, 0));
      // The screen fades in: the picture is taken once it has.
      await page.waitForTimeout(450);
      await page.screenshot({ path: join(outDir, `${role}-${name}.png`) });
      await step.evaluate((el) => el.scrollTo(0, el.scrollHeight));
      await page.screenshot({ path: join(outDir, `${role}-${name}-end.png`) });
      await step.evaluate((el) => el.scrollTo(0, 0));
    } else await page.screenshot({ path: join(outDir, `${role}-${name}.png`), fullPage: true });
    screens[name] = { html: await page.content(), text: await page.locator("body").innerText() };
  };
  const out = { role, screens, seen: {}, kept: {} };
  try {
    await page.goto(`${url}/?client=c1&month=2026-12`, { waitUntil: "networkidle" });
    const flow = page.locator(".journey.flow");
    await flow.waitFor({ state: "visible", timeout: 20000 });

    // 1 · Start: the month has a plan, shown as the saved plan.
    await flow.locator(".flow-stage", { hasText: "Start" }).first().click();
    await flow.locator(".flow-ways.four").waitFor({ state: "visible", timeout: 20000 });
    await flow.locator(".flow-saved").waitFor({ state: "visible", timeout: 20000 });
    await capture("1-start");
    out.startCards = await flow.locator(".flow-ways.four .flow-way").count();
    out.freshGridShortcut = await flow.getByText(/Fresh grid in/).count();
    out.openInStudioShortcut = await flow.getByText(/Open December 2026 in the Studio/).count();

    // 2 · Direction.
    await flow.getByRole("button", { name: /Continue to Direction/ }).click();
    await flow.getByRole("heading", { name: "Direction" }).waitFor({ state: "visible", timeout: 20000 });
    await flow.getByText(/Theme references · 2/).waitFor({ state: "visible", timeout: 20000 });
    await capture("2-direction");
    out.colourSources = await flow.locator(".flow-colour-sources").count();
    out.colourSwatches = await flow.locator(".flow-colours .flow-swatch").count();
    out.directionBoxes = await flow.locator(".journey-box").count();
    // What a member still does on Direction: products, references, a grid, models.
    out.directionActions = {
      references: await flow.getByRole("button", { name: /^(Manage|Add)$/ }).count(),
      grid: await flow.getByRole("button", { name: "Add a grid" }).count(),
      models: await flow.getByRole("button", { name: /Add a model|Choose models|Change models/ }).count(),
      products: await flow.getByText(/Product images · 1/).count(),
    };

    // 3 · Plan: the month's three posts, one opened on its details.
    await flow.getByRole("button", { name: /Open the plan/ }).click();
    await flow.getByRole("heading", { name: "The plan, before anything is made" }).waitFor({ state: "visible", timeout: 20000 });
    await flow.locator(".flow-confirm", { hasText: "3 pictures" }).waitFor({ state: "visible", timeout: 20000 });
    await flow.getByRole("button", { name: /Details/ }).first().click();
    await flow.locator(".flow-post-details").first().waitFor({ state: "visible", timeout: 10000 });
    await capture("3-plan");
    out.planRows = await flow.locator(".flow-posts > ul > li").count();
    out.makeButton = ((await flow.locator(".flow-confirm .primary").first().innerText().catch(() => "")) ?? "").trim();
    out.makeEnabled = await flow.locator(".flow-confirm .primary").first().isEnabled().catch(() => false);
    out.confirmLine = ((await flow.locator(".flow-confirm-text b").first().innerText().catch(() => "")) ?? "").trim();
    out.retakeCheckbox = await flow.locator(".flow-confirm input[type=checkbox]").count();
    out.testGrid = await flow.locator(".flow-testgrid").count();
    out.attention = ((await flow.locator(".flow-sum-cell.attention").innerText().catch(() => "")) ?? "").replace(/\s+/g, " ").trim();
    for (const k of KEPT) out.kept[k] = screens["3-plan"].text.includes(k);

    // 4 · Studio: the board, its side panel (the brand kit) and the left menu's connection entry.
    await flow.getByRole("button", { name: "Save the plan, make nothing" }).click();
    await page.locator(".journey.flow").waitFor({ state: "detached", timeout: 20000 });
    await page.locator(".brand-panel").waitFor({ state: "visible", timeout: 20000 });
    out.outputSection = await page.locator('.bp-section[data-kit="output"]').count();
    if (out.outputSection) await page.locator('.bp-section[data-kit="output"] .bp-head').click();
    await page.locator(".post-card.compact").first().waitFor({ state: "visible", timeout: 20000 });
    await capture("4-studio");
    out.studioCards = await page.locator(".post-card.compact").count();
    const connection = page.locator(".sidebar-connection").first();
    out.connectionTag = await connection.evaluate((el) => el.tagName.toLowerCase());
    out.connectionRole = await connection.getAttribute("role");
    out.connectionText = ((await connection.innerText()) ?? "").replace(/\s+/g, " ").trim();
    out.connectionButtons = await page.locator("button.sidebar-connection").count();
    // The month tools no longer start a month from a reference grid; the rest of them stays.
    await page.locator(".studio-more-button").click();
    await page.locator(".studio-more .card-menu-list button", { hasText: "Month tools" }).click();
    await page.locator(".plan-toolbar:not(.folded)").waitFor({ state: "visible", timeout: 10000 });
    out.monthTools = (await page.locator(".plan-toolbar .plan-actions button").allInnerTexts()).map((t) => t.trim()).filter(Boolean);
    await page.screenshot({ path: join(outDir, `${role}-5-month-tools.png`), fullPage: true });
  } catch (e) {
    say(`the walk stopped: ${e instanceof Error ? e.message : String(e)}`);
    await page.screenshot({ path: join(outDir, `${role}-failed.png`), fullPage: true }).catch(() => undefined);
  }
  // Where each control was found, by screen: anywhere in the markup, and in the visible text (a
  // heading drawn in capitals reads in capitals, so the visible text is compared without case; so
  // is the markup for the six controls of the brief).
  const has = (hay, needle, anyCase) => (anyCase ? hay.toLowerCase().includes(needle.toLowerCase()) : hay.includes(needle));
  for (const t of [...TECHNICAL, ...ALSO_TECHNICAL]) {
    out.seen[t] = { markup: Object.keys(screens).filter((s) => has(screens[s].html, t, TECHNICAL.includes(t))), shown: Object.keys(screens).filter((s) => has(screens[s].text, t, true)) };
  }
  await context.close();
  return out;
}

const member = await walk("member");
const admin = await walk("admin");

// The gate, both ways: nothing for the member anywhere; everything shown to the admin.
for (const t of [...TECHNICAL, ...ALSO_TECHNICAL]) {
  if (member.seen[t].markup.length) errors.push(`A member is shown "${t}" (on ${member.seen[t].markup.join(", ")}).`);
  if (!admin.seen[t].shown.length) errors.push(`An admin is not shown "${t}" on any of the four screens: the member's check would prove nothing.`);
}
for (const w of [member, admin]) {
  for (const k of KEPT) if (!w.kept[k]) errors.push(`[${w.role}] The Plan lost "${k}".`);
  if (!/^Make/.test(w.makeButton) || !w.makeEnabled) errors.push(`[${w.role}] The Plan's Make button is missing or closed ("${w.makeButton}").`);
  if (w.planRows !== 3) errors.push(`[${w.role}] The Plan shows ${w.planRows} posts, not 3.`);
  if (w.studioCards !== 3) errors.push(`[${w.role}] The Studio shows ${w.studioCards} cards, not 3.`);
  if (w.startCards !== 4) errors.push(`[${w.role}] Start shows ${w.startCards} ways to begin, not 4.`);
  if (w.freshGridShortcut) errors.push(`[${w.role}] Start still offers "Fresh grid in …".`);
  if (!w.openInStudioShortcut) errors.push(`[${w.role}] Start lost "Open December 2026 in the Studio".`);
  if ((w.monthTools ?? []).some((t) => /From reference grid/.test(t))) errors.push(`[${w.role}] The month tools still offer "From reference grid".`);
  if (!(w.monthTools ?? []).some((t) => /Upload products/.test(t)) || !(w.monthTools ?? []).some((t) => /ideas/.test(t))) errors.push(`[${w.role}] The month tools lost a button that should stay (saw: ${(w.monthTools ?? []).join(" | ")}).`);
}
// The member: read-only colours, a full Direction board, no Output section, a connection status that is not a button.
if (member.colourSources) errors.push("A member is shown the colour-source choice on Direction.");
if (member.colourSwatches < 1) errors.push("A member is not shown the month's colours as swatches on Direction.");
if (!member.directionActions?.references || !member.directionActions?.grid || !member.directionActions?.models || !member.directionActions?.products) errors.push(`A member lost a Direction input (references, grid, models, products): ${JSON.stringify(member.directionActions)}`);
if (member.retakeCheckbox) errors.push("A member is shown the automatic-retake checkbox.");
if (member.testGrid) errors.push("A member is shown the test grid.");
if (/Nano Banana|nano-banana|2K/.test(member.confirmLine ?? "")) errors.push(`A member's Plan names the engine or the resolution: "${member.confirmLine}".`);
if (member.outputSection) errors.push("A member is shown the side panel's Output section.");
if (member.connectionTag === "button" || member.connectionButtons) errors.push("The member's connection entry in the left menu is a button.");
if (!/Connected/.test(member.connectionText ?? "")) errors.push(`The member's connection entry does not say the status ("${member.connectionText}").`);
if (/Nano Banana|nano-banana/.test(member.connectionText ?? "")) errors.push(`The member's connection entry names the engine ("${member.connectionText}").`);
// The admin: everything as before.
if (!admin.colourSources) errors.push("An admin is not shown the colour-source choice on Direction.");
if (!admin.retakeCheckbox) errors.push("An admin is not shown the automatic-retake checkbox.");
if (!admin.testGrid) errors.push("An admin is not shown the test grid.");
if (!admin.outputSection) errors.push("An admin is not shown the side panel's Output section.");
if (admin.connectionTag !== "button") errors.push("The admin's connection entry in the left menu is not a button.");

const brief = (w) => ({ ...w, screens: undefined, seen: Object.fromEntries(Object.entries(w.seen).map(([k, v]) => [k, v.shown.join(",") || (v.markup.length ? `markup only: ${v.markup.join(",")}` : "nowhere")])) });
result.member = brief(member);
result.admin = brief(admin);
console.log(JSON.stringify(result, null, 2));
if (outside.length) errors.push(`Network calls outside the test server: ${[...new Set(outside)].join(", ")}`);
await browser.close();
served.server.close();
if (errors.length) {
  console.error("FAILED:\n- " + errors.join("\n- "));
  process.exit(1);
}
console.log(`OK · screenshots in ${outDir}`);
