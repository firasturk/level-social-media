/**
 * The four-stage workflow: Start (one way to begin), Direction (what shapes the pictures), Plan
 * (the plan before anything is paid for), Studio (the month's posts, outside this screen). It
 * replaces the nine-screen journey for admins when the flag is on, over the same month data and
 * the same server routes; nothing here costs money until the plan's own button is pressed.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { ArrowRight, BadgeCheck, Check, ChevronDown, ChevronUp, Grid3x3, ImagePlus, Images, PenLine, Sparkles, TriangleAlert, Wand2 } from "lucide-react";
import LevelLogo from "@/components/LevelLogo";
import { Orb } from "@/components/Orb";
import { post, postForm } from "@/api";
import { rasterize } from "@/lib/image";
import { askConfirm } from "@/lib/confirm";
import type { Client, Source, Task, Theme, User } from "@shared/types";
import type { Config } from "@shared/config";
import { lineageUnknown, monthLabel, olderIdea, planShape, type Format, type Post } from "@shared/posts";
import { blocking, monthIssues, type MonthIssue } from "@shared/issues";
import { formatUsd, rateFor } from "@shared/pricing";
import StyleScreen from "./StyleGallery";
import ReferenceLibrary from "./ReferenceLibrary";

type Way = "brief" | "grid" | "refs" | "style";
type Stage = 0 | 1 | 2;

const WAYS: { key: Way; title: string; desc: string; controls: string; icon: React.ReactNode }[] = [
  { key: "brief", title: "Write a brief", desc: "Your words for one campaign: the idea, the products, the carousel, the colours. Pictures can be pinned to single posts.", controls: "ideas, words, colours, exact references", icon: <PenLine size={18} /> },
  { key: "grid", title: "Follow a grid", desc: "A whole feed from the library: one tile per post, its order, its text tiles and fonts.", controls: "the composition of every post", icon: <Grid3x3 size={18} /> },
  { key: "refs", title: "Use theme references", desc: "Pins or photos that set the month's look: light, colours, props, camera. Never their objects.", controls: "mood, palette, shot list", icon: <Images size={18} /> },
  { key: "style", title: "One post from a style", desc: "One look from the gallery for one post. The style is saved on the post first; making the picture is a separate step you confirm.", controls: "one post's look and idea", icon: <Sparkles size={18} /> },
];

const LEADS: Record<Way, { title: string; text: string; meet: string; add: string[] }> = {
  brief: {
    title: "Your brief leads this month",
    text: "The words, the products on each post, the carousel and the colours come from what you write. A picture pinned to a post is recreated for that post.",
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
  user: User;
  client: Client | null;
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
  size: string;
  postCount: number;
  previousMonth: string | null;
  onContinue: () => Promise<void>;
  ensurePlan: () => Promise<string>;
  refresh: () => Promise<void>;
  onUpload: (files: File[]) => Promise<void>;
  onGrid: (id: string) => void;
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

export default function Flow(p: FlowProps) {
  const [stage, setStage] = useState<Stage>(() => (p.plan.length ? 2 : p.config?.campaign || p.config?.gridRef ? 1 : 0));
  const [way, setWay] = useState<Way>(() => (p.config?.gridRef ? "grid" : p.config?.campaign ? "brief" : "brief"));
  const client = p.client;
  const theme = p.themes.find((t) => t.id === p.themeId) ?? null;
  const shape = planShape(p.plan);
  const perPicture = rateFor(p.model)?.[(p.size as "1K" | "2K" | "4K") ?? "2K"] ?? 0;

  /* ── Start: the brief, the grid, the references, the style ── */
  const [briefText, setBriefText] = useState(() => p.config?.campaign?.text ?? "");
  const [briefFiles, setBriefFiles] = useState<File[]>([]);
  const [planning, setPlanning] = useState(false);
  const [picking, setPicking] = useState<"grid" | "style" | null>(null);
  const [startStyle, setStartStyle] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const briefUnsent = briefText.trim().length >= 20 && briefText.trim() !== (p.config?.campaign?.text ?? "").trim();

  async function planBrief(): Promise<boolean> {
    const id = await p.ensurePlan();
    if (briefText.trim().length < 20) {
      toast.error("Write the brief first: what the posts are about, how many, and the text on each.");
      return false;
    }
    setPlanning(true);
    try {
      const form = new FormData();
      form.set("batch", id);
      form.set("brief", briefText);
      for (const f of briefFiles.slice(0, 12)) {
        const ready = await rasterize(f);
        form.append("file", ready, ready.name);
      }
      form.set("only", "1");
      const r = await postForm<{ added: number; summary: string }>("/api/studio/posts/campaign", form);
      await p.refresh();
      toast.success(`${r.added} post${r.added === 1 ? "" : "s"} planned from your brief.`, { duration: 8000 });
      setBriefFiles([]);
      return true;
    } catch (e) {
      toast.error((e as Error).message, { duration: 10000 });
      return false;
    } finally {
      setPlanning(false);
    }
  }

  async function toDirection() {
    setMoving(true);
    try {
      await p.ensurePlan();
      if (way === "brief" && briefUnsent && !(await planBrief())) return;
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
      if (!p.plan.length) {
        if (way === "brief" && briefUnsent && !(await planBrief())) return;
        else if (way !== "brief" || !p.config?.campaign) {
          const ok = await p.onGenerateIdeas();
          if (!ok) return;
        }
      }
      if (startStyle) {
        await p.onStyles([{ index: p.plan[0]?.index ?? 1, style: startStyle }]);
        setStartStyle(null);
      }
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
  const [open, setOpen] = useState<number | null>(null);
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
        products: p.products.map((s) => s.name.replace(/\.[a-z0-9]+$/i, "")),
        cast: [],
      }),
    [p.config, client, theme, p.products],
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
  const themeNote = p.config?.brief?.theme;

  const lead = LEADS[way];
  const where = client ? `${client.name} · ${monthLabel(p.month)}` : "";

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
        <span className="journey-where">{where}</span>
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
              <div className="flow-ways" role="radiogroup" aria-label="Start with">
                {WAYS.map((w) => (
                  <button key={w.key} type="button" role="radio" aria-checked={way === w.key} className={`flow-way ${way === w.key ? "on" : ""}`} onClick={() => setWay(w.key)}>
                    <span className="flow-way-check" aria-hidden>
                      <Check size={12} />
                    </span>
                    <span className="flow-way-icon">{w.icon}</span>
                    <strong>{w.title}</strong>
                    <span className="flow-way-desc">{w.desc}</span>
                    <span className="flow-way-controls">
                      <b>Controls</b> {w.controls}
                    </span>
                    {w.key === "brief" && <span className="flow-way-rec">Most months start here</span>}
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
                      <textarea rows={6} value={briefText} onChange={(e) => setBriefText(e.target.value)} placeholder="The campaign in your words: what the posts show, how many, the carousel, the colours, the text on each…" />
                      <div className="flow-brief-files">
                        <label className="secondary btn-pill">
                          <ImagePlus size={14} /> {briefFiles.length ? `${briefFiles.length} picture${briefFiles.length === 1 ? "" : "s"} to pin` : "Pin reference pictures"}
                          <input type="file" accept="image/*" multiple hidden onChange={(e) => setBriefFiles([...(e.target.files ?? [])].slice(0, 12))} />
                        </label>
                        <small>Up to 12. Each is recreated on its post and sent to the engine.</small>
                      </div>
                      {p.config?.campaign?.summary && <p className="flow-muted">Last planned: {p.config.campaign.summary}</p>}
                    </div>
                  )}
                  {way === "grid" && (
                    <div className="flow-pick-row">
                      <button type="button" className="secondary btn-pill" onClick={() => setPicking("grid")}>
                        <Grid3x3 size={14} /> {p.config?.gridRef ? "Change the grid" : "Pick a grid from the library"}
                      </button>
                      {p.config?.gridRef && <small>A grid is chosen for this month.</small>}
                    </div>
                  )}
                  {way === "refs" && client && (
                    <div className="flow-refs">
                      {theme ? (
                        <ReferenceLibrary skill={theme.id} title={`Theme "${theme.title}"`} onChanged={() => p.refresh()} empty="No pins or photos yet. Add a few: they set the month's light, colours and props." hint="Pinterest links or photos. Their objects are never copied." />
                      ) : (
                        <p className="flow-muted">Pick or create a theme in the brand kit first; its pins and photos are the references.</p>
                      )}
                    </div>
                  )}
                  {way === "style" && (
                    <div className="flow-pick-row">
                      <button type="button" className="secondary btn-pill" onClick={() => setPicking("style")}>
                        <Sparkles size={14} /> {startStyle ? "Change the style" : "Pick a style for the first post"}
                      </button>
                      {startStyle && <small>Saved on the first post when you continue; its picture is made from the plan.</small>}
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
                  <div className="flow-glance">
                    <div>
                      <span className="flow-eyebrow">Product photos</span>
                      <div className="flow-thumbs">
                        {p.products.slice(0, 6).map((s) => (
                          <img key={s.id} src={p.sourceUrl(s.id)} alt={s.name} />
                        ))}
                        {p.products.length > 6 && <span className="flow-thumb-more">+{p.products.length - 6}</span>}
                      </div>
                      <small>
                        {p.products.length} this month ·{" "}
                        <button type="button" className="text-button" onClick={() => uploadInput.current?.click()}>
                          upload
                        </button>
                      </small>
                    </div>
                    <div>
                      <span className="flow-eyebrow">Plan size</span>
                      <p className="flow-text">{shape || `${p.postCount} posts planned · ${p.format}`}</p>
                    </div>
                    {p.previousMonth && (
                      <div>
                        <span className="flow-eyebrow">Shortcut</span>
                        <button type="button" className="text-button" onClick={() => void p.onContinue()}>
                          Continue from {monthLabel(p.previousMonth)}
                        </button>
                      </div>
                    )}
                  </div>
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
                  <p>What will shape the pictures, in the order it applies. Nothing on this screen spends the picture budget; the AI readings are text calls billed per call by the provider (a few cents each), or answered from demo fixtures when no key is connected.</p>
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
                  <div className="flow-lead">
                    {way === "brief" && <p>{p.config?.campaign?.summary || (briefText.trim() ? briefText.trim().slice(0, 400) : "No brief yet.")}</p>}
                    {way === "grid" && <p>{p.config?.gridRef ? "The month follows the grid you picked, tile by tile." : "No grid picked yet."}</p>}
                    {way === "refs" && <p>{theme ? `Theme "${theme.title}": ${theme.references} reference${theme.references === 1 ? "" : "s"}.` : "No theme yet."}</p>}
                    {way === "style" && <p>{startStyle ? "One style, saved on the first post when the plan is written." : "No style picked yet."}</p>}
                  </div>
                  <span className="flow-eyebrow">Supporting inputs</span>
                  <ul className="flow-inputs">
                    <li>
                      <b>{pinned ? `${pinned} picture${pinned === 1 ? "" : "s"} pinned to posts` : "No pictures pinned to posts"}</b>
                      <span>Each is recreated on its post and sent to the engine; it wins over any grid tile or theme reference there.</span>
                    </li>
                    <li>
                      <b>{theme ? `Theme references · ${theme.references}` : "Theme references · none"}</b>
                      <span>They set the light and palette for every post, never their objects.</span>
                      {theme && (
                        <button type="button" className="text-button" onClick={() => setRefsOpen((o) => !o)}>
                          {refsOpen ? "Hide" : "Manage"}
                        </button>
                      )}
                    </li>
                    {refsOpen && theme && <ReferenceLibrary skill={theme.id} title="" onChanged={() => p.refresh()} />}
                    <li>
                      <b>{p.config?.gridRef ? "Grid · chosen" : "Grid · none"}</b>
                      <span>{p.config?.gridRef ? "The tile takes over each post's composition; the words stay the brief's." : "The brief sets each post's layout. A grid would take over the composition and keep the brief's words."}</span>
                      <button type="button" className="text-button" onClick={() => setPicking("grid")}>
                        {p.config?.gridRef ? "Change" : "Add a grid"}
                      </button>
                    </li>
                    <li>
                      <b>Product photos · {p.products.length}</b>
                      <span>Always used; the real product is matched to each post.</span>
                      <button type="button" className="text-button" onClick={() => uploadInput.current?.click()}>
                        Upload
                      </button>
                    </li>
                  </ul>
                  <details className="flow-details">
                    <summary>How inputs combine when they meet on one post</summary>
                    <div className="flow-precedence">
                      <span className="flow-pill dark">1 Product photo</span>
                      <span className="flow-pill">2 Picture pinned to the post</span>
                      <span className="flow-pill">3 Applied style</span>
                      <span className="flow-pill">4 Grid tile</span>
                      <span className="flow-pill">5 Theme reference</span>
                    </div>
                    <p className="flow-muted">Brand rules and the month's colours apply on top of all of them. {lead.meet}</p>
                  </details>
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
                        {p.model || "the connected engine"} · {perPicture ? `about ${formatUsd(perPicture)} per picture (list price, an estimate)` : "price not known for this engine"}
                      </dd>
                      <dt>Readings</dt>
                      <dd>The ideas, shots, captions and reviews are text and vision calls billed per call by the provider, outside the picture budget. Without a key they are answered from demo fixtures and say so.</dd>
                    </dl>
                  </section>
                  <section className="journey-box flow-box">
                    <span className="flow-eyebrow">What the references say</span>
                    {themeNote ? (
                      <>
                        <p className="flow-text">{themeNote.summary}</p>
                        <ul className="flow-points">
                          {themeNote.points.slice(0, 4).map((x, i) => (
                            <li key={i}>{x}</li>
                          ))}
                        </ul>
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
                  <p>Read it and change anything. Making the pictures is the one step charged to the picture budget; you confirm it below with its estimate.</p>
                </div>
                <button type="button" className="secondary btn-pill journey-head-action" onClick={() => void loadPreview()} disabled={previewBusy}>
                  {previewBusy ? <Orb size={14} /> : <Wand2 size={14} />} Read again
                </button>
              </div>
              <section className="flow-summary">
                <div className="flow-sum-cell">
                  <span className="flow-eyebrow">Objective</span>
                  <p>{p.config?.campaign?.summary || p.config?.notes || theme?.direction?.split(/(?<=\.)\s/)[0] || "The month's posts for the brand."}</p>
                </div>
                <div className="flow-sum-cell">
                  <span className="flow-eyebrow">Products</span>
                  <div className="flow-thumbs small">
                    {p.products.slice(0, 7).map((s) => (
                      <img key={s.id} src={p.sourceUrl(s.id)} alt={s.name} />
                    ))}
                  </div>
                  <small>
                    {p.products.length} with photos{blockedList.length ? `, ${blockedList.length} post${blockedList.length === 1 ? "" : "s"} waiting for one` : ""}
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
                <div className="flow-sum-cell">
                  <span className="flow-eyebrow">Output</span>
                  <p>{shape}</p>
                  <small>
                    {preview ? `${readyPictures} picture${readyPictures === 1 ? "" : "s"} ready to make · ${readyTiles} drawn here, free · ${made} made already · ${blockedList.length} blocked` : "Reading the plan…"}
                  </small>
                </div>
                <div className={`flow-sum-cell attention ${attention.length || blockedList.length ? "on" : ""}`}>
                  <span className="flow-eyebrow">Needs your attention · {attention.length + blockedList.length}</span>
                  <ul>
                    {blockedList.map((b) => (
                      <li key={`b${b.index}`}>
                        Post {b.index}: {b.why}
                      </li>
                    ))}
                    {attention.slice(0, 5).map((x, i) => (
                      <li key={i}>{x.text}</li>
                    ))}
                    {!attention.length && !blockedList.length && <li>Nothing. Every post can be made.</li>}
                  </ul>
                </div>
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
                            {o?.status === "blocked" && <span className="flow-post-flag">{o.why}</span>}
                          </span>
                          <span className="flow-post-product">{x.product || (x.offer?.products[0] ?? "—")}</span>
                          <span className="flow-post-out">
                            <span className={`flow-pill ${state.cls}`}>{state.text || kind}</span>
                            <small>{kind}</small>
                            <label className="flow-date" title="The posting day. Changing it moves the post in the month; its number and its pictures stay.">
                              <input type="date" value={x.date ?? ""} onChange={(e) => void p.onSavePlan(p.plan.map((y) => (y.index === x.index ? { ...y, date: e.target.value || undefined } : y)))} />
                            </label>
                          </span>
                          <button type="button" className="text-button" onClick={() => setOpen(isOpen ? null : x.index)}>
                            {isOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />} {isOpen ? "Hide" : "Details"}
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
                            </div>
                          )}
                        </li>
                      );
                    })}
                </ul>
              </section>
              <footer className="flow-confirm">
                <div className="flow-confirm-text">
                  <b>
                    {readyPictures} picture{readyPictures === 1 ? "" : "s"} · {estimate?.model ?? p.model} · {estimate?.size ?? p.size} · about {formatUsd(estimate?.perImage ?? perPicture)} each
                  </b>
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
                  {ready.find((x) => x.paid) && (
                    <button type="button" className="secondary btn-pill" disabled={!p.engineReady} onClick={() => void p.onTest(ready.find((x) => x.paid)!.index)}>
                      Make one test picture · about {formatUsd(estimate?.perImage ?? perPicture)}
                    </button>
                  )}
                  <button
                    type="button"
                    className="primary btn-pill"
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
                    <BadgeCheck size={14} /> Make {readyPictures} picture{readyPictures === 1 ? "" : "s"} · about {formatUsd(total)}
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
      {picking && client && (
        <StyleScreen
          open
          onClose={() => setPicking(null)}
          admin={p.user.role === "admin"}
          forClient={{ id: client.id, name: client.name }}
          pick={
            picking === "grid"
              ? { mode: "feed", tab: "grid", client: client.id, onPick: (ids) => { p.onGrid(ids[0]); setWay("grid"); setPicking(null); } }
              : { mode: "post", label: "First post", onPick: (ids) => { setStartStyle(ids[0] ?? null); setPicking(null); } }
          }
        />
      )}
    </div>
  );
}
