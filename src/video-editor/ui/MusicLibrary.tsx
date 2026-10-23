/**
 * The music library panel (docs/music-library.md): the studio's catalog and the client's own
 * tracks, with mood, genre, duration and BPM filters and a search; a preview with its waveform
 * (click to seek); the licence block of the chosen track (licence and link, author, source, the
 * credit line with a copy button, Content ID); and, for admins, importing a track from Drive or an
 * upload with the licence form. Self-contained: it talks to /api/studio/music and gives the
 * chosen track to its parent through `onPick`.
 *
 * Props contract (for the editor's Music tab):
 *   <MusicLibrary client={clientId} onPick={(pick) => …} selectedId={currentTrackId} />
 *   onPick(pick: MusicPick) — pick.track is the MusicTrack with its full licence
 *   (pick.track.licence: id, name, version, url, attribution, attributionRequired;
 *   pick.track.contentId: status, note, url; pick.track.source: name, page, author), pick.fileUrl
 *   streams the audio from our storage (Range-capable), pick.credit is the line to publish with
 *   the video. The panel does not change the project; the parent decides what to keep.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Copy, ExternalLink, HardDrive, Music, Pause, Play, Search, Upload, X } from "lucide-react";
import {
  BPM_BANDS,
  CONTENT_ID_LABELS,
  DURATION_BANDS,
  LICENCES,
  LICENCE_CONFIRMATION,
  MUSIC_MOODS,
  creditLine,
  peaksFrom,
  tempoFromEnvelope,
  validateLicenceForm,
  type ContentIdStatus,
  type LicenceId,
  type MusicFilter,
  type MusicMood,
  type MusicTrack,
} from "@shared/music";
import { musicApi, type MusicAccess, type MusicApi } from "../musicApi";
import "./music-library.css";

export interface MusicPick {
  track: MusicTrack;
  /** Our route that streams the file (Range-capable); fetch it to decode the track. */
  fileUrl: string;
  /** The credit line to publish with the video (the attribution text, or a courtesy line). */
  credit: string;
  pickedAt: number;
}

export interface MusicLibraryProps {
  /** The client whose own tracks show under "Client tracks"; null shows the catalog only. */
  client: string | null;
  clientName?: string;
  /** The track the project uses now, highlighted in the list. */
  selectedId?: string | null;
  onPick: (pick: MusicPick) => void;
  pickLabel?: string;
  /** The network layer; tests pass their own. */
  api?: MusicApi;
}

type Tab = "catalog" | "client";

const fmtTime = (s: number) => {
  if (!Number.isFinite(s) || s <= 0) return "0:00";
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${String(r).padStart(2, "0")}`;
};

const licenceTag = (t: MusicTrack) => (t.licence.id === "cc0-1.0" ? "CC0" : t.licence.name.replace(/\s*\(.*\)$/, "") + (t.licence.version && !t.licence.name.includes(t.licence.version) ? ` ${t.licence.version}` : ""));

/** The track decoded once, for its waveform and tempo; null when the browser cannot decode it. */
async function analyse(bytes: ArrayBuffer): Promise<{ peaks: number[]; bpm: number | null; duration: number } | null> {
  const { decodeAudio, energyEnvelope, BEAT_HOP } = await import("../engine/audio");
  const buf = await decodeAudio(bytes);
  if (!buf) return null;
  const channels = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  return { peaks: peaksFrom(channels), bpm: tempoFromEnvelope(energyEnvelope(buf), BEAT_HOP).bpm, duration: buf.duration };
}

/* ───────────── The waveform ───────────── */

function Waveform({ peaks, progress, onSeek, busy }: { peaks: number[] | null; progress: number; onSeek: (fraction: number) => void; busy: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !peaks) return;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth || 300;
    const h = c.clientHeight || 56;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    const ctx = c.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);
    const bar = w / peaks.length;
    const style = getComputedStyle(c);
    const played = style.getPropertyValue("--ml-wave-played").trim() || "#1129d3";
    const rest = style.getPropertyValue("--ml-wave").trim() || "#b8bcc8";
    peaks.forEach((p, i) => {
      const x = i * bar;
      const bh = Math.max(1, p * (h - 4));
      ctx.fillStyle = i / peaks.length <= progress ? played : rest;
      ctx.fillRect(x, (h - bh) / 2, Math.max(1, bar - 0.5), bh);
    });
  }, [peaks, progress]);
  if (!peaks)
    return (
      <div className="ml-wave ml-wave-empty" role="status">
        {busy || "No waveform yet"}
      </div>
    );
  return (
    <canvas
      ref={ref}
      className="ml-wave"
      role="slider"
      aria-label="Waveform: click to play from that point"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
      tabIndex={0}
      data-testid="waveform"
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        onSeek(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowRight") onSeek(Math.min(1, progress + 0.05));
        if (e.key === "ArrowLeft") onSeek(Math.max(0, progress - 0.05));
      }}
    />
  );
}

/* ───────────── The licence block ───────────── */

function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
    }
    setDone(true);
    window.setTimeout(() => setDone(false), 1600);
  };
  return (
    <button type="button" className="ts-mini" onClick={() => void copy()} aria-label={label}>
      {done ? <Check size={12} /> : <Copy size={12} />} {done ? "Copied" : "Copy"}
    </button>
  );
}

export function LicenceBlock({ track }: { track: MusicTrack }) {
  const l = track.licence;
  const credit = creditLine(track);
  // An English sentence around an Arabic title reads left to right; an all-Arabic credit finds its own direction.
  const creditDir = /[A-Za-z]/.test(credit.split(track.title).join("")) ? "ltr" : "auto";
  return (
    <div className="ml-licence" data-testid="licence">
      <dl>
        <dt>Licence</dt>
        <dd>
          {l.url ? (
            <a href={l.url} target="_blank" rel="noopener noreferrer">
              {l.name}
              {l.version && !l.name.includes(l.version) ? ` ${l.version}` : ""} <ExternalLink size={11} />
            </a>
          ) : (
            <span>{l.name}</span>
          )}
        </dd>
        <dt>Author</dt>
        <dd dir="auto">{track.source.author || track.artist}</dd>
        <dt>Source</dt>
        <dd>
          {track.source.page ? (
            <a href={track.source.page} target="_blank" rel="noopener noreferrer" dir="auto">
              {track.source.name} <ExternalLink size={11} />
            </a>
          ) : (
            <span dir="auto">{track.source.name}</span>
          )}
        </dd>
        <dt>Credit</dt>
        <dd>
          {l.attributionRequired ? <span className="ml-required">Required: publish this with the video</span> : <span className="ml-optional">Not required; a courtesy credit:</span>}
          <pre className="ml-credit" dir={creditDir} data-testid="credit">
            {credit}
          </pre>
          <CopyButton text={credit} label="Copy the credit text" />
        </dd>
        <dt>Content ID</dt>
        <dd>
          <span className={`ml-cid ${track.contentId.status}`} data-testid="content-id">
            {CONTENT_ID_LABELS[track.contentId.status]}
          </span>
          {track.contentId.note && <p className="ml-note" dir="auto">{track.contentId.note}</p>}
          {track.contentId.url && (
            <a href={track.contentId.url} target="_blank" rel="noopener noreferrer">
              What the source says <ExternalLink size={11} />
            </a>
          )}
        </dd>
      </dl>
      <p className="ml-note">A licence lets us use the recording. It does not stop a platform's automated matching from flagging a video; keep the credit in the post and the source page to dispute a claim.</p>
    </div>
  );
}

/* ───────────── The import form ───────────── */

interface Draft {
  how: "upload" | "drive";
  file: File | null;
  link: string;
  title: string;
  artist: string;
  moods: MusicMood[];
  genre: string;
  bpm: string;
  source: string;
  sourceUrl: string;
  author: string;
  licence: LicenceId;
  licenceName: string;
  licenceVersion: string;
  licenceUrl: string;
  attribution: string;
  contentId: ContentIdStatus;
  contentIdNote: string;
  confirmed: boolean;
}

const emptyDraft = (how: "upload" | "drive"): Draft => ({
  how,
  file: null,
  link: "",
  title: "",
  artist: "",
  moods: [],
  genre: "",
  bpm: "",
  source: how === "drive" ? "The client's Google Drive" : "",
  sourceUrl: "",
  author: "",
  licence: "cc0-1.0",
  licenceName: LICENCES["cc0-1.0"].name,
  licenceVersion: LICENCES["cc0-1.0"].version,
  licenceUrl: LICENCES["cc0-1.0"].url,
  attribution: "",
  contentId: "unknown",
  contentIdNote: "",
  confirmed: false,
});

function ImportForm({ client, api, onDone, onCancel }: { client: string; api: MusicApi; onDone: (t: MusicTrack) => void; onCancel: () => void }) {
  const [d, setD] = useState<Draft>(() => emptyDraft("upload"));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setD((x) => ({ ...x, [k]: v }));
  const kind = LICENCES[d.licence];
  const pickLicence = (id: LicenceId) => {
    const k = LICENCES[id];
    setD((x) => ({ ...x, licence: id, licenceName: k.name, licenceVersion: k.version, licenceUrl: k.url, attribution: x.attribution || (k.attribution && x.title ? `"${x.title}" by ${x.author || "the author"}, licensed under ${k.name} ${k.version} ${k.url}`.trim() : "") }));
  };
  const submit = async () => {
    setError("");
    const v = validateLicenceForm({ ...d, bpm: d.bpm || null });
    if (!v.ok) return setError(v.reason);
    if (d.how === "upload" && !d.file) return setError("Choose the audio file to upload.");
    if (d.how === "drive" && !d.link.trim()) return setError("Paste the Drive link of the audio file.");
    try {
      setBusy(d.how === "upload" ? "Uploading…" : "Reading from Drive…");
      let duration: number | null = null;
      if (d.file) duration = (await analyse(await d.file.arrayBuffer()).catch(() => null))?.duration ?? null;
      const r = d.how === "upload" ? await api.importUpload(client, v.form, d.file!, duration) : await api.importDrive(client, v.form, d.link.trim());
      onDone(r.track);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy("");
    }
  };
  return (
    <form
      className="ml-import"
      aria-label="Import a track"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="ml-row">
        <span className="ts-group-title">Import a track</span>
        <button type="button" className="ml-icon" onClick={onCancel} aria-label="Close the import form">
          <X size={14} />
        </button>
      </div>
      <div className="ml-seg" role="radiogroup" aria-label="Where the track comes from">
        <button type="button" role="radio" aria-checked={d.how === "upload"} className={d.how === "upload" ? "on" : ""} onClick={() => setD((x) => ({ ...emptyDraft("upload"), ...x, how: "upload", source: x.source === "The client's Google Drive" ? "" : x.source }))}>
          <Upload size={12} /> Upload
        </button>
        <button type="button" role="radio" aria-checked={d.how === "drive"} className={d.how === "drive" ? "on" : ""} onClick={() => setD((x) => ({ ...x, how: "drive", source: x.source || "The client's Google Drive" }))}>
          <HardDrive size={12} /> From Drive
        </button>
      </div>
      {d.how === "upload" ? (
        <label className="ml-field">
          <span>Audio file (mp3, m4a, aac or wav; 25 MB at most)</span>
          <input type="file" accept=".mp3,.m4a,.aac,.wav,audio/mpeg,audio/mp4,audio/aac,audio/wav" onChange={(e) => {
            const f = e.target.files?.[0] ?? null;
            setD((x) => ({ ...x, file: f, title: x.title || (f ? f.name.replace(/\.[a-z0-9]+$/i, "") : "") }));
          }} />
        </label>
      ) : (
        <label className="ml-field">
          <span>Drive link of the audio file (shared with the studio's Google account)</span>
          <input type="url" value={d.link} onChange={(e) => set("link", e.target.value)} placeholder="https://drive.google.com/file/d/…" />
        </label>
      )}
      <label className="ml-field">
        <span>Track name (Arabic or English)</span>
        <input dir="auto" value={d.title} onChange={(e) => set("title", e.target.value)} required />
      </label>
      <div className="ml-two">
        <label className="ml-field">
          <span>Artist</span>
          <input dir="auto" value={d.artist} onChange={(e) => set("artist", e.target.value)} />
        </label>
        <label className="ml-field">
          <span>Genre</span>
          <input dir="auto" value={d.genre} onChange={(e) => set("genre", e.target.value)} />
        </label>
      </div>
      <fieldset className="ml-moods">
        <legend>Moods</legend>
        {MUSIC_MOODS.map((m) => (
          <label key={m.id} className={`ml-chip ${d.moods.includes(m.id) ? "on" : ""}`}>
            <input type="checkbox" checked={d.moods.includes(m.id)} onChange={(e) => set("moods", e.target.checked ? [...d.moods, m.id] : d.moods.filter((x) => x !== m.id))} />
            {m.label}
          </label>
        ))}
      </fieldset>
      <label className="ml-field">
        <span>BPM (optional; measured when you preview the track if empty)</span>
        <input inputMode="numeric" value={d.bpm} onChange={(e) => set("bpm", e.target.value.replace(/[^\d]/g, ""))} />
      </label>
      <span className="ts-group-title">Licence (required)</span>
      <label className="ml-field">
        <span>Source: where the track comes from</span>
        <input dir="auto" value={d.source} onChange={(e) => set("source", e.target.value)} placeholder="e.g. Bought on Artlist, order 1234 · Made for the client by …" required />
      </label>
      <label className="ml-field">
        <span>Source link (the page that states the licence)</span>
        <input type="url" value={d.sourceUrl} onChange={(e) => set("sourceUrl", e.target.value)} />
      </label>
      <label className="ml-field">
        <span>Author or performer</span>
        <input dir="auto" value={d.author} onChange={(e) => set("author", e.target.value)} required />
      </label>
      <label className="ml-field">
        <span>Licence</span>
        <select aria-label="Licence" value={d.licence} onChange={(e) => pickLicence(e.target.value as LicenceId)}>
          {Object.values(LICENCES).map((k) => (
            <option key={k.id} value={k.id}>
              {k.name}
              {k.version ? ` ${k.version}` : ""}
            </option>
          ))}
        </select>
        <small>{kind.note} NonCommercial, NoDerivatives and ShareAlike licences are refused.</small>
      </label>
      <div className="ml-two">
        <label className="ml-field">
          <span>Licence name as the source writes it</span>
          <input value={d.licenceName} onChange={(e) => set("licenceName", e.target.value)} />
        </label>
        <label className="ml-field">
          <span>Version</span>
          <input value={d.licenceVersion} onChange={(e) => set("licenceVersion", e.target.value)} />
        </label>
      </div>
      <label className="ml-field">
        <span>Licence text link</span>
        <input type="url" value={d.licenceUrl} onChange={(e) => set("licenceUrl", e.target.value)} />
      </label>
      <label className="ml-field">
        <span>Attribution text {kind.attribution ? "(required by this licence)" : "(optional)"}</span>
        <textarea dir="auto" rows={3} value={d.attribution} onChange={(e) => set("attribution", e.target.value)} />
      </label>
      <div className="ml-two">
        <label className="ml-field">
          <span>Content ID</span>
          <select aria-label="Content ID" value={d.contentId} onChange={(e) => set("contentId", e.target.value as ContentIdStatus)}>
            <option value="unknown">Unknown</option>
            <option value="registered">Registered</option>
            <option value="not_registered">Not registered</option>
          </select>
        </label>
        <label className="ml-field">
          <span>Content ID notes</span>
          <input dir="auto" value={d.contentIdNote} onChange={(e) => set("contentIdNote", e.target.value)} placeholder="What the source says" />
        </label>
      </div>
      <label className="ml-confirm">
        <input type="checkbox" checked={d.confirmed} onChange={(e) => set("confirmed", e.target.checked)} />
        <span>{LICENCE_CONFIRMATION}</span>
      </label>
      {error && (
        <p className="ts-hint warn" role="alert">
          {error}
        </p>
      )}
      <div className="ml-row">
        <button type="submit" className="ts-btn primary" disabled={!!busy}>
          {busy || "Import the track"}
        </button>
      </div>
    </form>
  );
}

/* ───────────── The panel ───────────── */

export function MusicLibrary({ client, clientName, selectedId = null, onPick, pickLabel = "Use this track", api = musicApi }: MusicLibraryProps) {
  const [tab, setTab] = useState<Tab>("catalog");
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const [mood, setMood] = useState<MusicMood | "">("");
  const [genre, setGenre] = useState("");
  const [durationBand, setDurationBand] = useState("");
  const [bpmBand, setBpmBand] = useState("");
  const [hideTest, setHideTest] = useState(false);
  const [tracks, setTracks] = useState<MusicTrack[]>([]);
  const [genres, setGenres] = useState<string[]>([]);
  const [access, setAccess] = useState<MusicAccess | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const [peaks, setPeaks] = useState<Record<string, number[] | null>>({});
  const [waveBusy, setWaveBusy] = useState("");
  const [importing, setImporting] = useState(false);
  const [reload, setReload] = useState(0);
  const audio = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setQuery(q.trim()), 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const filter: MusicFilter = useMemo(() => {
    const d = DURATION_BANDS.find((b) => b.id === durationBand);
    const b = BPM_BANDS.find((x) => x.id === bpmBand);
    return { q: query || undefined, mood, genre: genre || undefined, minDuration: d?.min, maxDuration: d?.max, minBpm: b?.min, maxBpm: b?.max, includeTest: hideTest ? false : undefined };
  }, [query, mood, genre, durationBand, bpmBand, hideTest]);

  useEffect(() => {
    if (tab === "client" && !client) return;
    let gone = false;
    setLoading(true);
    setError("");
    (tab === "catalog" ? api.catalog(filter) : api.library(client!, filter))
      .then((r) => {
        if (gone) return;
        setTracks(r.tracks);
        setGenres(r.genres);
        setAccess(r.access);
      })
      .catch((e: Error) => !gone && setError(e.message))
      .finally(() => !gone && setLoading(false));
    return () => {
      gone = true;
    };
  }, [api, tab, client, filter, reload]);

  // One audio element for the panel; stopped when the panel goes away.
  useEffect(() => {
    const a = new Audio();
    a.preload = "none";
    const tick = () => setProgress(a.duration ? a.currentTime / a.duration : 0);
    const end = () => setPlaying(null);
    a.addEventListener("timeupdate", tick);
    a.addEventListener("ended", end);
    a.addEventListener("pause", end);
    audio.current = a;
    return () => {
      a.pause();
      a.removeAttribute("src");
      a.removeEventListener("timeupdate", tick);
      a.removeEventListener("ended", end);
      a.removeEventListener("pause", end);
      audio.current = null;
    };
  }, []);

  const loadPeaks = useCallback(
    async (t: MusicTrack) => {
      if (peaks[t.id] !== undefined) return;
      setPeaks((p) => ({ ...p, [t.id]: null }));
      try {
        setWaveBusy("Loading the waveform…");
        const cached = await api.peaks(t);
        if (cached.peaks) return setPeaks((p) => ({ ...p, [t.id]: cached.peaks }));
        setWaveBusy("Drawing the waveform (once for everyone)…");
        const a = await analyse(await api.file(t));
        if (!a) return setWaveBusy("This browser cannot read the track's waveform.");
        const saved = await api.savePeaks(t, a.peaks, t.kind === "library" && t.bpm === null ? a.bpm : null).catch(() => ({ peaks: a.peaks }));
        setPeaks((p) => ({ ...p, [t.id]: saved.peaks }));
      } catch (e) {
        setWaveBusy((e as Error).message);
      } finally {
        setWaveBusy((s) => (s.startsWith("Loading") || s.startsWith("Drawing") ? "" : s));
      }
    },
    [api, peaks],
  );

  const toggle = (t: MusicTrack) => {
    const a = audio.current;
    if (!a) return;
    setOpen(t.id);
    void loadPeaks(t);
    if (playing === t.id) {
      a.pause();
      return;
    }
    if (a.dataset.track !== t.id) {
      a.src = t.url;
      a.dataset.track = t.id;
      setProgress(0);
    }
    a.play()
      .then(() => setPlaying(t.id))
      .catch((e: Error) => setError(`The preview could not play: ${e.message}`));
  };

  const seek = (t: MusicTrack, fraction: number) => {
    const a = audio.current;
    if (!a) return;
    if (a.dataset.track !== t.id) {
      a.src = t.url;
      a.dataset.track = t.id;
    }
    const go = () => {
      a.currentTime = fraction * (a.duration || t.duration);
      setProgress(fraction);
      void a.play().then(() => setPlaying(t.id)).catch(() => undefined);
    };
    if (a.readyState >= 1) go();
    else a.addEventListener("loadedmetadata", go, { once: true });
    if (a.readyState < 1) a.load();
  };

  const select = (t: MusicTrack) => {
    setOpen(t.id === open ? null : t.id);
    if (t.id !== open) void loadPeaks(t);
  };

  const canImport = !!access?.admin && !!access?.enabled && !!client;

  return (
    <section className="ml" aria-label="Music library">
      <div className="ml-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === "catalog"} className={tab === "catalog" ? "on" : ""} onClick={() => setTab("catalog")}>
          Catalog
        </button>
        <button type="button" role="tab" aria-selected={tab === "client"} className={tab === "client" ? "on" : ""} disabled={!client} onClick={() => setTab("client")} title={client ? undefined : "Open a client's month to see its tracks"}>
          {clientName ? <bdi>{clientName}</bdi> : "Client"} tracks
        </button>
      </div>

      <div className="ml-filters">
        <label className="ml-search">
          <Search size={13} aria-hidden />
          <input dir="auto" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tracks, artists, moods" aria-label="Search tracks" />
        </label>
        <div className="ml-chips" role="group" aria-label="Mood">
          <button type="button" className={`ml-chip ${mood === "" ? "on" : ""}`} onClick={() => setMood("")}>
            All moods
          </button>
          {MUSIC_MOODS.map((m) => (
            <button key={m.id} type="button" className={`ml-chip ${mood === m.id ? "on" : ""}`} aria-pressed={mood === m.id} onClick={() => setMood(mood === m.id ? "" : m.id)}>
              {m.label}
            </button>
          ))}
        </div>
        <div className="ml-selects">
          <select aria-label="Genre" value={genre} onChange={(e) => setGenre(e.target.value)}>
            <option value="">Any genre</option>
            {genres.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
          <select aria-label="Duration" value={durationBand} onChange={(e) => setDurationBand(e.target.value)}>
            <option value="">Any length</option>
            {DURATION_BANDS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
          <select aria-label="Tempo" value={bpmBand} onChange={(e) => setBpmBand(e.target.value)}>
            <option value="">Any tempo</option>
            {BPM_BANDS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </div>
        {tab === "catalog" && (
          <label className="ml-check">
            <input type="checkbox" checked={hideTest} onChange={(e) => setHideTest(e.target.checked)} /> Hide test audio
          </label>
        )}
      </div>

      {tab === "client" && client && (
        <div className="ml-import-bar">
          {canImport ? (
            !importing && (
              <button type="button" className="ts-btn" onClick={() => setImporting(true)}>
                <Upload size={13} /> Import a track
              </button>
            )
          ) : (
            <p className="ts-hint">{access?.reason || "Only admins can import tracks for now."}</p>
          )}
          {importing && canImport && (
            <ImportForm
              client={client}
              api={api}
              onCancel={() => setImporting(false)}
              onDone={(t) => {
                setImporting(false);
                setReload((n) => n + 1);
                setOpen(t.id);
                void loadPeaks(t);
              }}
            />
          )}
        </div>
      )}

      {error && (
        <p className="ts-hint warn" role="alert">
          {error}
        </p>
      )}
      <p className="ml-count" aria-live="polite">
        {loading ? "Loading…" : `${tracks.length} track${tracks.length === 1 ? "" : "s"}`}
      </p>

      <ul className="ml-list">
        {tracks.map((t) => {
          const isOpen = open === t.id;
          return (
            <li key={t.id} className={`ml-track ${isOpen ? "open" : ""} ${selectedId === t.id ? "selected" : ""}`} data-testid="track">
              <div className="ml-track-head">
                <button type="button" className="ml-play" onClick={() => toggle(t)} aria-label={playing === t.id ? `Pause ${t.title}` : `Play ${t.title}`}>
                  {playing === t.id ? <Pause size={14} /> : <Play size={14} />}
                </button>
                <button type="button" className="ml-track-main" onClick={() => select(t)} aria-expanded={isOpen}>
                  <span className="ml-title" dir="auto">
                    {t.title}
                  </span>
                  <span className="ml-meta">
                    <bdi>{t.artist}</bdi> · {fmtTime(t.duration)} · {t.bpm ? `${t.bpm} BPM` : "BPM —"}
                    {t.genre ? (
                      <>
                        {" "}
                        · <bdi>{t.genre}</bdi>
                      </>
                    ) : null}
                  </span>
                  <span className="ml-tags">
                    {t.test && <span className="ml-tag test">Test audio</span>}
                    <span className="ml-tag">{licenceTag(t)}</span>
                    {t.moods.slice(0, 3).map((m) => (
                      <span key={m} className="ml-tag mood">
                        {MUSIC_MOODS.find((x) => x.id === m)?.label ?? m}
                      </span>
                    ))}
                  </span>
                </button>
              </div>
              {isOpen && (
                <div className="ml-detail">
                  <Waveform peaks={peaks[t.id] ?? null} progress={audio.current?.dataset.track === t.id ? progress : 0} onSeek={(f) => seek(t, f)} busy={waveBusy} />
                  {t.test && <p className="ts-hint warn">Test audio made by the studio for trying the editor. Not for a client's video.</p>}
                  <LicenceBlock track={t} />
                  <div className="ml-row">
                    <button type="button" className="ts-btn primary" onClick={() => onPick({ track: t, fileUrl: t.url, credit: creditLine(t), pickedAt: Date.now() })}>
                      <Music size={13} /> {selectedId === t.id ? "In use" : pickLabel}
                    </button>
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {!loading && !tracks.length && !error && <p className="ts-hint">{tab === "client" ? "No tracks for this client yet." : "No track matches these filters."}</p>}
    </section>
  );
}

export default MusicLibrary;
