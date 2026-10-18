/**
 * A client's profile: the Analysis reads the client's Instagram (through Meta), its website and the
 * brands the team compares it with, and writes what it understood: who they are, their tone of
 * voice, what they sell, how they brand it, what their content does, and tips for the team. The
 * profile then steers the month's ideas, headlines and captions. Other brands are studied, never
 * copied.
 */

export const PROFILE_REF_KINDS = ["competitor", "direction"] as const;
export type ProfileRefKind = (typeof PROFILE_REF_KINDS)[number];

/** A brand the client is compared with: a competitor, or a direction the brand wants to take. */
export interface ProfileRef {
  handle: string;
  website: string;
  kind: ProfileRefKind;
}

export interface ClientProfile {
  summary: string;
  audience: string;
  offer: { products: string[]; services: string[]; heroes: string[] };
  tone: { description: string; dialect: string; examples: string[]; keep: string[]; improve: string[] };
  branding: { colours: string[]; type: string; packaging: string; photography: string };
  content: { pillars: string[]; works: string[]; weak: string[]; rhythm: string };
  refs: { name: string; kind: string; strengths: string[]; gaps: string[]; takeaways: string[] }[];
  direction: string;
  tips: { headlines: string[]; captions: string[]; design: string[] };
  /** Pinterest searches for feed grids that fit the brand's direction. */
  gridQueries: string[];
}

/** What the Analysis read, shown with the profile. */
export interface ProfileSources {
  instagram?: { username: string; followers: number; posts: number; read: number; picture: string | null };
  website?: { pages: string[] };
  refs: { name: string; instagram: boolean; website: boolean }[];
  grids: number;
}

export interface ProfileRecord {
  client: string;
  instagram: string;
  website: string;
  refs: ProfileRef[];
  profile: ClientProfile | null;
  sources: ProfileSources | null;
  status: "idle" | "running" | "failed";
  error: string | null;
  analysed: number | null;
  updated: number;
  /** The client's Drive folder link, when one is connected. */
  drive?: string;
}

const list = { type: "array", items: { type: "string" } };
export const PROFILE_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    audience: { type: "string" },
    offer: { type: "object", properties: { products: list, services: list, heroes: list }, required: ["products", "services", "heroes"] },
    tone: {
      type: "object",
      properties: { description: { type: "string" }, dialect: { type: "string" }, examples: list, keep: list, improve: list },
      required: ["description", "dialect", "examples", "keep", "improve"],
    },
    branding: {
      type: "object",
      properties: { colours: list, type: { type: "string" }, packaging: { type: "string" }, photography: { type: "string" } },
      required: ["colours", "type", "packaging", "photography"],
    },
    content: {
      type: "object",
      properties: { pillars: list, works: list, weak: list, rhythm: { type: "string" } },
      required: ["pillars", "works", "weak", "rhythm"],
    },
    refs: {
      type: "array",
      items: {
        type: "object",
        properties: { name: { type: "string" }, kind: { type: "string" }, strengths: list, gaps: list, takeaways: list },
        required: ["name", "kind", "strengths", "gaps", "takeaways"],
      },
    },
    direction: { type: "string" },
    tips: { type: "object", properties: { headlines: list, captions: list, design: list }, required: ["headlines", "captions", "design"] },
    gridQueries: list,
  },
  required: ["summary", "audience", "offer", "tone", "branding", "content", "refs", "direction", "tips", "gridQueries"],
};

/** One account as the Analysis reads it: its words, and how many of its pictures are attached. */
export interface ReadAccount {
  name: string;
  kind: "client" | ProfileRefKind;
  instagram?: { username: string; bio: string; followers: number; posts: { caption: string; likes: number | null; comments: number | null; type: string; date: string }[] };
  website?: string;
  images: number;
}

export interface ProfileRequest {
  clientName: string;
  brandKit: { tone: string; dos: string; donts: string; style: string; colours: string[]; service?: string };
  /** The client first, then the brands it is compared with, in the order their pictures are attached. */
  accounts: ReadAccount[];
}

export function profileInstruction(r: ProfileRequest): string {
  let image = 0;
  const blocks = r.accounts.map((a) => {
    const first = image + 1;
    image += a.images;
    const pics = a.images ? `Images ${first} to ${image} are its latest posts.` : "No pictures were read.";
    const who = a.kind === "client" ? "THE CLIENT" : a.kind === "competitor" ? "A COMPETITOR" : "A DIRECTION THE BRAND WANTS TO TAKE";
    const ig = a.instagram
      ? `Instagram @${a.instagram.username} (${a.instagram.followers.toLocaleString("en")} followers). Bio: ${a.instagram.bio || "(none)"}\nLatest captions, newest first (likes / comments):\n${a.instagram.posts
          .map((p) => `- [${p.date.slice(0, 10)} ${p.type.toLowerCase()} ${p.likes ?? "?"}/${p.comments ?? "?"}] ${p.caption.replace(/\s+/g, " ").slice(0, 400) || "(no caption)"}`)
          .join("\n")}`
      : "Instagram: not read.";
    const site = a.website ? `Website text:\n${a.website}` : "Website: not read.";
    return `${who}: ${a.name}. ${pics}\n${ig}\n${site}`;
  });
  return [
    `You are the strategy lead of a social-media design agency in Jordan. Build the profile of the client "${r.clientName}" from what was read below, so the team writes better posts for them: headlines drawn on the designs, captions, and the look of the pictures.`,
    `THE BRAND KIT THE TEAM HAS NOW: tone "${r.brandKit.tone || "(none)"}"; always "${r.brandKit.dos || "(none)"}"; never "${r.brandKit.donts || "(none)"}"; visual style "${r.brandKit.style || "(none)"}"; colours ${r.brandKit.colours.join(", ") || "(none)"}${r.brandKit.service ? `; a service brand: ${r.brandKit.service}` : ""}.`,
    ...blocks,
    "Judge from the evidence: the captions, the likes and comments, the pictures and the website. Where the evidence is thin, say so rather than inventing.",
    "Write (in English, quoting the client's own words in their language):",
    "- summary: who they are and what makes them different, 2-3 sentences.",
    "- audience: who buys from them and why, 1-2 sentences.",
    "- offer: products (the main products or ranges they sell), services (if any), heroes (the products they push most or that do best).",
    "- tone: description (how they write: register, energy, humour, length, emoji use), dialect (a few words: Modern Standard Arabic, Jordanian, Levantine, Gulf, English, or a mix of them), examples (3-5 short phrases quoted from their captions that show the voice at its best), keep (what to keep), improve (what to write better, concretely).",
    "- branding: colours (the colours their posts and packaging use, as names with hex when clear), type (headline lettering: Arabic calligraphy, bold sans, handwritten...), packaging (how their products look), photography (how they shoot: light, sets, angles, people).",
    "- content: pillars (the kinds of posts they make, with a rough share), works (what gets the most likes and comments, with why), weak (what does little), rhythm (how often and when they post).",
    "- refs: one entry per compared brand: name, kind (competitor or direction), strengths, gaps (what they do not do that our client could own), takeaways (what our client should do to be better or to move in that direction). ANALYSIS ONLY: never suggest copying their posts, slogans, characters or designs; describe the principle the client can apply in its own way.",
    "- direction: where to take the brand's content next, 2-4 sentences.",
    "- tips: headlines (4-6 rules for the words drawn on the designs: length, dialect, wordplay, what to avoid, with one example each in the client's language), captions (4-6 rules for captions, with examples), design (4-6 rules for the pictures and layouts).",
    "- gridQueries: 4-6 Pinterest searches in English that find Instagram feed grids fitting the brand's direction (\"pastel dessert shop instagram feed\", \"bold sportswear instagram grid\").",
    "Return ONLY the JSON.",
  ].join("\n\n");
}

const strs = (v: unknown, n = 8) =>
  (Array.isArray(v) ? v : [])
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .slice(0, n);
const str = (v: unknown, n = 1200) => String(v ?? "").trim().slice(0, n);

export function parseProfile(raw: unknown): ClientProfile | null {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, Record<string, unknown> & unknown>;
  const o = (k: string) => ((d[k] && typeof d[k] === "object" ? d[k] : {}) as Record<string, unknown>);
  const summary = str(d.summary);
  if (!summary) return null;
  return {
    summary,
    audience: str(d.audience),
    offer: { products: strs(o("offer").products, 12), services: strs(o("offer").services), heroes: strs(o("offer").heroes, 6) },
    tone: {
      description: str(o("tone").description),
      dialect: str(o("tone").dialect, 240),
      examples: strs(o("tone").examples, 6),
      keep: strs(o("tone").keep, 6),
      improve: strs(o("tone").improve, 6),
    },
    branding: {
      colours: strs(o("branding").colours, 10),
      type: str(o("branding").type, 400),
      packaging: str(o("branding").packaging, 600),
      photography: str(o("branding").photography, 800),
    },
    content: { pillars: strs(o("content").pillars), works: strs(o("content").works, 6), weak: strs(o("content").weak, 6), rhythm: str(o("content").rhythm, 300) },
    refs: (Array.isArray(d.refs) ? (d.refs as Record<string, unknown>[]) : []).slice(0, 4).map((x) => ({
      name: str(x?.name, 80),
      kind: str(x?.kind, 20),
      strengths: strs(x?.strengths, 5),
      gaps: strs(x?.gaps, 5),
      takeaways: strs(x?.takeaways, 5),
    })),
    direction: str(d.direction),
    tips: { headlines: strs(o("tips").headlines, 6), captions: strs(o("tips").captions, 6), design: strs(o("tips").design, 6) },
    gridQueries: strs(d.gridQueries, 6).map((q) => q.slice(0, 80)),
  };
}

/** The profile in a few lines for the writers of ideas, headlines and captions. */
export function profileBrief(p: ClientProfile | null | undefined): string {
  if (!p) return "";
  const lines = [
    `Who: ${p.summary}`,
    p.audience ? `Audience: ${p.audience}` : "",
    p.tone.description ? `Their voice: ${p.tone.description}${p.tone.dialect ? ` (${p.tone.dialect})` : ""}.` : "",
    p.tone.examples.length ? `Their own words at their best: ${p.tone.examples.map((x) => `"${x}"`).join(" · ")}` : "",
    p.tone.improve.length ? `Write better than they do now: ${p.tone.improve.join("; ")}` : "",
    p.offer.heroes.length ? `Hero products: ${p.offer.heroes.join(", ")}` : "",
    p.content.works.length ? `What works with their audience: ${p.content.works.join("; ")}` : "",
    p.direction ? `Direction: ${p.direction}` : "",
    p.tips.headlines.length ? `Headline rules: ${p.tips.headlines.join("; ")}` : "",
    p.tips.captions.length ? `Caption rules: ${p.tips.captions.join("; ")}` : "",
  ];
  return lines.filter(Boolean).join("\n").slice(0, 2400);
}
