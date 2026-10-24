/**
 * Trend videos with a character: a Genjutsu motion preset (trending, new, Higgsfield's own) where the
 * character takes the place of the person in the video. The character is one of the client's
 * ambassadors (its portrait) or one of the Soul characters made on the Higgsfield account; the studio
 * never makes a character itself (a Higgsfield AI influencer costs about 1,250 credits). Shared by the
 * server (server/ambassador-trends.ts) and the studio (src/studio/AmbassadorTrends.tsx).
 */

export type TrendStatus = "queued" | "generating" | "done" | "failed";

/** A character a trend can use. `id` is "ambassador:<id>" or "soul:<soul id>". */
export interface TrendCharacter {
  id: string;
  name: string;
  from: "ambassador" | "higgsfield";
  /** A picture of the character, for the card. */
  image: string | null;
}

export interface Trend {
  id: string;
  character: string;
  characterName: string;
  presetId: string;
  presetName: string;
  preview: string | null;
  status: TrendStatus;
  credits: number | null;
  /** The finished video, served from the studio. */
  video: string | null;
  error: string | null;
  created: number;
}

/** The Genjutsu galleries a trend comes from. */
export const TREND_CATEGORIES = [
  { id: "genjutsu-trending", label: "Trending" },
  { id: "genjutsu-new", label: "New" },
  { id: "genjutsu", label: "By Higgsfield" },
] as const;
export type TrendCategory = (typeof TREND_CATEGORIES)[number]["id"];
export const isTrendCategory = (s: string): s is TrendCategory => TREND_CATEGORIES.some((c) => c.id === s);

/** "ambassador:<id>" / "soul:<id>" read back; null for anything else. */
export function parseCharacterId(id: string): { kind: "ambassador" | "soul"; ref: string } | null {
  const m = /^(ambassador|soul):([\w-]{1,80})$/.exec(id.trim());
  return m ? { kind: m[1] as "ambassador" | "soul", ref: m[2] } : null;
}
