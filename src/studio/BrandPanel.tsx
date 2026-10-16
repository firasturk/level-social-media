import { useEffect, useState, type ReactNode, useRef } from "react";
import { askConfirm, askInput } from "@/lib/confirm";
import { toast } from "sonner";
import {
  ChevronDown,
  ChevronUp,
  Link as LinkIcon,
  LoaderCircle,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import { del, get, post, put } from "@/api";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import ReferenceLibrary from "./ReferenceLibrary";
import type { Client, EngineModel, Theme } from "@shared/types";
import { FORMATS, FORMAT_INFO, MAX_POST_COUNT, type Format } from "@shared/posts";
import { SIZES, type Size } from "@shared/config";
import {
  HOSTED_FONTS,
  OVERLAY_TEMPLATES,
  resolveOverlay,
  type OverlaySpec,
  type OverlayTemplate,
} from "@shared/overlay";
import { postForm } from "@/api";

export interface OutputSettings {
  model: string;
  format: Format;
  size: Size;
  postCount: number;
}

type ClientsReply = { clients: Client[] };
type ThemesReply = { themes: Theme[]; id?: string };

/** Left column: the client's brand kit, the month's theme and the output settings. */
export default function BrandPanel({
  client,
  onClientsChanged,
  themes,
  theme,
  onTheme,
  onThemesChanged,
  settings,
  models,
  onSettings,
  locked,
}: {
  client: Client;
  onClientsChanged: (clients: Client[]) => void;
  themes: Theme[];
  /** Selected theme id, empty for none. */
  theme: string;
  onTheme: (id: string) => void;
  onThemesChanged: (themes: Theme[]) => void;
  settings: OutputSettings;
  models: EngineModel[];
  onSettings: (patch: Partial<OutputSettings>) => void;
  /** Posts are generating: output settings are frozen. */
  locked: boolean;
}) {
  return (
    <aside className="brand-panel">
      <BrandKit client={client} onClientsChanged={onClientsChanged} />
      <ThemeSection
        client={client}
        themes={themes}
        theme={theme}
        onTheme={onTheme}
        onThemesChanged={onThemesChanged}
      />
      <OverlaySection client={client} onClientsChanged={onClientsChanged} />
      <Section title="Output" subtitle="Engine, size and count" defaultOpen={false}>
        <label className="field-label">Image engine</label>
        <Select
          value={settings.model}
          onValueChange={(model) => onSettings({ model })}
          disabled={locked}
        >
          <SelectTrigger aria-label="Image engine">
            <SelectValue placeholder="Engine" />
          </SelectTrigger>
          <SelectContent>
            {models
              .filter((m) => m.enabled || m.slug === settings.model)
              .map((m) => (
                <SelectItem key={m.slug} value={m.slug}>
                  {m.name}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        <label className="field-label">Post size</label>
        <div className="format-row">
          {FORMATS.map((f) => (
            <button
              key={f}
              type="button"
              className={`format-chip ${settings.format === f ? "active" : ""}`}
              onClick={() => onSettings({ format: f })}
              disabled={locked}
            >
              <span className={`format-shape f-${f.replace(":", "x")}`} />
              <strong>{FORMAT_INFO[f].label}</strong>
              <small>{FORMAT_INFO[f].pixels}</small>
            </button>
          ))}
        </div>
        <div className="field-grid">
          <div>
            <label className="field-label">Resolution</label>
            <Select
              value={settings.size}
              onValueChange={(size) => onSettings({ size: size as Size })}
              disabled={locked}
            >
              <SelectTrigger aria-label="Resolution">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SIZES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="field-label" htmlFor="post-count">
              Posts per month
            </label>
            <input
              id="post-count"
              type="number"
              min={1}
              max={MAX_POST_COUNT}
              value={settings.postCount}
              disabled={locked}
              onChange={(e) =>
                onSettings({
                  postCount: Math.max(1, Math.min(MAX_POST_COUNT, Number(e.target.value) || 1)),
                })
              }
            />
          </div>
        </div>
      </Section>
    </aside>
  );
}

function Section({
  title,
  subtitle,
  defaultOpen = true,
  children,
  actions,
}: {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  children: ReactNode;
  actions?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className={`bp-section ${open ? "open" : ""}`}>
      <button type="button" className="bp-head" onClick={() => setOpen((v) => !v)}>
        <span>
          <strong>{title}</strong>
          {subtitle && <small>{subtitle}</small>}
        </span>
        {open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
      </button>
      {open && (
        <div className="bp-body">
          {actions}
          {children}
        </div>
      )}
    </section>
  );
}

/* ───────────── Brand kit ───────────── */

interface KitDraft {
  colors: { name: string; hex: string }[];
  fonts: { headline: string; body: string };
  tone: string;
  language: Client["language"];
  dos: string;
  donts: string;
  style: string;
}

function draftOf(c: Client): KitDraft {
  return {
    colors: c.colors.map((x) => ({ name: x.name, hex: x.hex })),
    fonts: { headline: c.fonts.headline ?? "", body: c.fonts.body ?? "" },
    tone: c.tone,
    language: c.language,
    dos: c.dos,
    donts: c.donts,
    style: c.style,
  };
}

const DEFAULT_COLORS = [
  { name: "Primary", hex: "#1a1a1a" },
  { name: "Secondary", hex: "#f2f2f2" },
  { name: "Accent", hex: "#c8a24a" },
];

function BrandKit({
  client,
  onClientsChanged,
}: {
  client: Client;
  onClientsChanged: (clients: Client[]) => void;
}) {
  const [draft, setDraft] = useState<KitDraft>(() => draftOf(client));
  const [saving, setSaving] = useState(false);
  const [analysing, setAnalysing] = useState(false);
  useEffect(() => setDraft(draftOf(client)), [client]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(client));
  // Read inside blur handlers, which close over an older render.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  /** Saves the kit; the fields also save themselves when you click out of them (silent). */
  async function save(silent = false) {
    if (silent && !dirtyRef.current) return;
    setSaving(true);
    try {
      const r = await put<ClientsReply>(`/api/studio/clients/${client.id}`, {
        colors: draft.colors.filter((c) => /^#[0-9a-fA-F]{6}$/.test(c.hex)),
        fonts: draft.fonts,
        tone: draft.tone,
        language: draft.language,
        dos: draft.dos,
        donts: draft.donts,
        style: draft.style,
      });
      onClientsChanged(r.clients);
      if (!silent) toast.success("Brand kit saved.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function analyse() {
    setAnalysing(true);
    try {
      const r = await post<{ style: string }>("/api/studio/posts/analyze-identity", {
        client: client.id,
      });
      setDraft((d) => ({ ...d, style: r.style }));
      toast.success("Identity read from the past posts. Review the text and save.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAnalysing(false);
    }
  }

  const setColor = (i: number, patch: Partial<{ name: string; hex: string }>) =>
    setDraft((d) => ({
      ...d,
      colors: d.colors.map((c, j) => (j === i ? { ...c, ...patch } : c)),
    }));

  return (
    <Section
      title="Brand kit"
      subtitle={`${client.name}: colours, fonts, tone`}
      actions={
        dirty ? (
          <div className="bp-save">
            <button className="primary" onClick={() => void save()} disabled={saving}>
              {saving ? <LoaderCircle className="spinning" size={15} /> : null} Save brand kit
            </button>
            <button className="text-button" onClick={() => setDraft(draftOf(client))}>
              Discard
            </button>
          </div>
        ) : null
      }
    >
      <div className="field-row">
        <label className="field-label">Colours</label>
        <button
          type="button"
          className="text-button"
          onClick={() =>
            setDraft((d) => ({
              ...d,
              colors: [
                ...d.colors,
                DEFAULT_COLORS[d.colors.length] ?? { name: `Colour ${d.colors.length + 1}`, hex: "#888888" },
              ],
            }))
          }
        >
          <Plus size={13} /> Add
        </button>
      </div>
      {draft.colors.length ? (
        <div className="color-list">
          {draft.colors.map((c, i) => (
            <div className="color-row" key={i}>
              <input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(c.hex) ? c.hex : "#888888"}
                onChange={(e) => setColor(i, { hex: e.target.value })}
                aria-label={`${c.name || "Colour"} value`}
              />
              <input
                className="color-hex"
                value={c.hex}
                onChange={(e) => setColor(i, { hex: e.target.value.trim() })}
                placeholder="#000000"
                aria-label="Hex"
              />
              <input
                className="color-name"
                value={c.name}
                onChange={(e) => setColor(i, { name: e.target.value })}
                placeholder="Name (Primary, Accent…)"
                aria-label="Colour name"
              />
              <button
                type="button"
                className="icon-button"
                aria-label="Remove colour"
                onClick={() =>
                  setDraft((d) => ({ ...d, colors: d.colors.filter((_, j) => j !== i) }))
                }
              >
                <Trash2 size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <div className="prompt-tip">
          No colours yet. Add the brand palette: every post's scene, props and light stay inside it.
        </div>
      )}
      <div className="field-grid">
        <div>
          <label className="field-label" htmlFor="font-headline">
            Headline font
          </label>
          <input
            id="font-headline"
            value={draft.fonts.headline}
            placeholder="e.g. Montserrat"
            onChange={(e) =>
              setDraft((d) => ({ ...d, fonts: { ...d.fonts, headline: e.target.value } }))
            }
          />
        </div>
        <div>
          <label className="field-label" htmlFor="font-body">
            Body font
          </label>
          <input
            id="font-body"
            value={draft.fonts.body}
            placeholder="e.g. Inter"
            onChange={(e) =>
              setDraft((d) => ({ ...d, fonts: { ...d.fonts, body: e.target.value } }))
            }
          />
        </div>
      </div>
      <label className="field-label" htmlFor="tone">
        Tone of voice
      </label>
      <textarea
        id="tone"
        rows={2}
        value={draft.tone}
        placeholder="warm, family, Arabic first, no slang…"
        onChange={(e) => setDraft((d) => ({ ...d, tone: e.target.value }))}
        onBlur={() => void save(true)}
      />
      <label className="field-label">Caption language</label>
      <Select
        value={draft.language}
        onValueChange={(language) =>
          setDraft((d) => ({ ...d, language: language as Client["language"] }))
        }
      >
        <SelectTrigger aria-label="Caption language">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="ar">Arabic</SelectItem>
          <SelectItem value="en">English</SelectItem>
          <SelectItem value="both">Arabic and English</SelectItem>
        </SelectContent>
      </Select>
      <div className="field-grid">
        <div>
          <label className="field-label" htmlFor="dos">
            Always
          </label>
          <textarea
            id="dos"
            rows={3}
            value={draft.dos}
            placeholder="one rule per line"
            onChange={(e) => setDraft((d) => ({ ...d, dos: e.target.value }))}
        onBlur={() => void save(true)}
          />
        </div>
        <div>
          <label className="field-label" htmlFor="donts">
            Never
          </label>
          <textarea
            id="donts"
            rows={3}
            value={draft.donts}
            placeholder="one rule per line"
            onChange={(e) => setDraft((d) => ({ ...d, donts: e.target.value }))}
        onBlur={() => void save(true)}
          />
        </div>
      </div>
      <ReferenceLibrary
        skill={`idn-${client.id}`.slice(0, 40)}
        title="Past posts (identity)"
        empty="Add a few of the client's past posts or campaign images, then press Analyse identity: the style text below is written from them."
        hint="Used only to describe the client's visual identity; never copied into a post."
        actions={
          <button
            type="button"
            className="text-button"
            onClick={() => void analyse()}
            disabled={analysing}
          >
            {analysing ? (
              <LoaderCircle className="spinning" size={13} />
            ) : (
              <Sparkles size={13} />
            )}
            Analyse identity
          </button>
        }
      />
      <label className="field-label" htmlFor="style">
        Visual identity (style text)
      </label>
      <textarea
        id="style"
        rows={5}
        value={draft.style}
        placeholder="Photography style, light, palette, composition, props, how products are shown…"
        onChange={(e) => setDraft((d) => ({ ...d, style: e.target.value }))}
        onBlur={() => void save(true)}
      />
    </Section>
  );
}

/* ───────────── Theme ───────────── */

function ThemeSection({
  client,
  themes,
  theme,
  onTheme,
  onThemesChanged,
}: {
  client: Client;
  themes: Theme[];
  theme: string;
  onTheme: (id: string) => void;
  onThemesChanged: (themes: Theme[]) => void;
}) {
  const current = themes.find((t) => t.id === theme) ?? null;
  const [direction, setDirection] = useState(current?.direction ?? "");
  const [props, setProps] = useState(current?.props ?? "");
  useEffect(() => setProps(current?.props ?? ""), [current?.id, current?.props]);
  const shotsText = (current?.shots ?? []).join("\n\n");
  const [shots, setShots] = useState(shotsText);
  useEffect(() => setShots(shotsText), [current?.id, shotsText]);
  const [busy, setBusy] = useState<"" | "analyse" | "import" | "create">("");
  const [pins, setPins] = useState("");
  const [showPins, setShowPins] = useState(false);
  const [libKey, setLibKey] = useState(0);
  useEffect(() => setDirection(current?.direction ?? ""), [current?.id, current?.direction]);

  async function create() {
    const title = await askInput("Theme name", "", {
      ok: "Create",
      placeholder: "Ramadan 2027, Summer sale, Minimal white…",
    });
    if (!title?.trim()) return;
    setBusy("create");
    try {
      const r = await post<ThemesReply>("/api/studio/posts/themes", {
        client: client.id,
        title: title.trim(),
      });
      onThemesChanged(r.themes);
      if (r.id) onTheme(r.id);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function saveDirection() {
    if (!current || direction === current.direction) return;
    try {
      const r = await put<ThemesReply>(`/api/studio/posts/themes/${current.id}`, { direction });
      onThemesChanged(r.themes);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function saveShots() {
    if (!current || shots === shotsText) return;
    try {
      const list = shots
        .split(/\n\s*\n/)
        .map((x) => x.replace(/^\s*\d+[.)]\s*/, "").trim())
        .filter(Boolean);
      const r = await put<ThemesReply>(`/api/studio/posts/themes/${current.id}`, { shots: list });
      onThemesChanged(r.themes);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function saveProps() {
    if (!current || props === (current.props ?? "")) return;
    try {
      const r = await put<ThemesReply>(`/api/studio/posts/themes/${current.id}`, { props });
      onThemesChanged(r.themes);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function rename() {
    if (!current) return;
    const title = await askInput("Theme name", current.title, { ok: "Rename" });
    if (!title?.trim() || title.trim() === current.title) return;
    try {
      const r = await put<ThemesReply>(`/api/studio/posts/themes/${current.id}`, {
        title: title.trim(),
      });
      onThemesChanged(r.themes);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function removeTheme() {
    if (!current || !(await askConfirm(`Delete the theme "${current.title}"?`, { ok: "Delete" }))) return;
    try {
      const r = await del<ThemesReply>(`/api/studio/posts/themes/${current.id}`);
      onThemesChanged(r.themes);
      onTheme(r.themes[0]?.id ?? "");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function analyse(silent = false) {
    if (!current) return;
    setBusy("analyse");
    try {
      const r = await post<ThemesReply>(`/api/studio/posts/themes/${current.id}/analyze`);
      onThemesChanged(r.themes);
      toast.success(silent ? "Theme direction updated from the references." : "Theme written from its references.");
    } catch (e) {
      if (!silent) toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  async function reloadThemes() {
    try {
      const r = await get<ThemesReply>(`/api/studio/posts/themes?client=${encodeURIComponent(client.id)}`);
      onThemesChanged(r.themes);
    } catch {
      /* keep the list */
    }
  }

  async function importPins() {
    if (!current) return;
    const urls = pins
      .split(/\s+/)
      .map((u) => u.trim())
      .filter((u) => /^https?:\/\//.test(u))
      .slice(0, 30);
    if (!urls.length) {
      toast.error("Paste one or more Pinterest pin links first.");
      return;
    }
    setBusy("import");
    try {
      const r = await post<{ added: string[]; failed: string[]; analysed?: boolean }>(
        "/api/studio/posts/import-references",
        { skill: current.id, urls },
      );
      setLibKey((k) => k + 1);
      if (r.analysed) {
        await reloadThemes();
        toast.success("Theme direction written from the imported references.");
      }
      if (r.added.length) toast.success(`${r.added.length} reference${r.added.length > 1 ? "s" : ""} imported.`);
      if (r.failed.length)
        toast.warning(
          `${r.failed.length} link${r.failed.length > 1 ? "s" : ""} could not be read. Save those images and add them with "Add photos".`,
        );
      setPins(r.failed.join("\n"));
      if (!r.failed.length) setShowPins(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  return (
    <Section title="Theme" subtitle={current ? current.title : "Pick or create a theme"}>
      <div className="field-row">
        <label className="field-label">Theme of the month</label>
        <button type="button" className="text-button" onClick={() => void create()} disabled={!!busy}>
          <Plus size={13} /> New theme
        </button>
      </div>
      {themes.length ? (
        <Select value={theme || "none"} onValueChange={(v) => onTheme(v === "none" ? "" : v)}>
          <SelectTrigger aria-label="Theme">
            <SelectValue placeholder="Theme" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">No theme (brand identity only)</SelectItem>
            {themes.map((t) => (
              <SelectItem key={t.id} value={t.id}>
                {t.title}
                {t.references ? ` · ${t.references} refs` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <div className="prompt-tip">
          No themes yet. A theme is a visual direction for a month (Ramadan, Summer sale, Minimal
          white) with its own reference images, from your files or from Pinterest.
        </div>
      )}
      {current && (
        <>
          <div className="theme-tools">
            <button type="button" className="text-button" onClick={() => void rename()}>
              Rename
            </button>
            <button type="button" className="text-button danger" onClick={() => void removeTheme()}>
              <Trash2 size={13} /> Delete
            </button>
          </div>
          <ReferenceLibrary
            key={`${current.id}:${libKey}`}
            skill={current.id}
            onChanged={(count) => (count > 0 ? void analyse(true) : reloadThemes())}
            title="References"
            empty="No references yet. Add images from your files, or paste Pinterest pin links. Every post borrows place, light, palette and mood from one of them."
            hint="Every post borrows place, light, palette and mood from one of them, rotating so posts differ; their objects, people and text are never copied."
            actions={
              <>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => setShowPins((v) => !v)}
                  disabled={busy === "import"}
                >
                  <LinkIcon size={13} /> Pinterest
                </button>
                <button
                  type="button"
                  className="text-button"
                  onClick={() => void analyse()}
                  disabled={!!busy || !current.references}
                  title={current.references ? "" : "Add references first"}
                >
                  {busy === "analyse" ? (
                    <LoaderCircle className="spinning" size={13} />
                  ) : (
                    <Sparkles size={13} />
                  )}
                  Analyse
                </button>
              </>
            }
          />
          {showPins && (
            <div className="pins-box">
              <textarea
                rows={3}
                value={pins}
                placeholder={"Paste Pinterest pin links, one per line:\nhttps://www.pinterest.com/pin/…"}
                onChange={(e) => setPins(e.target.value)}
              />
              <button className="secondary" onClick={() => void importPins()} disabled={busy === "import"}>
                {busy === "import" ? <LoaderCircle className="spinning" size={15} /> : <LinkIcon size={15} />}
                Import pins
              </button>
            </div>
          )}
          <label className="field-label" htmlFor="direction">
            Direction
          </label>
          <textarea
            id="direction"
            rows={4}
            value={direction}
            placeholder="What this month's posts should feel like: places, light, palette, mood. Press Analyse to write it from the references."
            onChange={(e) => setDirection(e.target.value)}
            onBlur={() => void saveDirection()}
          />
          <label className="field-label" htmlFor="theme-props">
            Props
          </label>
          <textarea
            id="theme-props"
            rows={2}
            value={props}
            placeholder="Objects to add to the scenes this month: autumn leaves, pumpkins, a knit scarf, fairy lights…"
            onChange={(e) => setProps(e.target.value)}
            onBlur={() => void saveProps()}
          />
          <p className="field-hint">The ideas and every image prompt ask for these props, placed naturally around the product.</p>
          <label className="field-label" htmlFor="theme-shots">
            Shots from the references{current.shots?.length ? ` · ${current.shots.length}` : ""}
          </label>
          <textarea
            id="theme-shots"
            rows={current.shots?.length ? 8 : 2}
            value={shots}
            placeholder="Press Analyse: one ready shot is written per reference picture (every tile of a collage counts). Edit freely; separate shots with an empty line."
            onChange={(e) => setShots(e.target.value)}
            onBlur={() => void saveShots()}
          />
          <p className="field-hint">
            The month is planned over these shots: fewer posts than shots picks the most varied ones, more posts reuses shots with other products. Each post follows its shot in the image prompt.
          </p>
          {current.library && (
            <details className="theme-library">
              <summary>Visual language (from the references)</summary>
              <pre>{current.library}</pre>
            </details>
          )}
        </>
      )}
    </Section>
  );
}

/* ───────────── Overlay: headline and logo placement ───────────── */

const TEMPLATE_LABEL: Record<OverlayTemplate, string> = {
  united: "Photo post · logo top, headline bottom (United)",
  abusaleh: "Logo top, playful headline under it (Abu Saleh)",
  habibah: "Centred logo, headline bottom, gold sub-line (Habibah)",
  clean: "Clean · logo corner, headline bottom-left",
  none: "No overlay (image only)",
};

/** Pixel on a 1080-wide canvas <-> fraction of the width stored in the spec. */
const px = (f: number) => Math.round(f * 1080);
const frac = (p: number) => Math.max(0, Number(p) || 0) / 1080;

function OverlaySection({
  client,
  onClientsChanged,
}: {
  client: Client;
  onClientsChanged: (clients: Client[]) => void;
}) {
  const [spec, setSpec] = useState<OverlaySpec>(() => resolveOverlay(client.overlay));
  const [saving, setSaving] = useState(false);
  const [fontBusy, setFontBusy] = useState(false);
  useEffect(() => setSpec(resolveOverlay(client.overlay)), [client]);
  const dirty = JSON.stringify(spec) !== JSON.stringify(resolveOverlay(client.overlay));
  const fontNames = [...new Set([...client.fontFiles.map((f) => f.name), ...HOSTED_FONTS])];

  const patchHeadline = (p: Partial<OverlaySpec["headline"]>) =>
    setSpec((o) => ({ ...o, headline: { ...o.headline, ...p } }));
  const patchSubline = (p: Partial<OverlaySpec["subline"]>) =>
    setSpec((o) => ({ ...o, subline: { ...o.subline, ...p } }));
  const patchLogo = (p: Partial<OverlaySpec["logo"]>) =>
    setSpec((o) => ({ ...o, logo: { ...o.logo, ...p } }));
  const patchBadge = (p: Partial<OverlaySpec["badge"]>) =>
    setSpec((o) => ({ ...o, badge: { ...o.badge, ...p } }));
  const [badgeBusy, setBadgeBusy] = useState(false);

  /** The corner logo file (a parent or partner mark); placement and colour live in the spec. */
  async function uploadBadge(file: File | undefined) {
    if (!file) return;
    setBadgeBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const r = await postForm<ClientsReply>(`/api/studio/clients/${client.id}/badge`, form);
      onClientsChanged(r.clients);
      if (spec.badge.position === "none") patchBadge({ position: "bottom-left" });
      toast.success("Corner logo added. Save the overlay to keep its placement.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBadgeBusy(false);
    }
  }

  async function removeBadge() {
    if (!(await askConfirm("Remove the corner logo from every post?"))) return;
    try {
      const r = await del<ClientsReply>(`/api/studio/clients/${client.id}/badge`);
      onClientsChanged(r.clients);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function save() {
    setSaving(true);
    try {
      const r = await put<ClientsReply>(`/api/studio/clients/${client.id}`, { overlay: spec });
      onClientsChanged(r.clients);
      toast.success("Overlay saved.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function uploadFont(file: File | undefined) {
    if (!file) return;
    const name = await askInput(
      "Font family name (as written in the overlay)",
      file.name.replace(/\.[^.]+$/, "").replace(/[-_]?(regular|bold|semibold|medium)$/i, ""),
      { ok: "Add font" },
    );
    if (!name?.trim()) return;
    setFontBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("name", name.trim());
      const r = await postForm<ClientsReply>(`/api/studio/clients/${client.id}/fonts`, form);
      onClientsChanged(r.clients);
      toast.success(`Font "${name.trim()}" added.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setFontBusy(false);
    }
  }

  async function removeFont(id: string, name: string) {
    if (!(await askConfirm(`Remove the font "${name}"?`))) return;
    try {
      const r = await del<ClientsReply>(`/api/studio/clients/${client.id}/fonts/${id}`);
      onClientsChanged(r.clients);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  const fontField = (value: string, onChange: (v: string) => void, label: string) => (
    <>
      <input
        list={`fonts-${client.id}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={label}
        placeholder="Font family"
      />
    </>
  );

  return (
    <Section
      title="Overlay"
      subtitle="Headline, sub-line and logo drawn over each post"
      defaultOpen={false}
      actions={
        dirty ? (
          <div className="bp-save">
            <button className="primary" onClick={() => void save()} disabled={saving}>
              {saving ? <LoaderCircle className="spinning" size={15} /> : null} Save overlay
            </button>
            <button className="text-button" onClick={() => setSpec(resolveOverlay(client.overlay))}>
              Discard
            </button>
          </div>
        ) : null
      }
    >
      <datalist id={`fonts-${client.id}`}>
        {fontNames.map((f) => (
          <option key={f} value={f} />
        ))}
      </datalist>
      <label className="field-label">Layout</label>
      <Select
        value={spec.template}
        onValueChange={(t) =>
          setSpec(t === "none" ? { ...resolveOverlay({ template: "none" }) } : { ...OVERLAY_TEMPLATES[t as Exclude<OverlayTemplate, "none">] })
        }
      >
        <SelectTrigger aria-label="Overlay layout">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(TEMPLATE_LABEL) as OverlayTemplate[]).map((t) => (
            <SelectItem key={t} value={t}>
              {TEMPLATE_LABEL[t]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {spec.template !== "none" && (
        <>
          <div className="field-row">
            <label className="field-label">Brand fonts</label>
            <label className="text-button">
              {fontBusy ? <LoaderCircle className="spinning" size={13} /> : <Plus size={13} />} Add font file
              <input type="file" accept=".ttf,.otf,.woff,.woff2" hidden onChange={(e) => void uploadFont(e.target.files?.[0])} />
            </label>
          </div>
          {client.fontFiles.length ? (
            <div className="font-list">
              {client.fontFiles.map((f) => (
                <span key={f.id} className="font-chip" style={{ fontFamily: `"${f.name}", Tajawal, sans-serif` }}>
                  {f.name}
                  <button type="button" className="icon-button" aria-label={`Remove ${f.name}`} onClick={() => void removeFont(f.id, f.name)}>
                    <Trash2 size={12} />
                  </button>
                </span>
              ))}
            </div>
          ) : (
            <div className="prompt-tip">
              No font files yet. Hosted fonts work without a file: {HOSTED_FONTS.join(", ")}. Upload a .ttf or .woff2 for any other family.
            </div>
          )}
          <label className="field-label">Logo</label>
          <div className="field-grid three">
            <Select value={spec.logo.position} onValueChange={(v) => patchLogo({ position: v as OverlaySpec["logo"]["position"] })}>
              <SelectTrigger aria-label="Logo position"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="top-center">Top centre</SelectItem>
                <SelectItem value="top-left">Top left</SelectItem>
                <SelectItem value="top-right">Top right</SelectItem>
                <SelectItem value="bottom-center">Bottom centre</SelectItem>
                <SelectItem value="none">No logo</SelectItem>
              </SelectContent>
            </Select>
            <label className="num"><span>Width</span><input type="number" value={px(spec.logo.width)} onChange={(e) => patchLogo({ width: frac(Number(e.target.value)) })} /></label>
            <label className="num"><span>From edge</span><input type="number" value={px(spec.logo.top)} onChange={(e) => patchLogo({ top: frac(Number(e.target.value)) })} /></label>
          </div>
          <div className="field-row">
            <label className="field-label">Corner logo</label>
            <label className="text-button">
              {badgeBusy ? <LoaderCircle className="spinning" size={13} /> : <Plus size={13} />}
              {client.badge ? "Replace" : "Add file"}
              <input
                type="file"
                accept="image/png,image/svg+xml,image/webp,image/jpeg"
                hidden
                onChange={(e) => {
                  void uploadBadge(e.target.files?.[0]);
                  e.target.value = "";
                }}
              />
            </label>
            {client.badge && (
              <button type="button" className="text-button danger-text" onClick={() => void removeBadge()}>
                <Trash2 size={13} /> Remove
              </button>
            )}
          </div>
          {client.badge ? (
            <>
              <div className="badge-preview" style={{ background: client.colors[0]?.hex || "#1a1a1a" }}>
                <img src={`/api/studio/clients/${client.id}/badge?v=${client.updated}`} alt="Corner logo" />
              </div>
              <div className="field-grid">
                <Select value={spec.badge.position} onValueChange={(v) => patchBadge({ position: v as OverlaySpec["badge"]["position"] })}>
                  <SelectTrigger aria-label="Corner logo position"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="bottom-left">Bottom left</SelectItem>
                    <SelectItem value="bottom-right">Bottom right</SelectItem>
                    <SelectItem value="top-left">Top left</SelectItem>
                    <SelectItem value="top-right">Top right</SelectItem>
                    <SelectItem value="none">Hidden</SelectItem>
                  </SelectContent>
                </Select>
                <Select value={spec.badge.color || "original"} onValueChange={(v) => patchBadge({ color: v === "original" ? "" : v })}>
                  <SelectTrigger aria-label="Corner logo colour"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="original">Its own colours</SelectItem>
                    <SelectItem value="#ffffff">White</SelectItem>
                    {client.colors
                      .filter((c) => c.hex.toLowerCase() !== "#ffffff")
                      .map((c) => (
                        <SelectItem key={c.hex} value={c.hex}>
                          {c.name}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="field-grid">
                <label className="num"><span>Width</span><input type="number" value={px(spec.badge.width)} onChange={(e) => patchBadge({ width: frac(Number(e.target.value)) })} /></label>
                <label className="num"><span>From edge</span><input type="number" value={px(spec.badge.inset)} onChange={(e) => patchBadge({ inset: frac(Number(e.target.value)) })} /></label>
              </div>
            </>
          ) : (
            <div className="prompt-tip">A small second mark in a corner of every post, such as a parent group or partner logo.</div>
          )}
          <label className="field-label">Headline</label>
          <div className="field-grid">
            {fontField(spec.headline.font, (font) => patchHeadline({ font }), "Headline font")}
            <Select value={spec.headline.position} onValueChange={(v) => patchHeadline({ position: v as OverlaySpec["headline"]["position"] })}>
              <SelectTrigger aria-label="Headline position"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="bottom">Bottom</SelectItem>
                <SelectItem value="top">Top</SelectItem>
                <SelectItem value="center">Centre</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="field-grid three">
            <label className="num"><span>Size</span><input type="number" value={px(spec.headline.size)} onChange={(e) => patchHeadline({ size: frac(Number(e.target.value)) })} /></label>
            <label className="num"><span>Weight</span><input type="number" step={100} min={100} max={900} value={spec.headline.weight} onChange={(e) => patchHeadline({ weight: Number(e.target.value) || 400 })} /></label>
            <label className="num"><span>From edge</span><input type="number" value={px(spec.headline.inset)} onChange={(e) => patchHeadline({ inset: frac(Number(e.target.value)) })} /></label>
          </div>
          <div className="field-grid three">
            <label className="num"><span>Colour</span><input type="color" value={spec.headline.color} onChange={(e) => patchHeadline({ color: e.target.value })} /></label>
            <label className="num"><span>Drop colour</span><input type="color" value={spec.headline.shadow || "#000000"} onChange={(e) => patchHeadline({ shadow: e.target.value })} /></label>
            <label className="num"><span>Drop offset</span><input type="number" value={px(spec.headline.shadowOffset)} onChange={(e) => patchHeadline({ shadowOffset: frac(Number(e.target.value)), shadow: Number(e.target.value) > 0 ? spec.headline.shadow || "#000000" : "" })} /></label>
          </div>
          <Select value={spec.headline.align} onValueChange={(v) => patchHeadline({ align: v as OverlaySpec["headline"]["align"] })}>
            <SelectTrigger aria-label="Headline alignment"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="center">Centred</SelectItem>
              <SelectItem value="left">Left</SelectItem>
              <SelectItem value="right">Right</SelectItem>
            </SelectContent>
          </Select>
          <label className="field-label">Second line</label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={spec.subline.show !== false}
              onChange={(e) => patchSubline({ show: e.target.checked })}
            />
            Show a second line under the headline
          </label>
          <div className="field-grid three">
            {fontField(spec.subline.font, (font) => patchSubline({ font }), "Second line font")}
            <label className="num"><span>Size</span><input type="number" value={px(spec.subline.size)} onChange={(e) => patchSubline({ size: frac(Number(e.target.value)) })} /></label>
            <label className="num"><span>Colour</span><input type="color" value={spec.subline.color} onChange={(e) => patchSubline({ color: e.target.value })} /></label>
          </div>
          <label className="field-label">Margins and fade</label>
          <div className="field-grid three">
            <label className="num"><span>Side margin</span><input type="number" value={px(spec.margin)} onChange={(e) => setSpec((o) => ({ ...o, margin: frac(Number(e.target.value)) }))} /></label>
            <label className="num"><span>Fade %</span><input type="number" min={0} max={100} value={Math.round(spec.scrim * 100)} onChange={(e) => setSpec((o) => ({ ...o, scrim: Math.max(0, Math.min(100, Number(e.target.value) || 0)) / 100 }))} /></label>
            <label className="num"><span>Fade colour</span><input type="color" value={spec.scrimColor} onChange={(e) => setSpec((o) => ({ ...o, scrimColor: e.target.value }))} /></label>
          </div>
          <div className="prompt-tip">Sizes are in pixels on a 1080-wide post and scale with the export resolution.</div>
        </>
      )}
    </Section>
  );
}
