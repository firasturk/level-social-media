/**
 * A client's AI influencer: a person designed for the brand and made once as a Higgsfield character
 * sheet (`ai_influencer_prepare` prices it, `ai_influencer_generate` makes it), then put into trend
 * videos: Genjutsu motion presets (trending, new, Higgsfield's own) with the sheet as the character.
 * Shared by the server (server/influencers.ts) and the studio (src/studio/Influencers.tsx).
 */

export type InfluencerStatus = "draft" | "making" | "ready" | "failed";
export type TrendStatus = "queued" | "generating" | "done" | "failed";

export interface Influencer {
  id: string;
  client: string;
  name: string;
  brief: string;
  gender: string;
  status: InfluencerStatus;
  /** What the preparation said about the design (traits), for the person to read before paying. */
  design: string;
  /** The quote for the sheet, in credits; null when Higgsfield named none. */
  credits: number | null;
  /** The finished sheet, served from the studio. */
  image: string | null;
  /** Already one of the client's ambassadors (the cast campaigns use). */
  inCast: boolean;
  error: string | null;
  created: number;
  trends: InfluencerTrend[];
}

export interface InfluencerTrend {
  id: string;
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

/**
 * The traits the studio offers, as Higgsfield's builder names them (`ai_influencer_get_options`,
 * the "normal" tier, read 24 Oct 2026). Gender is a man or a woman; anything left on "Any" is chosen
 * by Higgsfield. The studio adds the brand's dress rule to the brief itself.
 */
export const INFLUENCER_TRAITS: readonly { id: string; label: string; options: readonly { id: string; label: string }[] }[] = [
  { id: "gender", label: "Gender", options: [{ id: "male", label: "Man" }, { id: "female", label: "Woman" }] },
  { id: "age", label: "Age", options: [{ id: "adult", label: "Adult" }, { id: "mature", label: "Mature" }, { id: "senior", label: "Senior" }] },
  { id: "ethnicity_origin_base", label: "Origin", options: [{ id: "middle_eastern", label: "Middle Eastern" }, { id: "african", label: "African" }, { id: "east_asian", label: "Asian" }, { id: "european", label: "European" }, { id: "indian", label: "Indian" }, { id: "latin_american", label: "Mixed" }] },
  { id: "skin_tone", label: "Skin", options: [{ id: "st_fair", label: "Fair" }, { id: "st_light", label: "Light" }, { id: "st_olive", label: "Olive" }, { id: "st_tan", label: "Tan" }, { id: "st_brown", label: "Brown" }, { id: "st_deep", label: "Deep brown" }] },
  { id: "body_type", label: "Build", options: [{ id: "body_slim", label: "Slim" }, { id: "body_athletic", label: "Athletic" }, { id: "body_muscular", label: "Muscular" }, { id: "body_curvy", label: "Curvy" }, { id: "body_heavy", label: "Heavy" }] },
  { id: "hair", label: "Hair", options: [{ id: "hair_short", label: "Short" }, { id: "hair_buzz", label: "Buzz cut" }, { id: "hair_long", label: "Long" }, { id: "hair_braids", label: "Braids" }, { id: "hair_bald", label: "Bald" }] },
  { id: "hair_colour", label: "Hair colour", options: [{ id: "hc_black", label: "Black" }, { id: "hc_darkbrown", label: "Dark brown" }, { id: "hc_chestnut", label: "Chestnut" }, { id: "hc_grey", label: "Grey" }] },
  { id: "facial_hair", label: "Facial hair", options: [{ id: "fh_none", label: "Clean" }, { id: "fh_stubble", label: "Stubble" }, { id: "fh_beard", label: "Full beard" }, { id: "fh_goatee", label: "Goatee" }, { id: "fh_moustache", label: "Moustache" }] },
  { id: "aesthetic", label: "Style", options: [{ id: "casual", label: "Casual" }, { id: "streetstyle", label: "Streetstyle" }, { id: "sporty", label: "Sporty" }, { id: "suits", label: "Suits" }, { id: "retro", label: "Retro" }] },
];

/** The traits a choice keeps: known groups and options only, one option each. */
export function cleanSelection(choice: Record<string, string>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const g of INFLUENCER_TRAITS) {
    const v = choice[g.id];
    if (v && g.options.some((o) => o.id === v)) out[g.id] = [v];
  }
  // A woman is not given a beard or a moustache.
  if (out.gender?.[0] === "female") delete out.facial_hair;
  return out;
}

/**
 * The brief sent with the traits: the person, the brand's audience rules (modest dress, a hijab when
 * asked, a real person from the brand's city) and the admin's own words.
 */
export function influencerBrief(o: { name: string; gender: string; hijab: boolean; city: string; notes: string; brand: string }): string {
  const woman = o.gender === "female";
  return [
    `${o.name}: a real-looking ${woman ? "woman" : o.gender === "male" ? "man" : "person"} from ${o.city || "Amman, Jordan"}, the face of ${o.brand} on social media.`,
    `Modestly dressed: loose clothing that covers the shoulders, arms and knees${woman && o.hijab ? ", and a hijab covering the hair" : ""}. No revealing clothes, no tattoos, no piercings.`,
    "Natural skin texture, a friendly, confident expression; a believable person, not a model or a cartoon.",
    o.notes.trim(),
  ]
    .filter(Boolean)
    .join(" ")
    .slice(0, 3900);
}
