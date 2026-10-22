import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Check,
  Copy,
  FolderOpen,
  FolderPlus,
  Pin,
  RefreshCw,
  Sparkles,
  Trash2,
  Wand2,
} from "lucide-react";
import { openPhotoLab } from "./PhotoLabPanel";
import { Orb } from "@/components/Orb";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { del, get, post, put } from "@/api";
import {
  DRIVE_KINDS,
  DRIVE_KIND_LABELS,
  DRIVE_ROLES,
  DRIVE_ROLE_LABELS,
  type DriveFolder,
  type DriveKind,
  type DriveListing,
  type DrivePhoto,
  type DrivePick,
  type DriveRole,
} from "@shared/drive";
import type { PostReference } from "@shared/posts";
import "./drive.css";

const photoUrl = (id: string, size: number) =>
  `/api/studio/drive/photo/${encodeURIComponent(id)}?size=${size}`;
const driveApi = (client: string, path = "") =>
  `/api/studio/drive/${encodeURIComponent(client)}${path}`;
/** The first folder under the client's folder: the chips the photos are sorted by. */
const topOf = (p: DrivePhoto) => p.folder.split(" / ")[0] ?? "";
const PAGE = 120;

const EMPTY: DriveListing = {
  link: "",
  email: null,
  folder: null,
  folders: [],
  photos: [],
  groups: { product: [], brand: [], reference: [], output: [] },
  missing: [],
  demo: false,
};

/** What each role's photos are for, in a line under the tab. */
const ROLE_NOTES: Record<DriveRole, string> = {
  product: "Photos of the products. These are the only photos a post is built from.",
  brand:
    "Logos, packaging art and brand files. Kept apart from the products; never put in a picture as a product.",
  reference: "Inspiration pictures. Pin one to a post from the post editor; it is never a product.",
  output: "Finished pictures the team exported to Drive.",
};

function useDriveListing(clientId: string, open = true) {
  const [state, setState] = useState<DriveListing | null>(null);
  const load = useCallback(
    (fresh = false) => {
      setState(null);
      get<DriveListing>(driveApi(clientId, fresh ? "?fresh=1" : ""))
        .then((r) => setState({ ...EMPTY, ...r }))
        .catch((e) => setState({ ...EMPTY, error: (e as Error).message }));
    },
    [clientId],
  );
  useEffect(() => {
    if (open) load();
  }, [open, load]);
  return { state, setState, load };
}

/** "Not connected · demo listing": the fixture stands in for Drive on a preview with no credential. */
function DemoLabel({ on }: { on: boolean }) {
  return on ? <span className="drive-demo">Not connected · demo listing</span> : null;
}

/** One photo of the listing: its rendition, its name and kind, and the badges (a copy, an AI pick, a video frame). */
function DriveThumb({
  p,
  on,
  onClick,
  caption,
  why,
  byId,
}: {
  p: DrivePhoto;
  on: boolean;
  onClick: () => void;
  caption?: string;
  why?: DrivePick;
  byId: Map<string, DrivePhoto>;
}) {
  const dup = p.duplicateOf ? byId.get(p.duplicateOf) : undefined;
  const title = why
    ? `${why.product}: ${why.reason}`
    : [
        p.kind ? DRIVE_KIND_LABELS[p.kind] : "",
        p.note,
        `${p.folder ? `${p.folder} / ` : ""}${p.file}`,
        dup ? `Same picture as ${dup.name} (${dup.file})` : "",
      ]
        .filter(Boolean)
        .join("\n");
  return (
    <button
      type="button"
      className={`journey-thumb drive-thumb pick ${on ? "on" : ""}`}
      onClick={onClick}
      title={title}
    >
      {/* A square frame of its own: the picture fills it whether or not it has loaded yet. */}
      <span className="drive-thumb-pic">
        <img src={photoUrl(p.id, 320)} alt="" loading="lazy" />
      </span>
      <figcaption>{caption || p.name}</figcaption>
      <span className="drive-thumb-kind">
        {[p.kind ? DRIVE_KIND_LABELS[p.kind] : "Not read yet", p.note].filter(Boolean).join(" · ")}
      </span>
      {why && <span className="journey-tag drive-ai">AI pick</span>}
      {p.video && <span className="journey-tag drive-video">Video frame</span>}
      {dup && <span className="journey-tag drive-dup">same as {dup.name}</span>}
      {on && (
        <span className="journey-thumb-check">
          <Check size={12} />
        </span>
      )}
    </button>
  );
}

/** A photo the studio knew that Drive no longer gives. */
function MissingThumb({ p }: { p: DrivePhoto }) {
  return (
    <div
      className="journey-thumb drive-thumb drive-thumb-missing"
      title={`${p.reason ?? "Not available in Drive."}\n${p.folder ? `${p.folder} / ` : ""}${p.file}`}
    >
      <span className="drive-thumb-pic drive-thumb-blank">
        <FolderOpen size={18} />
      </span>
      <figcaption>{p.name}</figcaption>
      <span className="drive-thumb-kind">{p.kind ? DRIVE_KIND_LABELS[p.kind] : ""}</span>
      <span className="journey-tag drive-unavailable">Not available in Drive</span>
    </div>
  );
}

/** The client's folders: each with a role, approved or waiting; a new one from its link. */
function DriveFolders({
  clientId,
  folders,
  email,
  onChanged,
}: {
  clientId: string;
  folders: DriveFolder[];
  email: string | null;
  onChanged: () => void;
}) {
  const [link, setLink] = useState("");
  const [role, setRole] = useState<DriveRole>("product");
  const [busy, setBusy] = useState(false);
  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    try {
      await fn();
      if (done) toast.success(done);
      onChanged();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="drive-folders">
      <div className="drive-folders-head">
        <span>Folders</span>
        {email && (
          <span className="field-hint">
            Share each folder with <code>{email}</code> as Viewer.
          </span>
        )}
      </div>
      {folders.map((f) => (
        <div key={f.id} className="drive-folder">
          <span className="drive-folder-name">
            <a href={f.link} target="_blank" rel="noreferrer">
              {f.name || f.id}
            </a>
            {f.default && (
              <span className="journey-tag muted">{f.demo ? "demo" : "profile folder"}</span>
            )}
          </span>
          {f.default ? (
            <span className="field-hint">{DRIVE_ROLE_LABELS[f.role]}</span>
          ) : (
            <select
              value={f.role}
              aria-label="What the folder holds"
              disabled={busy}
              onChange={(e) =>
                void act(() =>
                  put(driveApi(clientId, `/folders/${encodeURIComponent(f.id)}`), {
                    role: e.target.value,
                  }),
                )
              }
            >
              {DRIVE_ROLES.map((r) => (
                <option key={r} value={r}>
                  {DRIVE_ROLE_LABELS[r]}
                </option>
              ))}
            </select>
          )}
          {f.default ? (
            <span />
          ) : (
            <button
              type="button"
              className={`drive-approve ${f.approved ? "on" : ""}`}
              disabled={busy}
              onClick={() =>
                void act(
                  () =>
                    put(driveApi(clientId, `/folders/${encodeURIComponent(f.id)}`), {
                      approved: !f.approved,
                    }),
                  f.approved ? "Folder no longer read." : "Folder approved: its photos are read.",
                )
              }
              title={
                f.approved
                  ? "Approved: the studio reads this folder. Click to stop."
                  : "Waiting: approve it so the studio reads it."
              }
            >
              <Check size={12} /> {f.approved ? "Approved" : "Approve"}
            </button>
          )}
          {f.default ? (
            <span />
          ) : (
            <button
              type="button"
              className="text-button"
              disabled={busy}
              title="Take this folder off the client"
              onClick={() =>
                void act(
                  () => del(driveApi(clientId, `/folders/${encodeURIComponent(f.id)}`)),
                  "Folder removed.",
                )
              }
            >
              <Trash2 size={13} />
            </button>
          )}
        </div>
      ))}
      <div className="drive-add">
        <input
          value={link}
          onChange={(e) => setLink(e.target.value)}
          placeholder="https://drive.google.com/drive/folders/…"
          dir="ltr"
          aria-label="Drive folder link"
        />
        <select
          value={role}
          aria-label="What the new folder holds"
          onChange={(e) => setRole(e.target.value as DriveRole)}
        >
          {DRIVE_ROLES.map((r) => (
            <option key={r} value={r}>
              {DRIVE_ROLE_LABELS[r]}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="secondary"
          disabled={busy || !link.trim()}
          onClick={() =>
            void act(async () => {
              await post(driveApi(clientId, "/folders"), { link, role, approved: true });
              setLink("");
            }, "Folder added and approved.")
          }
        >
          {busy ? <Orb size={16} /> : <FolderPlus size={16} />} Add
        </button>
      </div>
    </div>
  );
}

/**
 * The client's Google Drive: its approved folders by role, shared once with the studio's Google
 * account, then the team browses the photos by tab and folder, or lets the vision model pick the
 * best product photos, and adds them to the month. Only product photos join a month as products.
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
  const { state, setState, load } = useDriveListing(client.id, open);
  const [link, setLink] = useState("");
  const [saving, setSaving] = useState(false);
  const [tab, setTab] = useState<DriveRole>("product");
  const [top, setTop] = useState("");
  /** What the photos show, as vision read them: products, the shop, the kitchen… */
  const [kind, setKind] = useState<DriveKind | "">("");
  const [shown, setShown] = useState(PAGE);
  const [picked, setPicked] = useState<string[]>([]);
  const [ai, setAi] = useState<Map<string, DrivePick>>(new Map());
  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState(0);
  const [manage, setManage] = useState(false);

  useEffect(() => {
    if (state) setLink(state.link);
  }, [state]);

  const photos = useMemo(() => state?.photos ?? [], [state]);
  const byId = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos]);
  const inTab = useMemo(() => state?.groups[tab] ?? [], [state, tab]);
  const missingInTab = useMemo(
    () => (state?.missing ?? []).filter((p) => (p.role ?? "product") === tab),
    [state, tab],
  );
  const tops = useMemo(
    () => [...new Set(inTab.map(topOf))].sort((a, b) => a.localeCompare(b)),
    [inTab],
  );
  const inFolder = inTab.filter((p) => !top || topOf(p) === top);
  const kinds = DRIVE_KINDS.filter((k) => inFolder.some((p) => p.kind === k));
  const unread = inFolder.filter((p) => !p.kind).length;
  const list = inFolder.filter((p) => !kind || !kinds.includes(kind) || p.kind === kind);

  function switchTab(r: DriveRole) {
    setTab(r);
    setTop("");
    setKind("");
    setShown(PAGE);
  }

  async function saveLink() {
    setSaving(true);
    try {
      const r = await put<{ folder: string; narrowed: boolean }>(driveApi(client.id), { link });
      if (r.narrowed)
        toast.success(
          `That folder holds every client: ${client.name} reads only its own folder, "${r.folder}".`,
        );
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
      const r = await post<{ connected: { client: string; folder: string }[]; missing: string[] }>(
        "/api/studio/drive/all",
        { link },
      );
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
      const r = await post<{ picks: DrivePick[]; looked: number; of: number }>(
        driveApi(client.id, "/pick"),
        { count, folder: top },
      );
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
      // A copy of a photo already picked is added once, under the first's name.
      const firsts = new Set<string>();
      const chosen = picked.flatMap((id) => {
        const p = byId.get(id);
        if (!p || (p.role ?? "product") !== "product") return [];
        const head = p.duplicateOf ?? p.id;
        if (firsts.has(head)) return [];
        firsts.add(head);
        return [{ id, name: ai.get(id)?.product || p.name }];
      });
      const r = await post<{ added: string[]; failed: string[] }>(
        "/api/studio/posts/products/drive",
        { batch: batchId, photos: chosen },
      );
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

  const needsLink =
    state &&
    !state.demo &&
    !state.folders.some((f) => f.approved) &&
    (!state.link || !state.folder);
  const pickedProducts = picked.filter(
    (id) => (byId.get(id)?.role ?? "product") === "product",
  ).length;
  return (
    <Dialog open={open} onOpenChange={(o) => !o && !adding && onClose()}>
      <DialogContent className="drive-dialog">
        <DialogHeader>
          <DialogTitle>
            {client.name}'s Google Drive <DemoLabel on={!!state?.demo} />
          </DialogTitle>
          <DialogDescription>
            {state?.folder
              ? `${state.folder} · ${photos.length} photo${photos.length === 1 ? "" : "s"} in ${state.folders.filter((f) => f.approved).length} folder${state.folders.filter((f) => f.approved).length === 1 ? "" : "s"}. Pick product photos yourself, or let the AI pick the best ${count}.`
              : "Connect the client's Drive folders once: the studio reads their photos and picks the best product photos for the month."}
          </DialogDescription>
        </DialogHeader>

        {!state ? (
          <div className="journey-reading">
            <Orb size={16} /> Opening the Drive folder…
          </div>
        ) : needsLink ? (
          <div className="drive-connect">
            {state.error && <p className="drive-error">{state.error}</p>}
            <ol className="meta-steps">
              <li>
                In Google Drive, share the client's folder (or the folder above all the clients)
                with this account as <strong>Viewer</strong>:
                {state.email ? (
                  <span className="drive-email">
                    <code>{state.email}</code>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() =>
                        void navigator.clipboard
                          .writeText(state.email!)
                          .then(() => toast.success("Copied."))
                      }
                    >
                      <Copy size={13} /> Copy
                    </button>
                  </span>
                ) : (
                  <span> connect the Google Cloud service account in Connection first.</span>
                )}
              </li>
              <li>
                Open the client's folder in Drive, copy the address from the browser and paste it
                here.
              </li>
            </ol>
            <div className="footer-actions">
              <input
                value={link}
                onChange={(e) => setLink(e.target.value)}
                placeholder="https://drive.google.com/drive/folders/…"
                dir="ltr"
                aria-label="Drive folder link"
              />
              <button
                type="button"
                className="primary"
                onClick={() => void saveLink()}
                disabled={saving || !link.trim()}
              >
                {saving ? <Orb size={16} /> : <FolderOpen size={16} />} Connect
              </button>
            </div>
            <button
              type="button"
              className="text-button drive-all"
              onClick={() => void connectAll()}
              disabled={saving || !link.trim()}
              title="For a folder that holds every client's folder"
            >
              Connect every client from this folder (each one gets the folder with its name)
            </button>
            <DriveFolders
              clientId={client.id}
              folders={state.folders}
              email={state.email}
              onChanged={() => load(true)}
            />
          </div>
        ) : (
          <>
            {state.error && <p className="drive-error">{state.error}</p>}
            <div className="drive-tabs" role="tablist">
              {DRIVE_ROLES.map((r) => (
                <button
                  key={r}
                  type="button"
                  role="tab"
                  aria-selected={tab === r}
                  className={`drive-tab ${tab === r ? "active" : ""}`}
                  onClick={() => switchTab(r)}
                >
                  {DRIVE_ROLE_LABELS[r]}
                  {/* The photos Drive gives today; the ones it no longer gives are counted in the note under the grid. */}
                  <small>{state.groups[r].length}</small>
                </button>
              ))}
            </div>
            <p className="drive-role-note">{ROLE_NOTES[tab]}</p>
            <div className="drive-bar">
              <div className="journey-filter">
                <button
                  type="button"
                  className={`journey-chip small ${!top ? "active" : ""}`}
                  onClick={() => (setTop(""), setShown(PAGE))}
                >
                  All · {inTab.length}
                </button>
                {tops.map((t) => (
                  <button
                    key={t || "-"}
                    type="button"
                    className={`journey-chip small ${top === t ? "active" : ""}`}
                    onClick={() => (setTop(t), setShown(PAGE))}
                  >
                    {t || "Top folder"} · {inTab.filter((p) => topOf(p) === t).length}
                  </button>
                ))}
              </div>
              {kinds.length > 0 && (
                <div className="journey-filter drive-kinds" aria-label="What the photos show">
                  {kinds.map((k) => (
                    <button
                      key={k}
                      type="button"
                      className={`journey-chip small ${kind === k ? "active" : ""}`}
                      onClick={() => (setKind(kind === k ? "" : k), setShown(PAGE))}
                    >
                      {DRIVE_KIND_LABELS[k]} · {inFolder.filter((p) => p.kind === k).length}
                    </button>
                  ))}
                  {unread > 0 && <span className="field-hint">{unread} still being read</span>}
                </div>
              )}
              <span className="drive-tools">
                <button
                  type="button"
                  className="text-button"
                  onClick={() => load(true)}
                  title="Read the folders again"
                >
                  <RefreshCw size={13} /> Refresh
                </button>
                <button type="button" className="text-button" onClick={() => setManage((m) => !m)}>
                  <FolderOpen size={13} /> {manage ? "Hide folders" : "Folders"}
                </button>
                {!state.demo && (
                  <button
                    type="button"
                    className="text-button"
                    onClick={() =>
                      setState({
                        ...state,
                        folder: null,
                        folders: state.folders.filter((f) => !f.approved),
                      })
                    }
                  >
                    Change folder
                  </button>
                )}
              </span>
            </div>
            {manage && (
              <DriveFolders
                clientId={client.id}
                folders={state.folders}
                email={state.email}
                onChanged={() => load(true)}
              />
            )}
            {!!state.skipped?.length && tab === "product" && (
              <p className="field-hint drive-skipped">
                Not read (only JPEG, PNG, WebP, HEIC and TIFF photos are):{" "}
                {state.skipped
                  .slice(0, 6)
                  .map((x) => `${x.folder || "top folder"}: ${x.n} ${x.what}`)
                  .join(" · ")}
              </p>
            )}
            {list.length || missingInTab.length ? (
              <div className="drive-grid">
                {list.slice(0, shown).map((p) => {
                  const on = picked.includes(p.id);
                  return (
                    <DriveThumb
                      key={p.id}
                      p={p}
                      on={on}
                      byId={byId}
                      why={ai.get(p.id)}
                      caption={ai.get(p.id)?.product}
                      onClick={() =>
                        setPicked((l) => (on ? l.filter((x) => x !== p.id) : [...l, p.id]))
                      }
                    />
                  );
                })}
                {!top && !kind && missingInTab.map((p) => <MissingThumb key={p.id} p={p} />)}
              </div>
            ) : (
              <p className="field-hint">No photos in this folder.</p>
            )}
            {missingInTab.length > 0 && !top && !kind && (
              <p className="drive-missing-note">
                {inTab.length} photo{inTab.length === 1 ? "" : "s"} in Drive · +{missingInTab.length} no
                longer in Drive (deleted, in the bin, moved or unshared), kept for the months that
                used {missingInTab.length === 1 ? "it" : "them"}.
              </p>
            )}
            {list.length > shown && (
              <button
                type="button"
                className="secondary drive-more"
                onClick={() => setShown((n) => n + PAGE)}
              >
                Show more ({list.length - shown} left)
              </button>
            )}
            <div className="footer-actions drive-actions">
              {tab === "product" ? (
                <>
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => void pickForMe()}
                    disabled={picking || !!adding || !list.length}
                  >
                    {picking ? <Orb size={16} /> : <Sparkles size={16} />}
                    {picking
                      ? "Looking at the photos…"
                      : `Pick the best ${count} for me${top ? ` in ${top}` : ""}`}
                  </button>
                  <button
                    type="button"
                    className="secondary"
                    disabled={picked.length !== 1 || !!adding}
                    title="Remove or replace the background, relight or upscale the picked photo (Freepik)"
                    onClick={() => {
                      const p = byId.get(picked[0]);
                      if (!p) return;
                      openPhotoLab({ client: client.id, photoId: p.id, name: p.name, batch: batchId });
                      onClose();
                    }}
                  >
                    <Wand2 size={16} /> Open in Photo lab
                  </button>
                  <button
                    type="button"
                    className="primary"
                    onClick={() => void add()}
                    disabled={!pickedProducts || !!adding || !batchId}
                  >
                    {adding ? <Orb size={16} /> : <Check size={16} />}
                    {adding
                      ? `Adding ${pickedProducts}…`
                      : `Add ${pickedProducts || ""} to this month`}
                  </button>
                </>
              ) : (
                <span className="field-hint">
                  {tab === "reference"
                    ? "References are pinned to a post from the post editor; they never join the month as products."
                    : `${DRIVE_ROLE_LABELS[tab]} never join the month as products.`}
                </span>
              )}
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * A Drive photo pinned to one post as its reference, from the post editor: the reference folders'
 * pictures first (inspiration), the product photos as a second tab. The pinned picture is copied
 * into the studio with the Drive file's version, so a later change in Drive never alters this post.
 */
export function DriveReferencePicker({
  clientId,
  batchId,
  postIndex,
  onPinned,
}: {
  clientId: string;
  batchId: string;
  postIndex: number;
  /** The post's new reference, as the server recorded it. */
  onPinned: (reference: PostReference) => void;
}) {
  const { state, load } = useDriveListing(clientId);
  const [tab, setTab] = useState<"reference" | "product">("reference");
  const [chosen, setChosen] = useState("");
  const [note, setNote] = useState("");
  const [pinning, setPinning] = useState(false);
  const photos = useMemo(() => state?.groups[tab] ?? [], [state, tab]);
  const byId = useMemo(() => new Map((state?.photos ?? []).map((p) => [p.id, p])), [state]);
  const missing = useMemo(
    () => (state?.missing ?? []).filter((p) => (p.role ?? "product") === tab),
    [state, tab],
  );

  async function pin() {
    if (!chosen) return;
    setPinning(true);
    try {
      const r = await post<{ reference: PostReference }>(driveApi(clientId, "/pin"), {
        batch: batchId,
        post: postIndex,
        photoId: chosen,
        note: note.trim() || undefined,
      });
      toast.success(`Pinned to post ${postIndex}: ${r.reference.name ?? "the picture"}.`);
      setChosen("");
      setNote("");
      onPinned(r.reference);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setPinning(false);
    }
  }

  if (!state)
    return (
      <div className="journey-reading">
        <Orb size={16} /> Opening the Drive folders…
      </div>
    );
  return (
    <div className="drive-ref">
      <div className="drive-ref-bar">
        <div className="drive-tabs" role="tablist">
          {(["reference", "product"] as const).map((r) => (
            <button
              key={r}
              type="button"
              role="tab"
              aria-selected={tab === r}
              className={`drive-tab ${tab === r ? "active" : ""}`}
              onClick={() => (setTab(r), setChosen(""))}
            >
              {DRIVE_ROLE_LABELS[r]}
              <small>{state.groups[r].length}</small>
            </button>
          ))}
        </div>
        <span className="drive-tools">
          <DemoLabel on={state.demo} />
          <button
            type="button"
            className="text-button"
            onClick={() => load(true)}
            title="Read the folders again"
          >
            <RefreshCw size={13} /> Refresh
          </button>
        </span>
      </div>
      {state.error && <p className="drive-error">{state.error}</p>}
      <p className="drive-role-note">
        {tab === "reference"
          ? "An inspiration picture: the post takes its mood, light or framing, never its product."
          : "A product photo pinned as a reference: the post takes how it is shot; the month's product stays its product."}
      </p>
      {photos.length || missing.length ? (
        <div className="drive-ref-grid">
          {photos.map((p) => (
            <DriveThumb
              key={p.id}
              p={p}
              on={chosen === p.id}
              byId={byId}
              onClick={() => setChosen(chosen === p.id ? "" : p.id)}
            />
          ))}
          {missing.map((p) => (
            <MissingThumb key={p.id} p={p} />
          ))}
        </div>
      ) : (
        <p className="field-hint">
          {tab === "reference"
            ? "No reference folder is approved for this client yet. Add one in the Drive picker with the role References."
            : "No product photos in the client's Drive."}
        </p>
      )}
      <div className="drive-ref-actions">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="What to take from it (optional)"
          aria-label="What to take from the reference"
          maxLength={600}
        />
        <button
          type="button"
          className="primary"
          onClick={() => void pin()}
          disabled={!chosen || pinning}
        >
          {pinning ? <Orb size={16} /> : <Pin size={16} />}{" "}
          {pinning ? "Pinning…" : `Pin to post ${postIndex}`}
        </button>
      </div>
    </div>
  );
}
