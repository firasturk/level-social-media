import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  ImagePlus,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
  Sparkles,
  Upload,
  Wand2,
  X,
} from "lucide-react";
import { get, post, put } from "@/api";
import LevelLogo from "@/components/LevelLogo";
import { applyTheme, currentTheme } from "@/theme";
import { askInput } from "@/lib/confirm";
import { confetti } from "@/lib/celebrate";
import type { Ambassador, Client, GalleryItem, Source, Theme, User } from "@shared/types";
import type { BriefNote, BriefStep, Config } from "@shared/config";
import {
  FORMATS,
  FORMAT_INFO,
  MAX_POST_COUNT,
  monthLabel,
  POST_TYPE_INFO,
  withoutPaletteText,
  type Format,
  type Post,
} from "@shared/posts";
import { occasionsOf, shortDate, spreadDates } from "@shared/occasions";
import { briefLines } from "@shared/brief";
import { BrandKit, ThemeSection } from "./BrandPanel";
import Ambassadors from "./Ambassadors";
import { displayName } from "./PlanView";
import { KitIcon, type KitKey } from "./kit";

type ThemesReply = { themes: Theme[] };

const STEPS: { key: string; kit?: KitKey; title: string; brief?: BriefStep }[] = [
  { key: "client", title: "Account" },
  { key: "products", kit: "references", title: "Products", brief: "products" },
  { key: "count", kit: "output", title: "Posts", brief: "count" },
  { key: "brand", kit: "brand", title: "Brand kit", brief: "brand" },
  { key: "identity", kit: "identity", title: "Visual identity", brief: "theme" },
  { key: "colours", kit: "colours", title: "Colours", brief: "colours" },
  { key: "scene", kit: "shots", title: "Props and shots", brief: "shots" },
  { key: "ideas", kit: "voice", title: "Ideas and captions" },
  { key: "magic", kit: "theme", title: "Generate" },
];

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
  ensurePlan: () => Promise<string>;
  refresh: () => Promise<void>;
  products: Source[];
  sourceUrl: (id: string) => string;
  onUpload: (files: File[]) => Promise<void>;
  onRemoveProduct: (id: string) => void;
  uploading: boolean;
  postCount: number;
  format: Format;
  onSettings: (patch: { postCount?: number; format?: Format; shots?: string[] }) => void;
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
  onGenerate: () => Promise<void>;
  onDone: () => void;
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
  const [step, setStep] = useState(() => {
    const r = readResume();
    return r && r.client === p.clientId && r.month === p.month ? Math.min(r.step, STEPS.length - 1) : 0;
  });
  const [moving, setMoving] = useState(false);
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
      } catch (e) {
        toast.error((e as Error).message);
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
    count: `${p.postCount}:${p.month}`,
    brand: String(client?.updated ?? ""),
    theme: `${p.themeId}:${theme?.updated ?? ""}:${p.cast.join(",")}`,
    colours: `${JSON.stringify(theme?.palette ?? [])}:${productIds}`,
    shots: `${(p.config?.shots ?? []).join("|")}:${theme?.props ?? ""}`,
  };
  const stepBrief = STEPS[step].brief;
  const sig = stepBrief ? signature[stepBrief] : undefined;
  useEffect(() => {
    if (!stepBrief || !p.batchId || briefBusy) return;
    // The shots are read once they are written for this month's products.
    if (stepBrief === "shots" && (adapting || !p.config?.shots?.length) && theme?.shots.length) return;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepBrief, sig, p.batchId, !!(stepBrief && brief[stepBrief]), adapting]);

  /* ── The pins' shots rewritten for this month's products and colours ── */
  const shotsSig = hash(
    `${p.themeId}|${(theme?.shots ?? []).join("|")}|${productIds}|${JSON.stringify(theme?.palette ?? [])}`,
  );
  const adaptedFor = useRef("");
  const adaptShots = useCallback(
    async (force = false) => {
      if (!p.batchId || !theme?.shots.length) return;
      if (!force && adaptedFor.current === shotsSig) return;
      adaptedFor.current = shotsSig;
      setAdapting(true);
      try {
        await post("/api/studio/posts/shots", { batch: p.batchId, sig: shotsSig });
        await p.refresh();
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setAdapting(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [p.batchId, theme?.shots, shotsSig, p.refresh],
  );
  useEffect(() => {
    if (key !== "scene" || !p.config || reading) return;
    if (p.config.shots?.length && p.config.shotsFor === shotsSig) return;
    void adaptShots();
  }, [key, shotsSig, p.config?.shotsFor, !!p.config?.shots?.length, reading]); // eslint-disable-line react-hooks/exhaustive-deps

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

  async function next() {
    if (key === "client" && !client) {
      toast.error("Pick the account you are working on first.");
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
        <span className="journey-where">
          {client && step > 0 ? `${client.name} · ${monthLabel(p.month)}` : ""}
        </span>
        <button type="button" className="text-button" onClick={p.onDone}>
          Skip to the studio
        </button>
      </header>

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
            </div>
          )}

          {key === "products" && client && (
            <>
              <StepHead kit="references" title="Products for this month">
                Upload new product photos or pick them from {client.name}'s gallery. I read every photo.
              </StepHead>
              <div className="journey-boxes cols-3">
                <ProductsBox {...p} client={client} />
                <GalleryBox client={client} batchId={p.batchId} products={p.products} refresh={p.refresh} />
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
                <CalendarBox month={p.month} plan={p.plan} count={p.postCount} />
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
                Pick the brand ambassadors for this month, then the theme and its Pinterest pins.
              </StepHead>
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
                  ? "These colours come from the pins you chose. Would you like to change the colours? The first one is the background of every post."
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
                Written from your pins, your products and your colours. Edit anything; the ideas and the images follow these.
              </StepHead>
              <div className="journey-boxes cols-3">
                {reading ? (
                  <div className="journey-box">
                    <Reading />
                  </div>
                ) : theme ? (
                  <>
                    <div className="journey-box">
                      <ThemeSection client={client} themes={p.themes} theme={p.themeId} onTheme={p.onTheme} onThemesChanged={p.onThemesChanged} parts={["props"]} bare />
                    </div>
                    <MonthShots
                      shots={p.config?.shots ?? []}
                      busy={adapting}
                      empty={!theme.shots.length}
                      onRewrite={() => void adaptShots(true)}
                      onReadPins={theme.references > 0 ? () => void readReferences(true).then(p.refresh) : undefined}
                      onSave={(shots) => p.onSettings({ shots })}
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
              onGenerate={() => void p.onGenerateIdeas()}
              onSavePlan={p.onSavePlan}
            />
          )}

          {key === "magic" && client && (
            <MagicStep
              client={client}
              month={p.month}
              plan={p.plan}
              format={p.format}
              theme={theme}
              config={p.config}
              onGenerate={async () => {
                confetti();
                await p.onGenerate();
                try {
                  localStorage.removeItem(RESUME_KEY);
                } catch {
                  /* private mode */
                }
                p.onDone();
              }}
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
        <div className="journey-actions">
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
          {!last && (
            <button
              type="button"
              className="primary"
              onClick={() => void next()}
              disabled={moving || reading || (key === "ideas" && !p.plan.length)}
              title={key === "ideas" && !p.plan.length ? "Write the ideas first" : ""}
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
}: {
  client: Client;
  batchId: string | null;
  products: Source[];
  refresh: () => Promise<void>;
}) {
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
          offered.length > 0 && (
            <button type="button" className="text-button" onClick={() => void add(picked.length ? picked : shown.map((g) => g.id))} disabled={adding}>
              {adding ? <LoaderCircle className="spinning" size={13} /> : <Plus size={13} />}
              {picked.length ? `Add ${picked.length}` : `Add all${cat ? ` ${cat}` : ""}`}
            </button>
          )
        }
      >
        {client.name} gallery
      </BoxTitle>
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
  shots,
  busy,
  empty,
  onRewrite,
  onReadPins,
  onSave,
}: {
  shots: string[];
  busy: boolean;
  empty: boolean;
  onRewrite: () => void;
  onReadPins?: () => void;
  onSave: (shots: string[]) => void;
}) {
  const text = shots.join("\n\n");
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  const save = () => {
    if (draft === text) return;
    onSave(
      draft
        .split(/\n\s*\n/)
        .map((x) => x.replace(/^\s*\d+[.)]\s*/, "").trim())
        .filter(Boolean),
    );
  };
  return (
    <div className="journey-box">
      <BoxTitle
        kit="shots"
        actions={
          <>
            {onReadPins && (
              <button type="button" className="text-button" onClick={onReadPins} disabled={busy} title="Read the pins again, then rewrite the shots">
                <RefreshCw size={13} /> Pins
              </button>
            )}
            <button type="button" className="text-button" onClick={onRewrite} disabled={busy || empty} title="Write the shots again for this month's products and colours">
              {busy ? <LoaderCircle className="spinning" size={13} /> : <Wand2 size={13} />} Rewrite
            </button>
          </>
        }
      >
        This month's shots{shots.length ? ` · ${shots.length}` : ""}
      </BoxTitle>
      {busy ? (
        <div className="journey-reading">
          <LoaderCircle className="spinning" size={18} />
          Rewriting the pins' shots for your products and colours…
        </div>
      ) : empty ? (
        <p className="field-hint">Add pins to the theme (Visual identity) and they are read into shots.</p>
      ) : (
        <>
          <textarea className="journey-shots" value={draft} onChange={(e) => setDraft(e.target.value)} onBlur={save} aria-label="This month's shots" />
          <p className="field-hint">
            Each pin's place, camera, light and gesture, with your products in the hands and on the tables, in your colours. Separate shots with an empty line.
          </p>
        </>
      )}
    </div>
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

function CalendarBox({ month, plan, count }: { month: string; plan: Post[]; count: number }) {
  const [y, m] = month.split("-").map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const offset = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 1) % 7; // weeks start on Saturday
  const occasions = occasionsOf(month);
  const planned = plan.length && plan.every((x) => x.date) ? plan.map((x) => x.date!) : spreadDates(month, count);
  const postsOn = (d: string) => planned.filter((x) => x === d).length;
  return (
    <div className="journey-box">
      <BoxTitle kit="direction">{monthLabel(month)}</BoxTitle>
      <div className="journey-cal">
        {["Sat", "Sun", "Mon", "Tue", "Wed", "Thu", "Fri"].map((d) => (
          <small key={d}>{d}</small>
        ))}
        {Array.from({ length: offset }, (_, i) => (
          <span key={`e${i}`} />
        ))}
        {Array.from({ length: days }, (_, i) => {
          const date = `${month}-${String(i + 1).padStart(2, "0")}`;
          const occ = occasions.filter((o) => o.date === date);
          const n = postsOn(date);
          return (
            <span key={date} style={{ "--i": i } as React.CSSProperties} className={`cal-day ${n ? "post" : ""} ${occ.length ? "occasion" : ""}`} title={occ.map((o) => `${o.name} · ${o.ar}`).join("\n")}>
              {i + 1}
              {n > 0 && <i />}
            </span>
          );
        })}
      </div>
      <div className="journey-legend">
        <span>
          <i className="dot post" /> post day
        </span>
        <span>
          <i className="dot occasion" /> occasion
        </span>
      </div>
      {occasions.length > 0 && (
        <ul className="journey-occasions">
          {occasions.map((o) => (
            <li key={o.date + o.name}>
              <strong>{shortDate(o.date)}</strong> {o.name} <span dir="rtl">{o.ar}</span>
            </li>
          ))}
        </ul>
      )}
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
  onGenerate,
  onSavePlan,
}: {
  plan: Post[];
  config: Config | null;
  busy: boolean;
  onGenerate: () => void;
  onSavePlan: (plan: Post[]) => void;
}) {
  // Every post on one screen: up to six across, the rows share the height.
  const n = Math.max(1, plan.length || 4);
  const cols = n <= 4 ? n : n <= 8 ? Math.ceil(n / 2) : 6;
  const rows = Math.ceil(n / cols);
  const grid = {
    gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
    gridTemplateRows: rows <= 3 ? `repeat(${rows}, minmax(0, 1fr))` : undefined,
    gridAutoRows: rows > 3 ? "minmax(240px, 1fr)" : undefined,
  };
  const briefAt = Math.max(0, ...Object.values(config?.brief ?? {}).map((n) => n?.at ?? 0));
  const stale = plan.length > 0 && briefAt > (config?.plannedAt ?? 0);
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
          <h2>Ideas and recommended captions</h2>
          <p>
            {busy
              ? "Writing the month from the whole brief: products, colours, pins, shots and the occasions…"
              : stale
                ? "The brief changed after these ideas were written. Write them again to follow it."
                : "Every post with its day, headline and caption. Edit any caption; it saves when you click out."}
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
              key={`${post.index}:${config?.plannedAt ?? 0}`}
              post={post}
              order={i}
              compact={rows > 1}
              onSave={(next) => onSavePlan(plan.map((x) => (x.index === next.index ? next : x)))}
            />
          ))}
        </div>
      )}
    </>
  );
}

function IdeaCard({ post, order, compact, onSave }: { post: Post; order: number; compact: boolean; onSave: (p: Post) => void }) {
  const [caption, setCaption] = useState(post.caption);
  const [headline, setHeadline] = useState(post.headline ?? "");
  const save = () => {
    if (caption !== post.caption || headline !== (post.headline ?? "")) onSave({ ...post, caption, headline: headline || undefined });
  };
  return (
    <article className={`journey-box idea-card ${compact ? "compact" : ""}`} style={{ "--i": order } as React.CSSProperties}>
      <div className="idea-meta">
        <span className="idea-index">{String(post.index).padStart(2, "0")}</span>
        {post.date && <span className="journey-tag">{shortDate(post.date)}</span>}
        <span className="journey-tag muted">{POST_TYPE_INFO[post.type]?.label ?? post.type}</span>
      </div>
      <strong className="idea-title">{post.title}</strong>
      <input className="idea-headline" dir="auto" value={headline} onChange={(e) => setHeadline(e.target.value)} onBlur={save} aria-label="Headline on the image" />
      <textarea className="idea-caption" dir="auto" value={caption} onChange={(e) => setCaption(e.target.value)} onBlur={save} aria-label="Recommended caption" />
      <small className="idea-tags" dir="auto">
        {post.hashtags}
      </small>
    </article>
  );
}

/* ───────────── Let the magic begin ───────────── */

function MagicStep({
  client,
  month,
  plan,
  format,
  theme,
  config,
  onGenerate,
}: {
  client: Client;
  month: string;
  plan: Post[];
  format: Format;
  theme: Theme | null;
  config: Config | null;
  onGenerate: () => Promise<void>;
}) {
  const [going, setGoing] = useState(false);
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
      <div className="journey-boxes cols-3">
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
      </div>
      <button
        type="button"
        className="primary journey-generate"
        disabled={going || !plan.length}
        onClick={async () => {
          setGoing(true);
          try {
            await onGenerate();
          } finally {
            setGoing(false);
          }
        }}
      >
        {going ? <LoaderCircle className="spinning" size={18} /> : <Sparkles size={18} />}
        Generate {plan.length} posts
      </button>
    </div>
  );
}
