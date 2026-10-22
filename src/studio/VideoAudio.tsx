/**
 * The Audio block of the Video dialog: which sound a version carries. Engine sound or none are
 * generation settings; an uploaded track is kept with the post and mixed in by the browser-side
 * video editor (the server never changes the mp4); generated music waits for a connected
 * provider; the Instagram music library can only be added in the Instagram app. The choice is
 * written on the version (POST /audio/choose) when one is shown, and carried to the next clip
 * otherwise. Members see the block read-only. docs/audio-capabilities.md has what each can do.
 */
import { useEffect, useRef, useState } from "react";
import { Music2, Upload } from "lucide-react";
import { Orb } from "@/components/Orb";
import { toast } from "sonner";
import { AUDIO_CHOICE_LABELS, AUDIO_MAX_BYTES, GENERATED_NOT_CONNECTED, type AudioChoice } from "@shared/video-audio";
import { audioDuration, listAudio, uploadAudio, type AudioTrack, type VideoItem } from "./videoApi";

/** The track's length as the browser reads it, so the list can say "0:32" for an mp3 too. */
function readDuration(file: File): Promise<number | null> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const a = new Audio();
    const done = (ms: number | null) => {
      URL.revokeObjectURL(url);
      resolve(ms);
    };
    a.onloadedmetadata = () => done(Number.isFinite(a.duration) ? Math.round(a.duration * 1000) : null);
    a.onerror = () => done(null);
    a.src = url;
  });
}

export default function VideoAudio({
  batchId,
  index,
  engineSound,
  engineName,
  admin,
  version,
  choice,
  audioId,
  onChange,
}: {
  batchId: string;
  index: number;
  /** The chosen engine makes its own sound (the catalog's `audio` field). */
  engineSound: boolean;
  engineName: string;
  admin: boolean;
  /** The finished (or failed) version shown above, whose choice is written at once; null before the first clip. */
  version: VideoItem | null;
  choice: AudioChoice;
  audioId: string | null;
  onChange: (choice: AudioChoice, audioId: string | null) => void;
}) {
  const [tracks, setTracks] = useState<AudioTrack[]>([]);
  const [canUpload, setCanUpload] = useState(admin);
  const [reason, setReason] = useState("");
  const [uploading, setUploading] = useState(false);
  const [name, setName] = useState("");
  const [license, setLicense] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    listAudio(batchId, index)
      .then((r) => {
        setTracks(r.tracks);
        setCanUpload(r.access.admin && r.access.enabled);
        setReason(r.access.reason);
      })
      .catch(() => setTracks([]));
  }, [batchId, index]);

  async function upload(file: File) {
    if (file.size > AUDIO_MAX_BYTES) {
      toast.error("The track is too large (25 MB at most).");
      return;
    }
    setUploading(true);
    try {
      const durationMs = await readDuration(file);
      const r = await uploadAudio(batchId, index, file, { name: name.trim() || file.name.replace(/\.[a-z0-9]+$/i, ""), license: license.trim(), durationMs });
      setTracks(r.tracks);
      setName("");
      onChange("upload", r.track.id);
      toast.success("The track is kept with this post; the Video editor mixes it in.");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const locked = !admin;
  const pick = (c: AudioChoice, id: string | null = null) => {
    if (locked) return;
    onChange(c, id);
  };
  const radio = (c: AudioChoice, disabled: boolean, body: React.ReactNode, id: string | null = null) => (
    <label className={`video-audio-choice ${choice === c && (c !== "upload" || audioId === id) ? "on" : ""} ${disabled ? "off" : ""}`}>
      <input type="radio" name="video-audio" checked={choice === c && (c !== "upload" || audioId === id)} disabled={disabled || locked} onChange={() => pick(c, id)} />
      <span>{body}</span>
    </label>
  );

  return (
    <div className="video-audio">
      <span className="field-label">
        <Music2 size={13} /> Audio{version ? ` · ${version.status === "done" ? "this version" : "the next clip"}` : " · the next clip"}
      </span>
      {radio(
        "provider",
        !engineSound,
        <>
          <b>{AUDIO_CHOICE_LABELS.provider}</b>
          <small>{engineSound ? `${engineName} generates sound with the picture.` : `${engineName} makes no sound of its own.`}</small>
        </>,
      )}
      {radio(
        "none",
        false,
        <>
          <b>{AUDIO_CHOICE_LABELS.none}</b>
          <small>The clip is silent; a track can be laid over it later.</small>
        </>,
      )}
      <div className={`video-audio-choice group ${choice === "upload" ? "on" : ""}`}>
        <span className="video-audio-head">
          <b>{AUDIO_CHOICE_LABELS.upload}</b>
          <small>A track you have the rights to. It is kept with the version and mixed in by the Video editor in the browser, not by the server: the clip's file itself stays as it is until then.</small>
        </span>
        {tracks.length > 0 && (
          <ul className="video-audio-tracks">
            {tracks.map((t) =>
              radio(
                "upload",
                false,
                <>
                  <b>{t.name || "Track"}</b>
                  <small>
                    {t.durationMs ? `${audioDuration(t.durationMs)} · ` : ""}
                    {t.mime?.split("/")[1] ?? ""}
                    {t.license ? ` · licence: ${t.license}` : " · no licence line"}
                  </small>
                </>,
                t.id,
              ),
            )}
          </ul>
        )}
        {canUpload ? (
          <div className="video-audio-upload">
            <input type="text" placeholder="Track name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} disabled={uploading} />
            <input type="text" placeholder="Licence: who cleared it, under what" value={license} maxLength={500} onChange={(e) => setLicense(e.target.value)} disabled={uploading} />
            <input ref={fileRef} type="file" accept=".mp3,.m4a,.aac,.wav,audio/mpeg,audio/mp4,audio/aac,audio/wav" hidden onChange={(e) => e.target.files?.[0] && void upload(e.target.files[0])} />
            <button type="button" className="secondary" disabled={uploading} onClick={() => fileRef.current?.click()}>
              {uploading ? <Orb size={14} /> : <Upload size={14} />} Upload a track (mp3, m4a, aac, wav · 25 MB)
            </button>
          </div>
        ) : (
          <small className="field-hint warn">{reason || "Admins only for now"}</small>
        )}
      </div>
      {radio(
        "generated",
        true,
        <>
          <b>{AUDIO_CHOICE_LABELS.generated}</b>
          <small>{GENERATED_NOT_CONNECTED}</small>
        </>,
      )}
      {radio(
        "instagram",
        false,
        <>
          <b>{AUDIO_CHOICE_LABELS.instagram}</b>
          <small>The Instagram music library can only be added in the Instagram app; the studio publishes the clip and you add the track there.</small>
        </>,
      )}
      {locked && <small className="field-hint warn">Admins only for now: the audio choice is read-only for members.</small>}
    </div>
  );
}
