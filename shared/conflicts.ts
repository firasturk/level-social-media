/**
 * What will guide one picture, in five layers, and where the inputs disagree. A style that brings
 * a hand into a month that asked for no people is a conflict the team decides, never one the
 * studio resolves quietly: the style is adapted, or the post is allowed its exception (an exception
 * on one post never becomes a brand rule). Pure functions over words; nothing here reads storage.
 */

export type ConflictKind = "people" | "hands" | "text" | "food" | "animals" | "logo" | "props";
export const CONFLICT_KINDS: ConflictKind[] = ["people", "hands", "text", "food", "animals", "logo", "props"];

export const CONFLICT_LABELS: Record<ConflictKind, string> = {
  people: "people",
  hands: "hands",
  text: "writing in the picture",
  food: "food that is not the product",
  animals: "animals",
  logo: "a logo in the picture",
  props: "extra props",
};

export type GuideLayerId = "product" | "constraints" | "composition" | "light" | "words";

export interface GuideItem {
  text: string;
  /** Where the line comes from. */
  from: "brand kit" | "brief" | "post" | "style" | "grid tile" | "theme" | "rule" | "reference" | "month";
}

export interface GuideLayer {
  id: GuideLayerId;
  label: string;
  items: GuideItem[];
}

export interface Conflict {
  kind: ConflictKind;
  /** The input that brings the element in. */
  source: "style" | "grid tile" | "theme" | "post";
  /** The constraint it goes against. */
  against: "brief" | "post" | "brand kit" | "rule";
  text: string;
  /** The post allows this exception: shown as a note, no longer a block. */
  allowed: boolean;
}

export interface GuideInput {
  brand?: { dos?: string | null; donts?: string | null; rules?: string | null; colours?: string[] };
  campaign?: { text?: string | null; summary?: string | null };
  post: { title?: string; brief: string; scene?: string; headline?: string; caption?: string; people?: string[]; allow?: string[]; type?: string; product?: string; exact?: boolean; tileSpec?: { kind?: string; scene?: string; productPlacement?: string; textPlacement?: string } | null };
  style?: { title?: string; prompt?: string } | null;
  theme?: { direction?: string | null; shots?: string[] | null; title?: string } | null;
  /** Approved rules (lessons) carried by the prompt. */
  rules?: string[];
  palette?: string[];
  pinned?: boolean;
}

const NEGATIVE: { kind: ConflictKind; re: RegExp }[] = [
  { kind: "people", re: /\b(no|without|never|not?\s+any|zero)\s+(people|persons?|humans?|models?|faces?|anyone|someone|men|women|kids|children|staff|customers?)\b|\bnobody\b|\bno one\b|\btext[- ]free\b.*\bpeople\b|\bpeople[- ]free\b|\bno human\b|بدون\s*(ناس|أشخاص|اشخاص|شخص|بشر|موديل|وجوه)|بلا\s*(ناس|أشخاص|اشخاص)/i },
  { kind: "hands", re: /\b(no|without|never)\s+(hands?|fingers?|arms?)\b|\bnot\s+held\b|بدون\s*(يد|أيدي|ايدي|إيد|ايد)/i },
  { kind: "text", re: /\b(no|without|never)\s+(text|writing|words|lettering|typography|captions?)\b|\btext[- ]free\b|\bno writing\b|بدون\s*(نص|كتابة|كلمات)/i },
  { kind: "food", re: /\b(no|without|never)\s+(food|snacks?|pastry|pastries|sweets|dishes|meals?)\b|\bsells no food\b|بدون\s*(أكل|اكل|طعام|حلويات)/i },
  { kind: "animals", re: /\b(no|without|never)\s+(animals?|pets|cats?|dogs?|birds?)\b|بدون\s*(حيوانات|قطط|كلاب)/i },
  { kind: "logo", re: /\b(no|without)\s+(logos?|watermarks?|badges?)\b(?!\s+on the words)/i },
  { kind: "props", re: /\b(no|without)\s+(props|decorations?|extras?|clutter)\b|\bnothing else\b/i },
];

const PRESENCE: { kind: ConflictKind; re: RegExp }[] = [
  { kind: "people", re: /\b(a |the |an )?(person|people|woman|women|man|men|girl|boy|child|children|kid|model|models|barista|customer|customers|waiter|chef|crowd|couple|family|friends|portrait|face|faces|someone|passers?-?by)\b/i },
  { kind: "hands", re: /\b(hands?|fingers?|palms?|held in|holding|holds|hand-held|handheld)\b/i },
  { kind: "text", re: /\b(bold text|lettering|typography|headline across|words across|a sign reading|written on|handwritten|calligraphy|text overlay|big text|large text)\b/i },
  { kind: "food", re: /\b(croissant|bread|pastry|pastries|cake|cookie|cookies|biscuit|sandwich|burger|pizza|dessert|snack|fries|salad|meal|dish|plate of)\b/i },
  { kind: "animals", re: /\b(cat|cats|dog|dogs|bird|birds|horse|animal|animals|pet|pets)\b/i },
  { kind: "logo", re: /\b(logo|watermark|badge)\b/i },
  { kind: "props", re: /\b(props|decorations|confetti|ribbons|petals|pedestal|cubes|beads)\b/i },
];

/** The constraints a text states (what it asks to leave out). */
export function constraintsOf(text: string | null | undefined): ConflictKind[] {
  if (!text) return [];
  return NEGATIVE.filter((n) => n.re.test(text)).map((n) => n.kind);
}

/** The elements a text brings in. */
export function presentIn(text: string | null | undefined): ConflictKind[] {
  if (!text) return [];
  const out: ConflictKind[] = [];
  for (const p of PRESENCE) if (p.re.test(text)) out.push(p.kind);
  // "no people" in a style's own words is a constraint, not a presence.
  const negated = constraintsOf(text);
  return out.filter((k) => !negated.includes(k));
}

const first = (t: string | null | undefined, max = 180) => {
  const s = (t ?? "").trim().split(/(?<=[.!?؟])\s+/)[0] ?? "";
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
};

/** The five layers, in the order they apply: what each input contributes to this picture. */
export function guideFor(g: GuideInput): GuideLayer[] {
  const p = g.post;
  const product: GuideItem[] = [];
  if (p.product) product.push({ text: `${p.product}: drawn from its photo${p.exact ? " and set in as the real photo (exact)" : ", as the photo shows it"}`, from: "post" });
  if (g.brand?.rules?.trim()) product.push({ text: first(g.brand.rules), from: "brand kit" });
  if (g.brand?.dos?.trim()) product.push({ text: `Always: ${first(g.brand.dos, 140)}`, from: "brand kit" });
  if (g.brand?.donts?.trim()) product.push({ text: `Never: ${first(g.brand.donts, 140)}`, from: "brand kit" });
  for (const r of (g.rules ?? []).slice(0, 3)) product.push({ text: r, from: "rule" });
  if ((g.rules?.length ?? 0) > 3) product.push({ text: `+${g.rules!.length - 3} more approved rules`, from: "rule" });

  const constraints: GuideItem[] = [];
  const campaignText = g.campaign?.text ?? "";
  const campaignNo = constraintsOf(campaignText);
  if (g.campaign?.summary?.trim()) constraints.push({ text: first(g.campaign.summary), from: "brief" });
  if (campaignNo.length) constraints.push({ text: `The brief asks for no ${campaignNo.map((k) => CONFLICT_LABELS[k]).join(", no ")}`, from: "brief" });
  const postNo = constraintsOf(`${p.brief} ${p.scene ?? ""}`).filter((k) => !campaignNo.includes(k));
  if (postNo.length) constraints.push({ text: `This post asks for no ${postNo.map((k) => CONFLICT_LABELS[k]).join(", no ")}`, from: "post" });
  if (p.people?.length) constraints.push({ text: `People in this post: ${p.people.join(", ")}`, from: "post" });
  else constraints.push({ text: "No people unless the idea names them", from: "month" });
  if (p.allow?.length) constraints.push({ text: `Allowed on this post only: ${p.allow.map((k) => CONFLICT_LABELS[k as ConflictKind] ?? k).join(", ")}`, from: "post" });

  const composition: GuideItem[] = [];
  if (g.pinned) composition.push({ text: "A picture pinned to this post is recreated: its composition wins", from: "reference" });
  if (p.tileSpec?.scene) composition.push({ text: `Grid tile: ${first(p.tileSpec.scene)}${p.tileSpec.productPlacement ? ` · product ${p.tileSpec.productPlacement}` : ""}`, from: "grid tile" });
  else if (g.style?.prompt) composition.push({ text: `Style “${g.style.title ?? "picked"}”: ${first(g.style.prompt)}`, from: "style" });
  if (p.scene?.trim()) composition.push({ text: `Shot: ${first(p.scene)}`, from: "post" });
  else composition.push({ text: `Idea: ${first(p.brief)}`, from: "post" });

  const light: GuideItem[] = [];
  if (g.theme?.direction && !g.style?.prompt && !p.tileSpec?.scene) light.push({ text: `Theme “${g.theme.title ?? ""}”: ${first(g.theme.direction)}`, from: "theme" });
  if (g.theme?.shots?.length && !g.style?.prompt) light.push({ text: first(g.theme.shots[0]), from: "theme" });
  if (g.palette?.length) light.push({ text: `Colours: ${g.palette.slice(0, 5).join(", ")}`, from: "month" });
  if (!light.length) light.push({ text: g.style?.prompt ? "The style's own light and mood" : "The product photo's light; natural, no added mood", from: g.style?.prompt ? "style" : "month" });

  const words: GuideItem[] = [];
  if (p.tileSpec?.kind === "text" && !p.product) words.push({ text: "A text tile: drawn here, never by the engine", from: "grid tile" });
  if (p.headline?.trim()) words.push({ text: `Headline “${p.headline.trim()}” drawn here on the picture, not by the engine`, from: "post" });
  else words.push({ text: "No headline on the picture", from: "post" });
  if (p.caption?.trim()) words.push({ text: `Caption: ${first(p.caption, 120)}`, from: "post" });
  words.push({ text: "The engine is told to paint no writing", from: "rule" });

  return [
    { id: "product", label: "Product identity and brand rules", items: product },
    { id: "constraints", label: "Campaign and post constraints", items: constraints },
    { id: "composition", label: "Composition", items: composition },
    { id: "light", label: "Light, palette and mood", items: light },
    { id: "words", label: "Headline, caption and artwork text", items: words },
  ];
}

/** Where a style, a grid tile or the theme brings in what the brief, the post or the brand kit asked to leave out. */
export function detectConflicts(g: GuideInput): Conflict[] {
  const p = g.post;
  const out: Conflict[] = [];
  const allowed = new Set((p.allow ?? []) as ConflictKind[]);
  const wants: { kind: ConflictKind; against: Conflict["against"] }[] = [];
  for (const k of constraintsOf(g.campaign?.text)) wants.push({ kind: k, against: "brief" });
  for (const k of constraintsOf(`${p.brief} ${p.scene ?? ""}`)) if (!wants.some((w) => w.kind === k)) wants.push({ kind: k, against: "post" });
  for (const k of constraintsOf(g.brand?.donts)) if (!wants.some((w) => w.kind === k)) wants.push({ kind: k, against: "brand kit" });
  for (const k of constraintsOf(g.brand?.rules)) if (!wants.some((w) => w.kind === k)) wants.push({ kind: k, against: "brand kit" });
  for (const r of g.rules ?? []) for (const k of constraintsOf(r)) if (!wants.some((w) => w.kind === k)) wants.push({ kind: k, against: "rule" });
  // A post that names people wants people: "no people" from the month does not apply to it.
  const peopleWanted = (p.people?.length ?? 0) > 0;
  const sources: { source: Conflict["source"]; text: string }[] = [];
  if (g.style?.prompt) sources.push({ source: "style", text: g.style.prompt });
  if (p.tileSpec?.scene) sources.push({ source: "grid tile", text: `${p.tileSpec.scene} ${p.tileSpec.productPlacement ?? ""}` });
  if (!g.style?.prompt && !p.tileSpec?.scene && g.theme?.shots?.length) sources.push({ source: "theme", text: g.theme.shots.join(" ") });
  for (const w of wants) {
    if (w.kind === "people" && peopleWanted) continue;
    for (const s of sources) {
      const present = presentIn(s.text);
      const hit = present.includes(w.kind) || (w.kind === "people" && present.includes("hands"));
      if (!hit) continue;
      const what = w.kind === "people" && !present.includes("people") ? "a hand" : CONFLICT_LABELS[w.kind];
      out.push({
        kind: w.kind,
        source: s.source,
        against: w.against,
        allowed: allowed.has(w.kind),
        text: `The ${s.source} brings in ${what}; the ${w.against} asks for no ${CONFLICT_LABELS[w.kind]}.`,
      });
    }
  }
  // The post's own shot, written by hand, can also go against the brief.
  if (p.scene?.trim()) {
    const present = presentIn(p.scene);
    for (const w of wants.filter((x) => x.against === "brief" || x.against === "brand kit")) {
      if (w.kind === "people" && peopleWanted) continue;
      if (present.includes(w.kind) && !out.some((c) => c.kind === w.kind)) out.push({ kind: w.kind, source: "post", against: w.against, allowed: allowed.has(w.kind), text: `The shot brings in ${CONFLICT_LABELS[w.kind]}; the ${w.against} asks for none.` });
    }
  }
  return out;
}

/** The conflicts that still block: not allowed on the post. */
export const blockingConflicts = (c: Conflict[]) => c.filter((x) => !x.allowed);
