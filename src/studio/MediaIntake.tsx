/**
 * The selection dialog of the Start screen's two direct routes, "Edit images" and "Create or edit
 * video": the client's Drive (its approved folders, with thumbnails) and files from this computer
 * in one tray, removable, in the order picked. Confirming copies each file into the month (Drive
 * stays as it is) and makes one card per file; the Studio then opens on them. Nothing is
 * generated. When the client or the month is not chosen yet, the dialog asks for those two only.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, Clapperboard, FolderOpen, HardDrive, ImageIcon, Search, Upload, X, Zap } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AutoplayVideo } from "@/components/AutoplayVideo";
import { Orb } from "@/components/Orb";
import { DRIVE_ROLE_LABELS, DRIVE_ROLES, type DrivePhoto, type DriveRole } from "@shared/drive";
import { monthLabel } from "@shared/posts";
import { DemoLabel, photoUrl, useDriveListing } from "./DrivePicker";
import { isImageFile, isVideoFile, sendTray, type IntakeAnswer, type MediaRoute, type TrayItem } from "./mediaApi";
import "./media-intake.css";

const IMAGE_MAX = 20 * 1024 * 1024;
const VIDEO_MAX = 60 * 1024 * 1024;
const TRAY_MAX = 60;

export const ROUTE_TEXT: Record<MediaRoute, { title: string; lead: string; accept: string; what: string }> = {
  images: {
    title: "Edit images",
    lead: "Choose one or more pictures. Each becomes its own card in the Studio, ready for the Photo studio, the Text studio and styles.",
    accept: "image/png,image/jpeg,image/webp",
    what: "pictures",
  },
  video: {
    title: "Create or edit video",
    lead: "Choose pictures and clips. Each becomes its own card first; then pick the cards to combine into one video in the Video editor.",
    accept: "image/png,image/jpeg,image/webp,video/mp4,video/quicktime",
    what: "pictures and clips",
  },
};

export interface MediaIntakeProps {
  open: boolean;
  route: MediaRoute;
  /** The tab it opens on; "upload" with `initialFiles` when the card's Upload button picked them. */
  startTab: "drive" | "upload";
  initialFiles?: File[];
  clients: { id: string; name: string }[];
  /** The current client and month (either may be missing: the dialog then asks for it). */
  clientId: string | null;
  month: string;
  batchId: string | null;
  /** The month's posts now (the new cards come after them). */
  posts: number;
  admin: boolean;
  /** The current month, made with the workspace's settings when it does not exist yet. */
  ensurePlan?: () => Promise<string>;
  onClose: () => void;
  onDone: (answer: IntakeAnswer, dest: { client: string; month: string }) => void | Promise<void>;
}

let seq = 0;
const nextKey = () => `t${++seq}`;

export default function MediaIntake(p: MediaIntakeProps) {
  const text = ROUTE_TEXT[p.route];
  const [client, setClient] = useState(p.clientId ?? "");
  const [month, setMonth] = useState(p.month);
  const askDest = !p.clientId || !/^\d{4}-\d{2}$/.test(p.month);
  const [tab, setTab] = useState<"drive" | "upload">(p.startTab);
  const [tray, setTray] = useState<TrayItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const clientName = p.clients.find((c) => c.id === client)?.name ?? "";

  useEffect(() => {
    if (!p.open) return;
    setClient(p.clientId ?? "");
    setMonth(p.month);
    setTab(p.startTab);
    setTray([]);
    setBusy(null);
    if (p.initialFiles?.length) addFiles(p.initialFiles);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.open]);
  // Object URLs of the computer's files are let go when the dialog closes.
  const trayRef = useRef(tray);
  trayRef.current = tray;
  useEffect(() => {
    if (p.open) return;
    for (const it of trayRef.current) if (it.from === "upload") URL.revokeObjectURL(it.preview);
  }, [p.open]);

  function addFiles(files: File[]) {
    const out: TrayItem[] = [];
    const refused: string[] = [];
    for (const f of files) {
      const video = isVideoFile(f);
      if (video && p.route === "images") {
        refused.push(`${f.name}: a clip (use Create or edit video)`);
        continue;
      }
      if (!video && !isImageFile(f)) {
        refused.push(`${f.name}: pictures must be PNG, JPEG or WebP${p.route === "video" ? ", clips MP4" : ""}`);
        continue;
      }
      if (video && !/^video\/(mp4|quicktime)$/i.test(f.type) && !/\.(mp4|mov|m4v)$/i.test(f.name)) {
        refused.push(`${f.name}: clips must be MP4`);
        continue;
      }
      if (f.size > (video ? VIDEO_MAX : IMAGE_MAX)) {
        refused.push(`${f.name}: larger than ${video ? 60 : 20} MB`);
        continue;
      }
      out.push({ key: nextKey(), from: "upload", file: f, name: f.name, video, preview: URL.createObjectURL(f) });
    }
    if (refused.length) toast.error(`Not added: ${refused.slice(0, 3).join("; ")}${refused.length > 3 ? ` and ${refused.length - 3} more` : ""}.`);
    if (out.length) setTray((t) => [...t, ...out].slice(0, TRAY_MAX));
  }

  function toggleDrive(ph: DrivePhoto) {
    setTray((t) => (t.some((x) => x.from === "drive" && x.id === ph.id) ? t.filter((x) => !(x.from === "drive" && x.id === ph.id)) : [...t, { key: nextKey(), from: "drive" as const, id: ph.id, name: ph.file, video: !!ph.video }].slice(0, TRAY_MAX)));
  }

  function remove(key: string) {
    setTray((t) => {
      const it = t.find((x) => x.key === key);
      if (it?.from === "upload") URL.revokeObjectURL(it.preview);
      return t.filter((x) => x.key !== key);
    });
  }

  const ready = !!client && /^\d{4}-\d{2}$/.test(month) && tray.length > 0 && !busy;
  async function confirm() {
    if (!ready) return;
    setBusy("Getting the month ready…");
    try {
      const same = client === p.clientId && month === p.month;
      // The month the workspace is on is made with its own settings; another month is found or made by the server.
      const batch = same ? (p.batchId ?? (p.ensurePlan ? await p.ensurePlan() : null)) : null;
      const answer = await sendTray(p.route, { batch, client, month }, tray, (_done, _of, phase) => phase && setBusy(phase));
      await p.onDone(answer, { client, month });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const images = tray.filter((x) => !x.video).length;
  const clips = tray.length - images;
  const count = `${tray.length} card${tray.length === 1 ? "" : "s"}`;

  return (
    <Dialog open={p.open} onOpenChange={(o) => !o && !busy && p.onClose()}>
      <DialogContent className="media-dialog" aria-describedby="media-dialog-desc">
        <DialogHeader>
          <DialogTitle className="media-title">
            <span className="media-tag">
              <Zap size={12} /> Direct to Studio
            </span>
            {text.title}
          </DialogTitle>
          <DialogDescription id="media-dialog-desc">{text.lead}</DialogDescription>
        </DialogHeader>

        {askDest ? (
          <div className="media-dest ask" role="group" aria-label="Where the cards go">
            <label>
              <span>Client</span>
              <select value={client} onChange={(e) => setClient(e.target.value)} aria-label="Client">
                <option value="">Choose the client…</option>
                {p.clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Month</span>
              <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} aria-label="Month" />
            </label>
            <small className="flow-muted">The cards are added to this client's month; nothing else is asked.</small>
          </div>
        ) : (
          <p className="media-dest">
            Adds to <b>{clientName}</b> · <b>{monthLabel(month)}</b>
            {p.posts ? `, after its ${p.posts} post${p.posts === 1 ? "" : "s"} (none of them changes)` : ", as its first cards"}.
          </p>
        )}

        <div className="media-tabs" role="tablist" aria-label="Where the files come from">
          <button type="button" role="tab" aria-selected={tab === "drive"} className={`media-tab ${tab === "drive" ? "on" : ""}`} onClick={() => setTab("drive")}>
            <HardDrive size={15} /> Client's Drive
          </button>
          <button type="button" role="tab" aria-selected={tab === "upload"} className={`media-tab ${tab === "upload" ? "on" : ""}`} onClick={() => setTab("upload")}>
            <Upload size={15} /> This computer
          </button>
        </div>

        <div className="media-source">
          {tab === "drive" ? (
            client ? (
              <DriveGrid clientId={client} clientName={clientName} route={p.route} picked={new Set(tray.flatMap((x) => (x.from === "drive" ? [x.id] : [])))} onToggle={toggleDrive} />
            ) : (
              <p className="flow-muted media-empty">Choose the client first: its Drive folders are listed here.</p>
            )
          ) : (
            <div
              className={`media-drop ${dragging ? "over" : ""}`}
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                addFiles(Array.from(e.dataTransfer.files));
              }}
            >
              <Upload size={22} />
              <b>Drop {text.what} here</b>
              <span className="flow-muted">
                {p.route === "video" ? "PNG, JPEG or WebP up to 20 MB; MP4 clips up to 60 MB" : "PNG, JPEG or WebP, up to 20 MB each"}
              </span>
              <button type="button" className="cta secondary small" onClick={() => fileInput.current?.click()}>
                <Upload size={14} /> Upload files
              </button>
              <input
                ref={fileInput}
                type="file"
                multiple
                hidden
                accept={text.accept}
                onChange={(e) => {
                  addFiles(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />
            </div>
          )}
        </div>

        <section className="media-tray" aria-label="Selected files">
          <div className="media-tray-head">
            <b>Selected · {tray.length}</b>
            <span className="flow-muted">
              {tray.length ? `${images} picture${images === 1 ? "" : "s"}${p.route === "video" ? ` · ${clips} clip${clips === 1 ? "" : "s"}` : ""} · from Drive and this computer, in this order` : "Nothing picked yet: pick from the Drive, this computer, or both."}
            </span>
            {tray.length > 0 && (
              <button type="button" className="text-button" onClick={() => setTray([])} disabled={!!busy}>
                Clear
              </button>
            )}
          </div>
          {tray.length > 0 && (
            <ol className="media-tray-list">
              {tray.map((it, i) => (
                <li key={it.key} className="media-tray-item" title={it.name}>
                  <span className="media-tray-n">{i + 1}</span>
                  {it.from === "drive" ? (
                    <img src={photoUrl(it.id, 160)} alt="" />
                  ) : it.video ? (
                    <AutoplayVideo src={it.preview} mode="preview" bare label={it.name} className="media-tray-video" />
                  ) : (
                    <img src={it.preview} alt="" />
                  )}
                  <span className={`media-src ${it.from}`}>{it.from === "drive" ? "Drive" : "Computer"}</span>
                  {it.video && (
                    <span className="media-kind">
                      <Clapperboard size={11} />
                    </span>
                  )}
                  <button type="button" className="media-tray-x" aria-label={`Remove ${it.name}`} onClick={() => remove(it.key)} disabled={!!busy}>
                    <X size={12} />
                  </button>
                </li>
              ))}
            </ol>
          )}
        </section>

        <footer className="media-foot">
          <small className="flow-muted">Each file is copied into the month; the Drive originals stay as they are. Nothing is generated and nothing costs money here.</small>
          <button type="button" className="cta secondary" onClick={p.onClose} disabled={!!busy}>
            Cancel
          </button>
          <button type="button" className="cta primary" onClick={() => void confirm()} disabled={!ready} aria-busy={!!busy}>
            {busy ? <Orb size={15} /> : <Check size={16} />} {busy ?? (tray.length ? `Create ${count} and open the Studio` : "Create the cards")}
          </button>
        </footer>
      </DialogContent>
    </Dialog>
  );
}

/** The client's Drive as thumbnails, by role and folder, searchable; videos are only for the video route. */
function DriveGrid({ clientId, clientName, route, picked, onToggle }: { clientId: string; clientName: string; route: MediaRoute; picked: Set<string>; onToggle: (p: DrivePhoto) => void }) {
  const { state, load } = useDriveListing(clientId, true);
  const [role, setRole] = useState<DriveRole | "all">("all");
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(60);
  const [kind, setKind] = useState<"all" | "pictures" | "clips">("all");
  const everything = useMemo(() => state?.photos ?? [], [state]);
  // Edit images lists pictures only: a Drive with hundreds of clips first would bury every picture behind them.
  const photos = useMemo(() => (route === "images" ? everything.filter((ph) => !ph.video) : everything), [everything, route]);
  const clipsLeftOut = everything.length - photos.length;
  const clipCount = photos.filter((ph) => ph.video).length;
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return photos.filter(
      (ph) =>
        (role === "all" || (ph.role ?? "product") === role) &&
        (kind === "all" || (kind === "clips") === !!ph.video) &&
        (!needle || `${ph.name} ${ph.file} ${ph.folder}`.toLowerCase().includes(needle)),
    );
  }, [photos, role, kind, q]);
  if (!state)
    return (
      <div className="journey-reading">
        <Orb size={16} /> Opening {clientName || "the client"}'s Drive…
      </div>
    );
  if (state.error || (!state.demo && !photos.length))
    return (
      <div className="media-empty">
        <p className="flow-muted">{state.error ?? (clipsLeftOut ? `${clientName}'s Drive folders hold clips only (${clipsLeftOut}): use Create or edit video for them.` : `No pictures in ${clientName}'s Drive folders yet.`)}</p>
        <p className="flow-muted">Connect or approve the folders from the Studio's Drive picker (Products → Drive); files from this computer work meanwhile.</p>
        <button type="button" className="text-button" onClick={() => load(true)}>
          Read the Drive again
        </button>
      </div>
    );
  const roles = DRIVE_ROLES.filter((r) => photos.some((ph) => (ph.role ?? "product") === r));
  return (
    <div className="media-drive">
      <div className="media-drive-bar">
        <div className="media-chips" role="group" aria-label="Folders by role">
          <button type="button" className={`media-chip ${role === "all" ? "on" : ""}`} onClick={() => setRole("all")}>
            All <small>{photos.length}</small>
          </button>
          {roles.map((r) => (
            <button key={r} type="button" className={`media-chip ${role === r ? "on" : ""}`} onClick={() => setRole(r)}>
              {DRIVE_ROLE_LABELS[r]} <small>{photos.filter((ph) => (ph.role ?? "product") === r).length}</small>
            </button>
          ))}
        </div>
        {clipCount > 0 && clipCount < photos.length && (
          <div className="media-chips" role="group" aria-label="Pictures or clips">
            {(["all", "pictures", "clips"] as const).map((k) => (
              <button key={k} type="button" className={`media-chip ${kind === k ? "on" : ""}`} onClick={() => setKind(k)}>
                {k === "all" ? "Both" : k === "pictures" ? "Pictures" : "Clips"} <small>{k === "all" ? photos.length : k === "clips" ? clipCount : photos.length - clipCount}</small>
              </button>
            ))}
          </div>
        )}
        <label className="media-search">
          <Search size={14} />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search names and folders" aria-label="Search the Drive" />
        </label>
        <DemoLabel on={state.demo} />
      </div>
      {list.length ? (
        <div className="media-grid">
          {list.slice(0, shown).map((ph) => {
            const blocked = ph.video ? (route === "images" ? "A clip: use Create or edit video" : "") : "";
            const on = picked.has(ph.id);
            return (
              <button key={ph.id} type="button" className={`media-thumb ${on ? "on" : ""}`} disabled={!!blocked} aria-pressed={on} title={blocked || `${ph.folder ? `${ph.folder} / ` : ""}${ph.file}`} onClick={() => onToggle(ph)}>
                <span className="media-thumb-pic">
                  <img src={photoUrl(ph.id, 320)} alt="" loading="lazy" />
                </span>
                <span className="media-thumb-name">{ph.name}</span>
                {ph.video && (
                  <span className="media-kind">
                    <Clapperboard size={11} /> Clip
                  </span>
                )}
                {on && (
                  <span className="media-check">
                    <Check size={12} />
                  </span>
                )}
                {blocked && <span className="media-blocked">{blocked}</span>}
              </button>
            );
          })}
        </div>
      ) : (
        <p className="flow-muted media-empty">
          <FolderOpen size={14} /> Nothing here{q ? ` for “${q}”` : ""}.
        </p>
      )}
      {list.length > shown && (
        <button type="button" className="text-button" onClick={() => setShown((n) => n + 60)}>
          Show more ({list.length - shown} left)
        </button>
      )}
      {route === "images" && clipsLeftOut > 0 && (
        <small className="flow-muted">
          <ImageIcon size={12} /> {clipsLeftOut} clip{clipsLeftOut === 1 ? "" : "s"} in the Drive {clipsLeftOut === 1 ? "is" : "are"} left out here: Create or edit video takes them.
        </small>
      )}
    </div>
  );
}
