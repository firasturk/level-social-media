import { useEffect, useState, type ReactNode, useRef } from "react";
import { askConfirm, askInput } from "@/lib/confirm";
import { toast } from "sonner";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Link as LinkIcon,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { Orb } from "@/components/Orb";
import { del, get, post, put } from "@/api";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import ReferenceLibrary from "./ReferenceLibrary";
import FontPicker from "./FontPicker";
import Ambassadors from "./Ambassadors";
import { Group, KitIcon, type KitKey } from "./kit";
import type { Ambassador, Client, EngineModel, Theme } from "@shared/types";
import { colourName, FORMATS, FORMAT_INFO, MAX_POST_COUNT, type Format } from "@shared/posts";
import { SIZES, type Size } from "@shared/config";
import {
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
  /** Exact product mode: the real product photo is placed into each scene, never redrawn. */
  exact?: boolean;
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
  ambassadors,
  onAmbassadorsChanged,
  cast,
  onCast,
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
  ambassadors: Ambassador[];
  onAmbassadorsChanged: (list: Ambassador[]) => void;
  /** Ambassador ids cast in this month. */
  cast: string[];
  onCast: (ids: string[]) => void;
  /** A theme's references changed and were read again (new pin or photo). */
}) {
  return (
    <aside className="brand-panel">
      <BrandKit client={client} onClientsChanged={onClientsChanged} />
      <Section
        kit="ambassadors"
        title="Brand ambassadors"
        subtitle={
          ambassadors.length
            ? `${ambassadors.length} people · ${cast.length} in this month`
            : "AI people with the same face in every post"
        }
        defaultOpen={false}
      >
        <Ambassadors
          client={client}
          ambassadors={ambassadors}
          onChanged={onAmbassadorsChanged}
          cast={cast}
          onCast={onCast}
          locked={locked}
        />
      </Section>
      <ThemeSection
        client={client}
        themes={themes}
        theme={theme}
        onTheme={onTheme}
        onThemesChanged={onThemesChanged}
      />
      <OverlaySection client={client} onClientsChanged={onClientsChanged} />
      <LessonsSection client={client} />
      <Section kit="output" title="Output" subtitle="Engine, size and count" defaultOpen={false}>
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
        <label className="check-row" title="The engine paints the scene with an empty place, then the real product photo is set into it with its shadow. Posts with one product; nobody holds it.">
          <input
            type="checkbox"
            checked={!!settings.exact}
            disabled={locked}
            onChange={(e) => onSettings({ exact: e.target.checked })}
          />
          Exact product: place the real photo, never redraw it
        </label>
      </Section>
    </aside>
  );
}

export function Section({
  title,
  subtitle,
  defaultOpen = true,
  children,
  actions,
  kit,
  bare,
}: {
  title: string;
  subtitle?: string;
  defaultOpen?: boolean;
  children: ReactNode;
  actions?: ReactNode;
  kit?: KitKey;
  /** Rendered without its collapsible head (the journey screens show one section each). */
  bare?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (bare)
    return (
      <div className="bp-bare">
        {actions}
        {children}
      </div>
    );
  return (
    <section className={`bp-section ${open ? "open" : ""}`} data-kit={kit}>
      <button type="button" className="bp-head" onClick={() => setOpen((v) => !v)}>
        <span>
          {kit && <KitIcon kit={kit} size={16} />}
          <span className="bp-head-text">
            <strong>{title}</strong>
            {subtitle && <small>{subtitle}</small>}
          </span>
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
  imageRules: string;
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
    imageRules: c.imageRules ?? "",
    style: c.style,
  };
}

const DEFAULT_COLORS = [
  { name: "Primary", hex: "#1a1a1a" },
  { name: "Secondary", hex: "#f2f2f2" },
  { name: "Accent", hex: "#c8a24a" },
];

export function BrandKit({
  client,
  onClientsChanged,
  bare,
}: {
  client: Client;
  onClientsChanged: (clients: Client[]) => void;
  bare?: boolean;
}) {
  const [draft, setDraft] = useState<KitDraft>(() => draftOf(client));
  const [saving, setSaving] = useState(false);
  const [analysing, setAnalysing] = useState(false);
  // Live: every change saves itself shortly after the last edit; a save in flight is not undone
  // by the client coming back from the server.
  const kitPending = useRef(false);
  useEffect(() => {
    if (!kitPending.current) setDraft(draftOf(client));
  }, [client]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(client));
  // Read inside blur handlers, which close over an older render.
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const secondLineShown = resolveOverlay(client.overlay).subline.show !== false;

  /** Turns the second line on or off for every post of this client. */
  async function setSecondLine(show: boolean) {
    const raw = client.overlay ?? {};
    try {
      const r = await put<ClientsReply>(`/api/studio/clients/${client.id}`, {
        overlay: { ...raw, subline: { ...(raw.subline ?? {}), show } },
      });
      onClientsChanged(r.clients);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  /**
   * A font choice saves at once and also sets the overlay, so the posts change with it: the
   * headline font draws the headline, the body font the second line.
   */
  async function saveFont(which: "headline" | "body", family: string, weight: number | null) {
    const fonts = { ...draft.fonts, [which]: family };
    setDraft((d) => ({ ...d, fonts }));
    const raw = client.overlay ?? {};
    const overlay =
      which === "headline"
        ? { ...raw, headline: { ...(raw.headline ?? {}), font: family, ...(weight ? { weight } : {}) } }
        : { ...raw, subline: { ...(raw.subline ?? {}), font: family, ...(weight ? { weight } : {}) } };
    try {
      const r = await put<ClientsReply>(`/api/studio/clients/${client.id}`, { fonts, overlay });
      onClientsChanged(r.clients);
      if (which === "body" && !secondLineShown)
        toast.info(`Body font: ${family}. ${client.name}'s posts have no second line, so it does not show on them.`);
      else toast.success(`${which === "headline" ? "Headline" : "Body"} font: ${family}. The posts are redrawn.`);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  useEffect(() => {
    if (!dirty) return;
    kitPending.current = true;
    const t = setTimeout(() => void save(true).finally(() => (kitPending.current = false)), 800);
    return () => clearTimeout(t);
  }, [draft]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Saves the kit; changes save themselves (silent) a moment after the last edit. */
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
        imageRules: draft.imageRules,
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
      bare={bare}
      kit="brand"
      title="Brand kit"
      subtitle={`${client.name}: colours, fonts, tone`}
      actions={saving ? <div className="bp-saving"><Orb size={12} /> Saving…</div> : null}
    >
      <LogosGroup client={client} onClientsChanged={onClientsChanged} />
      <PlacesGroup client={client} onClientsChanged={onClientsChanged} />
      <RealPeopleGroup client={client} onClientsChanged={onClientsChanged} />
      <Group
        kit="colours"
        title="Brand colours"
        actions={
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
        }
      >
      {draft.colors.length ? (
        <div className="color-list">
          {draft.colors.map((c, i) => (
            <div className="color-row" key={i}>
              <input
                type="color"
                value={/^#[0-9a-fA-F]{6}$/.test(c.hex) ? c.hex : "#888888"}
                onChange={(e) => setColor(i, { hex: e.target.value, name: colourName(e.target.value) })}
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
      </Group>
      <Group kit="fonts">
      <div className="field-grid">
        <div>
          <label className="field-label">Headline font</label>
          <FontPicker
            kind="headline"
            label="Headline font"
            value={draft.fonts.headline}
            brandFonts={client.fontFiles.map((f) => f.name)}
            onChange={(family, weight) => void saveFont("headline", family, weight)}
          />
        </div>
        <div>
          <label className="field-label">Body font</label>
          <FontPicker
            kind="body"
            label="Body font"
            value={draft.fonts.body}
            brandFonts={client.fontFiles.map((f) => f.name)}
            onChange={(family, weight) => void saveFont("body", family, weight)}
          />
        </div>
      </div>
      {secondLineShown ? (
        <p className="field-hint">The headline font draws the text on every post; the body font draws the second line under it.</p>
      ) : (
        <p className="field-hint field-warn">
          {client.name}'s posts carry the headline only, so the body font is not drawn on them.
        </p>
      )}
      <label className="check-row">
        <input type="checkbox" checked={secondLineShown} onChange={(e) => void setSecondLine(e.target.checked)} />
        Show a second line under the headline (in the body font)
      </label>
      </Group>
      <Group kit="voice" title="Tone of voice and language">
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
      </Group>
      <Group kit="rules" title="Rules">
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
      <div>
        <label className="field-label" htmlFor="image-rules">
          Image rules
        </label>
        <textarea
          id="image-rules"
          rows={6}
          value={draft.imageRules}
          placeholder="The client's own picture rules, sent to the engine with every post: realism, light, how its products must be kept (for example: the graphics are flat prints, never embroidery)."
          onChange={(e) => setDraft((d) => ({ ...d, imageRules: e.target.value }))}
          onBlur={() => void save(true)}
        />
      </div>
      </Group>
      <Group kit="identity">
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
              <Orb size={13} />
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
      </Group>
    </Section>
  );
}

/* ───────────── Logos ───────────── */

/** The client's main logo and its corner logo (a parent or partner mark), uploaded here. */
/** Photos of the client's own place: a grid's place tile is set in the real shop, café or kitchen. */
function PlacesGroup({ client, onClientsChanged }: { client: Client; onClientsChanged: (clients: Client[]) => void }) {
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const places = client.places ?? [];
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      const form = new FormData();
      for (const f of Array.from(files).slice(0, 12)) form.append("file", f);
      const r = await postForm<ClientsReply>(`/api/studio/clients/${client.id}/places`, form);
      onClientsChanged(r.clients);
      toast.success(`${files.length} photo${files.length > 1 ? "s" : ""} of the place added.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }
  async function remove(id: string) {
    if (!(await askConfirm("Remove this photo of the place?", { ok: "Remove" }))) return;
    try {
      const r = await del<ClientsReply>(`/api/studio/clients/${client.id}/places/${id}`);
      onClientsChanged(r.clients);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  return (
    <Group
      kit="references"
      title="Place photos"
      actions={
        <button type="button" className="text-button" disabled={busy} onClick={() => input.current?.click()}>
          {busy ? <Orb size={13} /> : <Plus size={13} />} Add photos
        </button>
      }
    >
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => void upload(e.target.files)} />
      {places.length ? (
        <div className="place-list">
          {places.map((p) => (
            <span key={p.id} className="place-thumb">
              <img src={`/api/studio/clients/${client.id}/places/${p.id}/file`} alt={p.name} loading="lazy" />
              <button type="button" className="icon-button" aria-label={`Remove ${p.name}`} onClick={() => void remove(p.id)}>
                <Trash2 size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <div className="prompt-tip">The shop, café, kitchen or counter. When a month follows a grid, its place tiles are set in these real photos.</div>
      )}
    </Group>
  );
}

/**
 * Photos of real people (Pinterest links or uploads): the image model sees what a real photo of a
 * person looks like (skin, light, lens), so the brand's people stop looking generated.
 */
function RealPeopleGroup({ client, onClientsChanged }: { client: Client; onClientsChanged: (clients: Client[]) => void }) {
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const refs = client.realRefs ?? [];
  async function upload(files: FileList | null) {
    if (!files?.length) return;
    setBusy(true);
    try {
      const form = new FormData();
      for (const f of Array.from(files).slice(0, 12)) form.append("file", f);
      const r = await postForm<ClientsReply>(`/api/studio/clients/${client.id}/realrefs`, form);
      onClientsChanged(r.clients);
      toast.success(`${files.length} photo${files.length > 1 ? "s" : ""} of real people added.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
      if (input.current) input.current.value = "";
    }
  }
  async function addLinks() {
    const text = await askInput("Pinterest links of real models", "", { ok: "Add", placeholder: "One or more pin links, separated by spaces or new lines" });
    const links = (text ?? "").split(/\s+/).filter((x) => /^https?:\/\//.test(x)).slice(0, 12);
    if (!links.length) return;
    setBusy(true);
    try {
      const r = await post<ClientsReply & { failed: string[] }>(`/api/studio/clients/${client.id}/realrefs`, { links });
      onClientsChanged(r.clients);
      if (r.failed.length) toast.error(`${r.failed.length} link${r.failed.length > 1 ? "s" : ""} could not be read.`);
      else toast.success(`${links.length} photo${links.length > 1 ? "s" : ""} of real people added.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function remove(id: string) {
    if (!(await askConfirm("Remove this photo?", { ok: "Remove" }))) return;
    try {
      const r = await del<ClientsReply>(`/api/studio/clients/${client.id}/realrefs/${id}`);
      onClientsChanged(r.clients);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  return (
    <Group
      kit="ambassadors"
      title="Real people"
      actions={
        <span className="group-actions">
          <button type="button" className="text-button" disabled={busy} onClick={() => void addLinks()}>
            {busy ? <Orb size={13} /> : <Plus size={13} />} Pinterest links
          </button>
          <button type="button" className="text-button" disabled={busy} onClick={() => input.current?.click()}>
            <Plus size={13} /> Upload
          </button>
        </span>
      }
    >
      <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" multiple hidden onChange={(e) => void upload(e.target.files)} />
      {refs.length ? (
        <div className="place-list">
          {refs.map((p) => (
            <span key={p.id} className="place-thumb">
              <img src={`/api/studio/clients/${client.id}/realrefs/${p.id}/file`} alt={p.name} loading="lazy" />
              <button type="button" className="icon-button" aria-label={`Remove ${p.name}`} onClick={() => void remove(p.id)}>
                <Trash2 size={12} />
              </button>
            </span>
          ))}
        </div>
      ) : (
        <div className="prompt-tip">
          Real photos of real models in natural light (from Pinterest or your shoots). The posts and the ambassadors' portraits copy their realism: skin, light and lens. Never their faces or clothes.
        </div>
      )}
    </Group>
  );
}

function LogosGroup({ client, onClientsChanged }: { client: Client; onClientsChanged: (clients: Client[]) => void }) {
  const [busy, setBusy] = useState<"" | "logo" | "badge">("");
  const inputs = { logo: useRef<HTMLInputElement>(null), badge: useRef<HTMLInputElement>(null) };
  async function upload(mark: "logo" | "badge", file: File | undefined) {
    if (!file) return;
    setBusy(mark);
    try {
      const form = new FormData();
      form.append("file", file);
      const r = await postForm<ClientsReply>(`/api/studio/clients/${client.id}/${mark}`, form);
      onClientsChanged(r.clients);
      toast.success(mark === "logo" ? "Logo saved." : "Corner logo saved.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
      const el = inputs[mark].current;
      if (el) el.value = "";
    }
  }
  async function remove(mark: "logo" | "badge") {
    if (!(await askConfirm(mark === "logo" ? "Remove the logo?" : "Remove the corner logo?", { ok: "Remove" }))) return;
    try {
      const r = await del<ClientsReply>(`/api/studio/clients/${client.id}/${mark}`);
      onClientsChanged(r.clients);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  const tile = (mark: "logo" | "badge", label: string, hint: string) => {
    const has = mark === "logo" ? client.logo : client.badge;
    return (
      <div className="logo-tile">
        <button
          type="button"
          className={`logo-drop ${has ? "has" : ""}`}
          style={{ background: has ? client.colors[0]?.hex || "#1a1a1a" : undefined }}
          onClick={() => inputs[mark].current?.click()}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void upload(mark, e.dataTransfer.files[0]);
          }}
          disabled={!!busy}
          aria-label={has ? `Replace the ${label.toLowerCase()}` : `Upload the ${label.toLowerCase()}`}
        >
          {busy === mark ? (
            <Orb size={18} />
          ) : has ? (
            <img src={`/api/studio/clients/${client.id}/${mark}?v=${client.updated}`} alt={label} />
          ) : (
            <span>
              <Plus size={16} /> Upload
            </span>
          )}
        </button>
        <div className="logo-tile-text">
          <strong>{label}</strong>
          <small>{hint}</small>
          {has && (
            <button type="button" className="text-button danger" onClick={() => void remove(mark)}>
              <Trash2 size={12} /> Remove
            </button>
          )}
        </div>
        <input
          ref={inputs[mark]}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          hidden
          onChange={(e) => void upload(mark, e.target.files?.[0])}
        />
      </div>
    );
  };
  return (
    <Group kit="logo" title="Logos">
      <div className="logo-tiles">
        {tile("logo", "Logo", "On every post. PNG or SVG with a transparent background works best.")}
        {tile("badge", "Corner logo", "Optional: a parent or partner mark, small in a corner.")}
      </div>
    </Group>
  );
}

/* ───────────── Theme ───────────── */

export type ThemePart = "pick" | "references" | "direction" | "colours" | "props" | "wardrobe" | "shots";

export function ThemeSection({
  client,
  themes,
  theme,
  onTheme,
  onThemesChanged,
  parts,
  bare,
  gridRef,
  batchId,
}: {
  /** The grid the month follows: its colours are suggested instead of the pins'. */
  gridRef?: string | null;
  /** The month being made: its cast and grid steer the wardrobe Suggest. */
  batchId?: string | null;
  client: Client;
  themes: Theme[];
  theme: string;
  onTheme: (id: string) => void;
  onThemesChanged: (themes: Theme[]) => void;
  /** Only these parts (the journey shows the theme over several screens); all when omitted. */
  parts?: ThemePart[];
  bare?: boolean;
}) {
  const show = (p: ThemePart) => !parts || parts.includes(p);
  const current = themes.find((t) => t.id === theme) ?? null;
  const [direction, setDirection] = useState(current?.direction ?? "");
  const [props, setProps] = useState(current?.props ?? "");
  useEffect(() => setProps(current?.props ?? ""), [current?.id, current?.props]);
  const [wardrobe, setWardrobe] = useState(current?.wardrobe ?? "");
  useEffect(() => setWardrobe(current?.wardrobe ?? ""), [current?.id, current?.wardrobe]);
  const paletteKey = JSON.stringify(current?.palette ?? []);
  const [colors, setColors] = useState<{ name: string; hex: string }[]>(current?.palette ?? []);
  useEffect(() => setColors(current?.palette ?? []), [current?.id, paletteKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // Every change saves itself shortly after the last edit (a colour picker never reliably blurs).
  useEffect(() => {
    if (!current || JSON.stringify(colors) === paletteKey) return;
    const t = setTimeout(() => void savePalette(colors), 700);
    return () => clearTimeout(t);
  }, [colors]); // eslint-disable-line react-hooks/exhaustive-deps
  const shotsText = (current?.shots ?? []).join("\n\n");
  const [shots, setShots] = useState(shotsText);
  useEffect(() => setShots(shotsText), [current?.id, shotsText]);
  const [busy, setBusy] = useState<"" | "analyse" | "import" | "create" | "colors" | "wardrobe">("");
  const [pins, setPins] = useState("");
  // The journey shows the links box open: pins are its main way in.
  const [showPins, setShowPins] = useState(!!bare);
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

  /** The designer's colours; from now on Analyse no longer replaces them. */
  async function savePalette(next: { name: string; hex: string }[]) {
    if (!current || JSON.stringify(next) === paletteKey) return;
    try {
      const r = await put<ThemesReply>(`/api/studio/posts/themes/${current.id}`, { palette: next });
      onThemesChanged(r.themes);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function suggestColors() {
    if (!current) return;
    setBusy("colors");
    try {
      const r = await post<ThemesReply>(`/api/studio/posts/themes/${current.id}/palette`, gridRef ? { grid: gridRef } : undefined);
      onThemesChanged(r.themes);
      toast.success(`Colours suggested from ${gridRef ? "the grid you chose" : "the references"}. Change any of them.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
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

  async function saveWardrobe() {
    if (!current || wardrobe === (current.wardrobe ?? "")) return;
    try {
      const r = await put<ThemesReply>(`/api/studio/posts/themes/${current.id}`, { wardrobe });
      onThemesChanged(r.themes);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function suggestWardrobe() {
    if (!current) return;
    setBusy("wardrobe");
    try {
      const r = await post<ThemesReply>(`/api/studio/posts/themes/${current.id}/wardrobe`, batchId ? { batch: batchId } : undefined);
      onThemesChanged(r.themes);
      toast.success("Outfits suggested for the month's people. Change any of them.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy("");
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
    <Section kit="theme" title="Theme" subtitle={current ? current.title : "Pick or create a theme"} bare={bare}>
      {show("pick") && (
      <>
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
          <div className="theme-tools">
            <button type="button" className="text-button" onClick={() => void rename()}>
              Rename
            </button>
            <button type="button" className="text-button danger" onClick={() => void removeTheme()}>
              <Trash2 size={13} /> Delete
            </button>
          </div>
      )}
      </>
      )}
      {current && (
        <>
          {show("references") && (
          <Group kit="references">
          <ReferenceLibrary
            key={`${current.id}:${libKey}`}
            skill={current.id}
            onChanged={(count) => (count > 0 ? void analyse(true) : reloadThemes())}
            title="Photos and pins"
            empty="No references yet. Drag several photos here or use Add photos, and paste as many Pinterest pin links as you like. Every post borrows place, light and mood from one of them."
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
                    <Orb size={13} />
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
                placeholder={"Paste one or more Pinterest pin links, one per line (up to 30):\nhttps://www.pinterest.com/pin/…\nhttps://pin.it/…"}
                onChange={(e) => setPins(e.target.value)}
              />
              <button className="secondary" onClick={() => void importPins()} disabled={busy === "import"}>
                {busy === "import" ? <Orb size={15} /> : <LinkIcon size={15} />}
                Import pins
              </button>
            </div>
          )}
          </Group>
          )}
          {show("direction") && (
          <Group kit="direction">
          <textarea
            id="direction"
            rows={4}
            value={direction}
            placeholder="What this month's posts should feel like: places, light, palette, mood. Press Analyse to write it from the references."
            onChange={(e) => setDirection(e.target.value)}
            onBlur={() => void saveDirection()}
          />
          {current.library && (
            <details className="theme-library">
              <summary>Visual language (from the references)</summary>
              <pre>{current.library}</pre>
            </details>
          )}
          </Group>
          )}
          {show("colours") && (
          <Group
            kit="colours"
            title="Colours this month"
            note={colors.length ? (current.paletteAuto ? "suggested" : "yours") : undefined}
            actions={
              <button
                type="button"
                className="text-button"
                onClick={() => void suggestColors()}
                disabled={busy === "colors" || (!current.references && !gridRef)}
                title={gridRef ? "Read the grid you chose and suggest its colours (replaces the list)" : "Read the references again and suggest their colours (replaces the list)"}
              >
                {busy === "colors" ? <Orb size={13} /> : <Sparkles size={13} />}
                Suggest
              </button>
            }
          >
          <div className="theme-palette">
            {colors.map((c, i) => (
              <div className={`swatch-edit ${i === 0 ? "is-background" : ""}`} key={i}>
                <input
                  type="color"
                  value={c.hex}
                  aria-label={`Colour ${i + 1}`}
                  onChange={(e) =>
                    setColors((l) =>
                      l.map((x, j) =>
                        j === i ? { name: colourName(e.target.value), hex: e.target.value.toLowerCase() } : x,
                      ),
                    )
                  }
                />
                <input
                  className="swatch-name"
                  value={c.name}
                  placeholder={c.hex}
                  aria-label={`Colour ${i + 1} name`}
                  onChange={(e) => setColors((l) => l.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                />
                {i === 0 ? (
                  <span className="swatch-role" title="The backdrop, wall and main surface of every post">
                    Background
                  </span>
                ) : (
                  <button
                    type="button"
                    className="swatch-role as-button"
                    title="Use this colour for the backdrop, wall and main surface"
                    onClick={() => setColors((l) => [l[i], ...l.filter((_, j) => j !== i)])}
                  >
                    Use as background
                  </button>
                )}
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`Remove colour ${i + 1}`}
                  onClick={() => setColors((l) => l.filter((_, j) => j !== i))}
                >
                  <X size={12} />
                </button>
              </div>
            ))}
            {colors.length < 8 && (
              <button
                type="button"
                className="swatch-add"
                onClick={() => setColors((l) => [...l, { name: "", hex: "#cccccc" }])}
              >
                <Plus size={13} /> Colour
              </button>
            )}
          </div>
          {client.colors.length > 0 && (
            <div className="brand-swatches">
              <span className="brand-swatches-label">Brand colours</span>
              {client.colors.map((c) => {
                const on = colors.some((x) => x.hex.toLowerCase() === c.hex.toLowerCase());
                return (
                  <button
                    key={c.hex}
                    type="button"
                    className={`brand-swatch ${on ? "on" : ""}`}
                    title={on ? `${c.name || c.hex}: in this month (click to take it out)` : `Add ${c.name || c.hex} to this month`}
                    onClick={() =>
                      setColors((l) =>
                        on
                          ? l.filter((x) => x.hex.toLowerCase() !== c.hex.toLowerCase())
                          : l.length >= 8
                            ? l
                            : [...l, { name: c.name || colourName(c.hex), hex: c.hex.toLowerCase() }],
                      )
                    }
                  >
                    <i style={{ background: c.hex }} />
                    {c.name || c.hex}
                    {on ? <Check size={11} /> : <Plus size={11} />}
                  </button>
                );
              })}
              <button
                type="button"
                className="text-button"
                title="This month in the brand's colours only (replaces the list)"
                onClick={() => setColors(client.colors.slice(0, 8).map((c) => ({ name: c.name || colourName(c.hex), hex: c.hex.toLowerCase() })))}
              >
                Brand colours only
              </button>
            </div>
          )}
          <p className="field-hint">
            {colors.length
              ? "The posts are built in these colours, whatever colours the references have: the first is the background, the others go to the surfaces, fabrics and clothes. Mix the theme's colours with the brand's, or use one of them."
              : "Press Analyse or Suggest to read the references' colours, or add your own. Without colours the brand palette is used."}
          </p>
          </Group>
          )}
          {show("props") && (
          <Group kit="props">
          <textarea
            id="theme-props"
            rows={2}
            value={props}
            placeholder="Objects to add to the scenes this month: autumn leaves, pumpkins, a knit scarf, fairy lights…"
            onChange={(e) => setProps(e.target.value)}
            onBlur={() => void saveProps()}
          />
          <p className="field-hint">The ideas and every image prompt ask for these props, placed naturally around the product.</p>
          </Group>
          )}
          {show("wardrobe") && (
          <Group
            kit="wardrobe"
            actions={
              <button type="button" className="text-button" onClick={() => void suggestWardrobe()} disabled={busy === "wardrobe"} title="Outfits in the month's colours, for its people and their rules (replaces the list)">
                {busy === "wardrobe" ? <Orb size={13} /> : <Sparkles size={13} />}
                Suggest
              </button>
            }
          >
          <textarea
            id="theme-wardrobe"
            rows={wardrobe ? Math.min(6, wardrobe.split("\n").length + 1) : 2}
            value={wardrobe}
            placeholder="One outfit per line: a long cream linen dress with a navy hijab, silver rings…"
            onChange={(e) => setWardrobe(e.target.value)}
            onBlur={() => void saveWardrobe()}
          />
          <p className="field-hint">The people in the posts wear these outfits, one after another; press Suggest and I pick them for the month.</p>
          </Group>
          )}
          {show("shots") && (
          <Group kit="shots" title="Shots from the references" note={current.shots?.length ? `${current.shots.length}` : undefined}>
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
          </Group>
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
  const overlayPending = useRef(false);
  useEffect(() => {
    if (!overlayPending.current) setSpec(resolveOverlay(client.overlay));
  }, [client]);
  const dirty = JSON.stringify(spec) !== JSON.stringify(resolveOverlay(client.overlay));

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
      toast.success("Corner logo added.");
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

  // Live: the posts redraw a moment after every change.
  useEffect(() => {
    if (!dirty) return;
    overlayPending.current = true;
    const t = setTimeout(() => void save().finally(() => (overlayPending.current = false)), 600);
    return () => clearTimeout(t);
  }, [spec]); // eslint-disable-line react-hooks/exhaustive-deps

  async function save() {
    setSaving(true);
    try {
      const r = await put<ClientsReply>(`/api/studio/clients/${client.id}`, {
        overlay: spec,
        fonts: { headline: spec.headline.font, body: spec.subline.font },
      });
      onClientsChanged(r.clients);
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


  return (
    <Section
      kit="overlay"
      title="Overlay"
      subtitle="Headline, sub-line and logo drawn over each post"
      defaultOpen={false}
      actions={saving ? <div className="bp-saving"><Orb size={12} /> Saving…</div> : null}
    >
      <Group kit="overlay" title="Layout">
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
      </Group>
      {spec.template !== "none" && (
        <>
          <Group kit="fonts" title="Brand font files">
          <div className="field-row">
            <label className="text-button">
              {fontBusy ? <Orb size={13} /> : <Plus size={13} />} Add font file
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
              No font files yet. The 10 headline and 10 body fonts in the pickers work without a file. Upload a .ttf or .woff2 for any other family; it appears first in the pickers.
            </div>
          )}
          </Group>
          <Group kit="logo">
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
          </Group>
          <Group kit="corner">
          <div className="field-row">
            <label className="text-button">
              {badgeBusy ? <Orb size={13} /> : <Plus size={13} />}
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
          </Group>
          <Group kit="headline">
          <div className="field-grid">
            <FontPicker
              kind="headline"
              label="Headline font"
              value={spec.headline.font}
              brandFonts={client.fontFiles.map((f) => f.name)}
              onChange={(font, weight) => patchHeadline({ font, ...(weight ? { weight } : {}) })}
            />
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
          </Group>
          <Group kit="secondline">
          <label className="check-row">
            <input
              type="checkbox"
              checked={spec.subline.show !== false}
              onChange={(e) => patchSubline({ show: e.target.checked })}
            />
            Show a second line under the headline
          </label>
          <div className="field-grid three">
            <FontPicker
              kind="body"
              label="Second line font"
              value={spec.subline.font}
              brandFonts={client.fontFiles.map((f) => f.name)}
              onChange={(font, weight) => patchSubline({ font, ...(weight ? { weight } : {}) })}
            />
            <label className="num"><span>Size</span><input type="number" value={px(spec.subline.size)} onChange={(e) => patchSubline({ size: frac(Number(e.target.value)) })} /></label>
            <label className="num"><span>Colour</span><input type="color" value={spec.subline.color} onChange={(e) => patchSubline({ color: e.target.value })} /></label>
          </div>
          </Group>
          <Group kit="spacing">
          <div className="field-grid three">
            <label className="num"><span>Side margin</span><input type="number" value={px(spec.margin)} onChange={(e) => setSpec((o) => ({ ...o, margin: frac(Number(e.target.value)) }))} /></label>
            <label className="num"><span>Fade %</span><input type="number" min={0} max={100} value={Math.round(spec.scrim * 100)} disabled={spec.scrim === 0} onChange={(e) => setSpec((o) => ({ ...o, scrim: Math.max(0, Math.min(100, Number(e.target.value) || 0)) / 100 }))} /></label>
            <label className="num"><span>Fade colour</span><input type="color" value={spec.scrimColor} disabled={spec.scrim === 0} onChange={(e) => setSpec((o) => ({ ...o, scrimColor: e.target.value }))} /></label>
          </div>
          <label className="check-row">
            <input
              type="checkbox"
              checked={spec.scrim > 0}
              onChange={(e) => setSpec((o) => ({ ...o, scrim: e.target.checked ? 0.5 : 0, scrimColor: e.target.checked ? "#000000" : o.scrimColor }))}
            />
            Dark fade under the text (black keeps every theme's colours)
          </label>
          <div className="prompt-tip">Sizes are in pixels on a 1080-wide post and scale with the export resolution.</div>
          </Group>
        </>
      )}
    </Section>
  );
}


interface Lesson {
  id: string;
  kind: string;
  text: string;
  seen: number;
  last: number;
  rule: string;
  status?: "pending" | "approved" | "rejected";
}

/**
 * Lessons: what the automatic review found wrong in this client's pictures. Each one is written into
 * the client's next prompts as a rule; a false alarm is forgotten with its ×.
 */
function LessonsSection({ client }: { client: Client }) {
  const [lessons, setLessons] = useState<Lesson[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    get<Lesson[]>(`/api/studio/lessons?client=${encodeURIComponent(client.id)}`)
      .then((l) => live && setLessons(l))
      .catch(() => live && setLessons([]));
    return () => {
      live = false;
    };
  }, [client.id]);
  async function forget(id: string) {
    setBusy(true);
    try {
      await del(`/api/studio/lessons/${id}`);
      setLessons((l) => l.filter((x) => x.id !== id));
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not forget it.");
    } finally {
      setBusy(false);
    }
  }
  async function forgetAll() {
    if (!(await askConfirm("Forget every lesson for this client? The next pictures will not carry these rules.", { ok: "Forget all" }))) return;
    setBusy(true);
    try {
      await del(`/api/studio/lessons?client=${encodeURIComponent(client.id)}`);
      setLessons([]);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not forget them.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <Section
      title="Lessons learned"
      subtitle={lessons.length ? `${lessons.length} mistake${lessons.length > 1 ? "s" : ""} the next pictures avoid` : "Mistakes found in earlier pictures become rules"}
      defaultOpen={false}
      actions={
        lessons.length ? (
          <button type="button" className="ghost small" disabled={busy} onClick={forgetAll}>
            Forget all
          </button>
        ) : undefined
      }
    >
      {lessons.length === 0 ? (
        <p className="muted small">Nothing yet. Every problem the review finds in a finished picture is kept here and written into the next prompts for {client.name}.</p>
      ) : (
        <ul className="lesson-list">
          {lessons.map((l) => (
            <li key={l.id} data-kind={l.kind}>
              <span className="lesson-kind">{l.kind === "ailook" ? "AI look" : l.kind}</span>
              <span className="lesson-text" title={l.rule}>
                {l.text}
              </span>
              {l.seen > 1 && <span className="lesson-seen">×{l.seen}</span>}
              {l.status && l.status !== "approved" && <span className="lesson-seen" title="Approve it on the Approvals page: Lessons learned">{l.status === "pending" ? "waiting" : "rejected"}</span>}
              <button type="button" className="lesson-forget" aria-label="Forget this lesson" disabled={busy} onClick={() => forget(l.id)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
