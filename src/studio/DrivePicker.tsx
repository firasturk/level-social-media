import { useCallback, useEffect, useMemo, useState } from "react";
import { Check, Copy, FolderOpen, LoaderCircle, RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { get, post, put } from "@/api";
import { DRIVE_KINDS, DRIVE_KIND_LABELS, type DriveKind, type DrivePhoto, type DrivePick, type DriveSkipped } from "@shared/drive";

interface DriveState {
  link: string;
  email: string | null;
  folder: string | null;
  photos: DrivePhoto[];
  /** Files it does not read (videos, RAW files…), by folder. */
  skipped?: DriveSkipped[];
  error?: string;
}

const photoUrl = (id: string, size: number) => `/api/studio/drive/photo/${encodeURIComponent(id)}?size=${size}`;
/** The first folder under the client's folder: the chips the photos are sorted by. */
const topOf = (p: DrivePhoto) => p.folder.split(" / ")[0] ?? "";
const PAGE = 120;

/**
 * The client's Google Drive folder: shared once with the studio's Google account, then the team
 * browses its photos by folder, or lets the vision model pick the best product photos, and adds
 * them to the month.
 */
export default function DrivePicker({
  open,
  onClose,
  client,
  count,
  batchId,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  client: { id: string; name: string };
  /** How many photos "Pick for me" asks for. */
  count: number;
  batchId: string | null;
  /** The chosen photos joined the month. */
  onAdded: () => Promise<void>;
}) {
  const [state, setState] = useState<DriveState | null>(null);
  const [link, setLink] = useState("");
  const [saving, setSaving] = useState(false);
  const [top, setTop] = useState("");
  /** What the photos show, as vision read them: products, the shop, the kitchen… */
  const [kind, setKind] = useState<DriveKind | "">("");
  const [shown, setShown] = useState(PAGE);
  const [picked, setPicked] = useState<string[]>([]);
  const [ai, setAi] = useState<Map<string, DrivePick>>(new Map());
  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState(0);

  const load = useCallback(
    (fresh = false) => {
      setState(null);
      get<DriveState>(`/api/studio/drive/${encodeURIComponent(client.id)}${fresh ? "?fresh=1" : ""}`)
        .then((r) => {
          setState(r);
          setLink(r.link);
        })
        .catch((e) => setState({ link: "", email: null, folder: null, photos: [], error: (e as Error).message }));
    },
    [client.id],
  );
  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const photos = useMemo(() => state?.photos ?? [], [state]);
  const tops = useMemo(() => [...new Set(photos.map(topOf))].sort((a, b) => a.localeCompare(b)), [photos]);
  const inFolder = photos.filter((p) => !top || topOf(p) === top);
  const kinds = DRIVE_KINDS.filter((k) => inFolder.some((p) => p.kind === k));
  const unread = inFolder.filter((p) => !p.kind).length;
  const list = inFolder.filter((p) => !kind || !kinds.includes(kind) || p.kind === kind);
  const byId = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos]);

  async function saveLink() {
    setSaving(true);
    try {
      const r = await put<{ folder: string; narrowed: boolean }>(`/api/studio/drive/${encodeURIComponent(client.id)}`, { link });
      if (r.narrowed) toast.success(`That folder holds every client: ${client.name} reads only its own folder, "${r.folder}".`);
      load(true);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  /** One shared folder of all the clients: each client gets the folder named after it. */
  async function connectAll() {
    setSaving(true);
    try {
      const r = await post<{ connected: { client: string; folder: string }[]; missing: string[] }>("/api/studio/drive/all", { link });
      toast.success(
        `${r.connected.length} client${r.connected.length === 1 ? "" : "s"} connected (${r.connected.map((x) => x.client).join(", ") || "none"}).${r.missing.length ? ` No folder named after ${r.missing.join(", ")}.` : ""}`,
      );
      load(true);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function pickForMe() {
    setPicking(true);
    try {
      const r = await post<{ picks: DrivePick[]; looked: number; of: number }>(`/api/studio/drive/${encodeURIComponent(client.id)}/pick`, { count, folder: top });
      setAi(new Map(r.picks.map((x) => [x.id, x])));
      setPicked(r.picks.map((x) => x.id));
      toast.success(`Looked at ${r.looked} of ${r.of} photos and picked ${r.picks.length}.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPicking(false);
    }
  }

  async function add() {
    if (!batchId) return;
    setAdding(1);
    try {
      const photos = picked.flatMap((id) => {
        const p = byId.get(id);
        return p ? [{ id, name: ai.get(id)?.product || p.name }] : [];
      });
      const r = await post<{ added: string[]; failed: string[] }>("/api/studio/posts/products/drive", { batch: batchId, photos });
      for (const f of r.failed) toast.error(f);
      if (r.added.length) {
        toast.success(`${r.added.length} photo${r.added.length > 1 ? "s" : ""} added from Drive.`);
        await onAdded();
        setPicked([]);
        setAi(new Map());
        onClose();
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setAdding(0);
    }
  }

  const needsLink = state && (!state.link || !state.folder);
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !adding && onClose()}>
      <DialogContent className="drive-dialog">
        <DialogHeader>
          <DialogTitle>{client.name}'s Google Drive</DialogTitle>
          <DialogDescription>
            {state?.folder
              ? `${state.folder} · ${photos.length} photo${photos.length === 1 ? "" : "s"}. Pick them yourself, or let the AI pick the best ${count}.`
              : "Connect the client's Drive folder once: the studio reads its photos and picks the best ones for the month."}
          </DialogDescription>
        </DialogHeader>

        {!state ? (
          <div className="journey-reading">
            <LoaderCircle className="spinning" size={16} /> Opening the Drive folder…
          </div>
        ) : needsLink ? (
          <div className="drive-connect">
            {state.error && <p className="drive-error">{state.error}</p>}
            <ol className="meta-steps">
              <li>
                In Google Drive, share the client's folder (or the folder above all the clients) with this account as <strong>Viewer</strong>:
                {state.email ? (
                  <span className="drive-email">
                    <code>{state.email}</code>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => void navigator.clipboard.writeText(state.email!).then(() => toast.success("Copied."))}
                    >
                      <Copy size={13} /> Copy
                    </button>
                  </span>
                ) : (
                  <span> connect the Google Cloud service account in Connection first.</span>
                )}
              </li>
              <li>Open the client's folder in Drive, copy the address from the browser and paste it here.</li>
            </ol>
            <div className="footer-actions">
              <input value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://drive.google.com/drive/folders/…" dir="ltr" aria-label="Drive folder link" />
              <button type="button" className="primary" onClick={() => void saveLink()} disabled={saving || !link.trim()}>
                {saving ? <LoaderCircle className="spinning" size={16} /> : <FolderOpen size={16} />} Connect
              </button>
            </div>
            <button type="button" className="text-button drive-all" onClick={() => void connectAll()} disabled={saving || !link.trim()} title="For a folder that holds every client's folder">
              Connect every client from this folder (each one gets the folder with its name)
            </button>
          </div>
        ) : (
          <>
            <div className="drive-bar">
              <div className="journey-filter">
                <button type="button" className={`journey-chip small ${!top ? "active" : ""}`} onClick={() => (setTop(""), setShown(PAGE))}>
                  All · {photos.length}
                </button>
                {tops.map((t) => (
                  <button key={t || "-"} type="button" className={`journey-chip small ${top === t ? "active" : ""}`} onClick={() => (setTop(t), setShown(PAGE))}>
                    {t || "Top folder"} · {photos.filter((p) => topOf(p) === t).length}
                  </button>
                ))}
              </div>
              {kinds.length > 0 && (
                <div className="journey-filter drive-kinds" aria-label="What the photos show">
                  {kinds.map((k) => (
                    <button key={k} type="button" className={`journey-chip small ${kind === k ? "active" : ""}`} onClick={() => (setKind(kind === k ? "" : k), setShown(PAGE))}>
                      {DRIVE_KIND_LABELS[k]} · {inFolder.filter((p) => p.kind === k).length}
                    </button>
                  ))}
                  {unread > 0 && <span className="field-hint">{unread} still being read</span>}
                </div>
              )}
              <span className="drive-tools">
                <button type="button" className="text-button" onClick={() => load(true)} title="Read the folder again">
                  <RefreshCw size={13} /> Refresh
                </button>
                <button type="button" className="text-button" onClick={() => setState({ ...state, folder: null })}>
                  <FolderOpen size={13} /> Change folder
                </button>
              </span>
            </div>
            {!!state.skipped?.length && (
              <p className="field-hint drive-skipped">
                Not read (only JPEG, PNG, WebP, HEIC and TIFF photos are):{" "}
                {state.skipped
                  .slice(0, 6)
                  .map((x) => `${x.folder || "top folder"}: ${x.n} ${x.what}`)
                  .join(" · ")}
              </p>
            )}
            {list.length ? (
              <div className="drive-grid">
                {list.slice(0, shown).map((p) => {
                  const on = picked.includes(p.id);
                  const why = ai.get(p.id);
                  return (
                    <button
                      key={p.id}
                      type="button"
                      className={`journey-thumb pick ${on ? "on" : ""}`}
                      onClick={() => setPicked((l) => (on ? l.filter((x) => x !== p.id) : [...l, p.id]))}
                      title={why ? `${why.product}: ${why.reason}` : [p.kind ? DRIVE_KIND_LABELS[p.kind] : "", p.note, `${p.folder ? `${p.folder} / ` : ""}${p.file}`].filter(Boolean).join("\n")}
                    >
                      <img src={photoUrl(p.id, 320)} alt="" loading="lazy" />
                      <figcaption>{why?.product || p.name}</figcaption>
                      {why && <span className="journey-tag drive-ai">AI pick</span>}
                      {p.video && <span className="journey-tag drive-video">Video frame</span>}
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
              <p className="field-hint">No photos in this folder.</p>
            )}
            {list.length > shown && (
              <button type="button" className="secondary drive-more" onClick={() => setShown((n) => n + PAGE)}>
                Show more ({list.length - shown} left)
              </button>
            )}
            <div className="footer-actions drive-actions">
              <button type="button" className="secondary" onClick={() => void pickForMe()} disabled={picking || !!adding || !list.length}>
                {picking ? <LoaderCircle className="spinning" size={16} /> : <Sparkles size={16} />}
                {picking ? "Looking at the photos…" : `Pick the best ${count} for me${top ? ` in ${top}` : ""}`}
              </button>
              <button type="button" className="primary" onClick={() => void add()} disabled={!picked.length || !!adding || !batchId}>
                {adding ? <LoaderCircle className="spinning" size={16} /> : <Check size={16} />}
                {adding ? `Adding ${picked.length}…` : `Add ${picked.length || ""} to this month`}
              </button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
