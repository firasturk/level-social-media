import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ImagePlus, LoaderCircle, Plus, Sparkles, Trash2, UserRound } from "lucide-react";
import { del, post, postForm, put } from "@/api";
import { askConfirm, askInput } from "@/lib/confirm";
import type { Ambassador, Client } from "@shared/types";
import { Group } from "./kit";

type Reply = { ambassadors: Ambassador[] };
export const MAX_AMBASSADORS = 4;
export const MAX_CAST = 3;

/**
 * Brand ambassadors: up to four recurring AI people per client. Each has a written look and a
 * portrait the engine keeps the face from; the month casts up to three of them.
 */
export default function Ambassadors({
  client,
  ambassadors,
  onChanged,
  cast,
  onCast,
  locked,
}: {
  client: Client;
  ambassadors: Ambassador[];
  onChanged: (list: Ambassador[]) => void;
  /** Ambassador ids this month's posts may cast. */
  cast: string[];
  onCast: (ids: string[]) => void;
  locked: boolean;
}) {
  const [busy, setBusy] = useState<string>("");

  async function add() {
    const name = await askInput("Ambassador name", "", { ok: "Add", placeholder: "Omar, Lina, Abu Ahmad…" });
    if (!name?.trim()) return;
    try {
      const r = await post<Reply>("/api/studio/ambassadors", { client: client.id, name: name.trim() });
      onChanged(r.ambassadors);
      toast.success("Ambassador added. Describe the look, then press Generate portrait.");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <Group
      kit="ambassadors"
      title="Your ambassadors"
      note={`${ambassadors.length}/${MAX_AMBASSADORS}`}
      actions={
        ambassadors.length < MAX_AMBASSADORS ? (
          <button type="button" className="text-button" onClick={() => void add()}>
            <Plus size={13} /> Ambassador
          </button>
        ) : null
      }
    >
      {ambassadors.length ? (
        <div className="amb-list">
          {ambassadors.map((a) => (
            <AmbassadorCard
              key={a.id}
              a={a}
              busy={busy === a.id}
              setBusy={(on) => setBusy(on ? a.id : "")}
              onChanged={onChanged}
              inMonth={cast.includes(a.id)}
              canAdd={cast.length < MAX_CAST}
              locked={locked}
              onToggle={(on) =>
                onCast(on ? [...cast, a.id].slice(0, MAX_CAST) : cast.filter((id) => id !== a.id))
              }
            />
          ))}
        </div>
      ) : (
        <div className="prompt-tip">
          Up to four recurring people for this brand, each with a portrait so the same face appears in every post.
          Pick one, two or three of them for a month and the ideas cast them where a post shows a person.
        </div>
      )}
      {ambassadors.length > 0 && (
        <p className="field-hint">
          {cast.length
            ? `${cast.length} in this month: the ideas cast them by name, and their portraits keep the faces the same.`
            : "Tick “In this month” on one, two or three of them to cast them in this month's posts."}
        </p>
      )}
    </Group>
  );
}

function AmbassadorCard({
  a,
  busy,
  setBusy,
  onChanged,
  inMonth,
  canAdd,
  locked,
  onToggle,
}: {
  a: Ambassador;
  busy: boolean;
  setBusy: (on: boolean) => void;
  onChanged: (list: Ambassador[]) => void;
  inMonth: boolean;
  canAdd: boolean;
  locked: boolean;
  onToggle: (on: boolean) => void;
}) {
  const [name, setName] = useState(a.name);
  const [look, setLook] = useState(a.description);
  useEffect(() => setName(a.name), [a.name]);
  useEffect(() => setLook(a.description), [a.description]);
  const src = a.image ? `/api/studio/ambassadors/${a.id}/image?v=${a.updated}` : null;

  async function save(patch: { name?: string; description?: string; gender?: Ambassador["gender"]; modest?: boolean; hijab?: boolean }) {
    if (
      (patch.name ?? a.name) === a.name &&
      (patch.description ?? a.description) === a.description &&
      (patch.gender ?? a.gender) === a.gender &&
      (patch.modest ?? a.modest) === a.modest &&
      (patch.hijab ?? a.hijab) === a.hijab
    )
      return;
    try {
      onChanged((await put<Reply>(`/api/studio/ambassadors/${a.id}`, patch)).ambassadors);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  async function generate() {
    if (!a.gender) {
      toast.error(`Choose whether ${a.name} is a man or a woman first.`);
      return;
    }
    if (!look.trim()) {
      toast.error("Describe the look first: age, features, hair, styling.");
      return;
    }
    await save({ description: look });
    setBusy(true);
    try {
      onChanged((await post<Reply>(`/api/studio/ambassadors/${a.id}/portrait`, {})).ambassadors);
      toast.success(`Portrait of ${a.name} ready.`);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function upload(file: File | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file);
      onChanged((await postForm<Reply>(`/api/studio/ambassadors/${a.id}/photo`, form)).ambassadors);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!(await askConfirm(`Remove the ambassador "${a.name}" and their portrait?`))) return;
    if (inMonth) onToggle(false);
    try {
      onChanged((await del<Reply>(`/api/studio/ambassadors/${a.id}`)).ambassadors);
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <div className={`amb-card ${inMonth ? "in-month" : ""}`}>
      <div className="amb-portrait">
        {src ? <img src={src} alt={a.name} /> : <UserRound size={34} />}
        {busy && (
          <span className="amb-busy">
            <LoaderCircle className="spinning" size={18} />
          </span>
        )}
      </div>
      <div className="amb-fields">
        <input
          className="amb-name"
          value={name}
          aria-label="Ambassador name"
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && void save({ name: name.trim() })}
        />
        <div className="amb-profile" role="radiogroup" aria-label={`${a.name} is`}>
          {(["man", "woman"] as const).map((g) => (
            <button
              key={g}
              type="button"
              role="radio"
              aria-checked={a.gender === g}
              className={`journey-chip small ${a.gender === g ? "active" : ""}`}
              onClick={() => void save({ gender: g, hijab: g === "man" ? false : a.hijab })}
            >
              {g === "man" ? "Man" : "Woman"}
            </button>
          ))}
          <label className="check-row" title="Shoulders, arms, chest and knees covered">
            <input type="checkbox" checked={a.modest} onChange={(e) => void save({ modest: e.target.checked })} />
            Modest clothing
          </label>
          {a.gender === "woman" && (
            <label className="check-row">
              <input type="checkbox" checked={a.hijab} onChange={(e) => void save({ hijab: e.target.checked })} />
              Wears a hijab
            </label>
          )}
        </div>
        <textarea
          rows={3}
          value={look}
          aria-label={`${a.name}'s look`}
          placeholder={a.gender === "woman" ? "In her late twenties, long dark hair, warm smile, Jordanian" : "In his thirties, short black beard, warm smile, white shirt, Jordanian"}
          onChange={(e) => setLook(e.target.value)}
          onBlur={() => void save({ description: look })}
        />
        <div className="amb-actions">
          <button type="button" className="text-button" onClick={() => void generate()} disabled={busy}>
            <Sparkles size={13} /> {a.image ? "New portrait" : "Generate portrait"}
          </button>
          <label className="text-button">
            <ImagePlus size={13} /> Upload
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              hidden
              onChange={(e) => {
                void upload(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
          </label>
          <button type="button" className="icon-button" aria-label={`Remove ${a.name}`} onClick={() => void remove()}>
            <Trash2 size={13} />
          </button>
        </div>
        <label className="check-row amb-toggle" title={!a.image ? "Generate or upload a portrait first" : ""}>
          <input
            type="checkbox"
            checked={inMonth}
            disabled={locked || (!inMonth && (!canAdd || !a.image))}
            onChange={(e) => onToggle(e.target.checked)}
          />
          In this month
        </label>
      </div>
    </div>
  );
}
