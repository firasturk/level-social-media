import { useEffect, useState } from "react";
import { Check, ChevronRight, ClipboardCheck, Circle } from "lucide-react";
import { get } from "@/api";
import type { Ambassador, Client } from "@shared/types";
import type { ProfileRecord } from "@shared/profile";

interface Item {
  id: string;
  label: string;
  done: boolean;
  /** Where to do it. */
  hint: string;
  go?: () => void;
}

/**
 * What a client still needs before its months come out right: the brand kit, the Analysis, Drive,
 * a portrait, place photos. Each line opens where it is done. Hidden once everything is in.
 */
export default function SetupChecklist({
  client,
  ambassadors,
  onOpenKit,
  onOpenJourney,
}: {
  client: Client;
  ambassadors: Ambassador[];
  /** Opens the brand kit panel (scrolled to a group when its kit key is given). */
  onOpenKit: (kit?: string) => void;
  /** Opens the journey on a step (0: the client and its profile; 1: products and Drive). */
  onOpenJourney: (step: number) => void;
}) {
  const [profile, setProfile] = useState<ProfileRecord | null | undefined>(undefined);
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    let live = true;
    setProfile(undefined);
    get<{ profile: ProfileRecord }>(`/api/studio/profiles/${encodeURIComponent(client.id)}`)
      .then((r) => live && setProfile(r.profile))
      .catch(() => live && setProfile(null));
    return () => {
      live = false;
    };
  }, [client.id, client.updated]);
  if (profile === undefined) return null;
  const items: Item[] = [
    { id: "logo", label: "Logo", done: client.logo, hint: "Brand kit → Logos", go: () => onOpenKit("logo") },
    { id: "colors", label: "Brand colours", done: client.colors.length > 0, hint: "Brand kit → Brand colours", go: () => onOpenKit("colours") },
    { id: "tone", label: "Tone of voice", done: !!client.tone?.trim(), hint: "Brand kit → Tone of voice", go: () => onOpenKit("voice") },
    { id: "analysis", label: "Instagram handle and Analysis", done: !!profile?.profile, hint: "Journey → first screen → the profile card", go: () => onOpenJourney(0) },
    { id: "drive", label: "Drive folder", done: !!profile?.drive, hint: "Journey → Products → Drive", go: () => onOpenJourney(1) },
    { id: "portrait", label: "An ambassador with a portrait", done: ambassadors.some((a) => a.image), hint: "Brand kit → Brand ambassadors", go: () => onOpenKit("ambassadors") },
    { id: "places", label: "Photos of the shop or kitchen", done: (client.places?.length ?? 0) > 0 || (client.drivePlaces ?? 0) > 0, hint: "Brand kit → Place photos, or a shop folder in Drive", go: () => onOpenKit("references") },
  ];
  const done = items.filter((i) => i.done).length;
  if (done === items.length || hidden) return null;
  return (
    <section className="setup-checklist" aria-label="Client setup">
      <div className="setup-head">
        <ClipboardCheck size={16} />
        <strong>
          {client.name} is set up {done} of {items.length}
        </strong>
        <span className="setup-bar" aria-hidden>
          <i style={{ width: `${(done / items.length) * 100}%` }} />
        </span>
        <button type="button" className="text-button" onClick={() => setHidden(true)}>
          Hide for now
        </button>
      </div>
      <ul>
        {items.map((i) => (
          <li key={i.id} className={i.done ? "done" : ""}>
            {i.done ? <Check size={14} /> : <Circle size={14} />}
            <span>{i.label}</span>
            {!i.done && i.go && (
              <button type="button" className="text-button" onClick={i.go} title={i.hint}>
                {i.hint} <ChevronRight size={13} />
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
