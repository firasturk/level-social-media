/**
 * The brand's readiness in one word at the top of the workflow: "Brand kit ready" or "2 things
 * missing", opening the brand kit itself (a page of its own, never a stage of the flow).
 */
import { useEffect, useState } from "react";
import { BadgeCheck, CircleAlert } from "lucide-react";
import { get } from "@/api";
import type { Ambassador, Client } from "@shared/types";

export default function BrandChip({ client, ambassadors, onOpen }: { client: Client; ambassadors: Ambassador[]; onOpen: () => void }) {
  const [profile, setProfile] = useState<{ profile: unknown; drive: unknown } | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setProfile(undefined);
    get<{ profile: { profile: unknown; drive: unknown } }>(`/api/studio/profiles/${encodeURIComponent(client.id)}`)
      .then((r) => live && setProfile(r.profile))
      .catch(() => live && setProfile(null));
    return () => {
      live = false;
    };
  }, [client.id, client.updated]);
  const missing = [
    !client.logo && "logo",
    !client.colors.length && "brand colours",
    !client.tone?.trim() && "tone of voice",
    profile !== undefined && !profile?.profile && "Instagram analysis",
    !ambassadors.some((a) => a.image) && "an ambassador portrait",
    !((client.places?.length ?? 0) > 0 || (client.drivePlaces ?? 0) > 0) && "place photos",
  ].filter((x): x is string => !!x);
  const ready = missing.length === 0;
  return (
    <button type="button" className={`brand-chip ${ready ? "ready" : ""}`} onClick={onOpen} title={ready ? "Every part of the brand kit is in place. Open it." : `Missing: ${missing.join(", ")}. Open the brand kit.`}>
      {ready ? <BadgeCheck size={14} /> : <CircleAlert size={14} />}
      {ready ? "Brand kit ready" : `${missing.length} thing${missing.length === 1 ? "" : "s"} missing`}
    </button>
  );
}
