/**
 * The conversation on the Ideas and dates screen: the designer talks about the month's posts in
 * their own words ("post 3 on the kiwi mojito", "move the Christmas post to the 24th", "all the
 * captions in Jordanian Arabic", "add a Mother's Day post") and the art director understands,
 * changes exactly that, and answers in the designer's language.
 */
import { matchProduct, POST_TYPES, type Post, type PostType } from "./posts";

export interface ChatTurn {
  role: "user" | "studio";
  text: string;
  at: number;
}

export interface ChatUpdate {
  op: "update";
  index: number;
  fields: Partial<Pick<Post, "title" | "brief" | "scene" | "headline" | "subline" | "caption" | "hashtags" | "date" | "product">> & { type?: PostType };
}
export interface ChatAdd {
  op: "add";
  post: Pick<Post, "title" | "brief" | "caption" | "hashtags"> & { headline?: string; subline?: string; scene?: string; date?: string; product?: string; type?: PostType };
}
export interface ChatRemove {
  op: "remove";
  index: number;
}
export interface ChatMake {
  op: "make";
  indexes: number[];
}
export type ChatAction = ChatUpdate | ChatAdd | ChatRemove | ChatMake;

export interface ChatAnswer {
  reply: string;
  actions: ChatAction[];
  /** New standing rules for the words of every post (the month's copy brief), when the designer gave some. */
  notes?: string;
}

const FIELDS_SCHEMA = {
  type: "object",
  properties: {
    type: { type: "string" },
    title: { type: "string" },
    brief: { type: "string" },
    scene: { type: "string" },
    headline: { type: "string" },
    subline: { type: "string" },
    caption: { type: "string" },
    hashtags: { type: "string" },
    date: { type: "string" },
    product: { type: "string" },
  },
  // Every key is present (the model drops optional keys); "" means the field does not change.
  required: ["type", "title", "brief", "scene", "headline", "subline", "caption", "hashtags", "date", "product"],
};

export const IDEAS_CHAT_SCHEMA = {
  type: "object",
  properties: {
    reply: { type: "string" },
    notes: { type: "string" },
    actions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          op: { type: "string", enum: ["update", "add", "remove", "make"] },
          /** The post's number as listed (#3 is 3), never zero-based. */
          post: { type: "integer" },
          posts: { type: "array", items: { type: "integer" } },
          /** update: the fields that change, each with its full new value, "" for the rest. add: the new post's fields. */
          fields: FIELDS_SCHEMA,
        },
        required: ["op", "post", "posts", "fields"],
      },
    },
  },
  required: ["reply", "actions"],
};

export function ideasChatInstruction(r: {
  client: string;
  month: string;
  posts: Post[];
  products: { name: string; note: string }[];
  notes?: string;
  history: ChatTurn[];
  message: string;
  occasions?: { id: string; name: string; date: string }[];
}): string {
  const post = (p: Post) =>
    [
      `#${p.index} · ${p.date ?? "no date"} · ${p.type}${p.group ? ` · ${p.group.kind} ${p.group.slide}/${p.group.of}` : ""}${p.occasion ? ` · occasion ${p.occasion}` : ""}`,
      `  title: ${p.title}`,
      `  product: ${p.type === "offer" ? p.offer?.products.join(", ") || "" : p.product || "(none)"}`,
      `  headline: ${p.headline || "(none)"}${p.subline ? ` / ${p.subline}` : ""}`,
      `  idea: ${p.brief}`,
      p.scene ? `  shot: ${p.scene.slice(0, 300)}` : "",
      `  caption: ${p.caption || "(none)"} | hashtags: ${p.hashtags || "(none)"}`,
    ]
      .filter(Boolean)
      .join("\n");
  return [
    `You are the art director of a social-media studio, in a conversation with the designer about ${r.client}'s posts for ${r.month}. Read what the designer says, understand exactly what they want changed, change only that, and answer them.`,
    `THE MONTH'S POSTS NOW:\n${r.posts.length ? r.posts.map(post).join("\n\n") : "(no posts yet)"}`,
    r.products.length ? `THE PRODUCT PHOTOS (a post's product is one of these exact names; never invent a product):\n${r.products.map((p) => `- ${p.name}${p.note ? `: ${p.note}` : ""}`).join("\n")}` : "THE PRODUCT PHOTOS: none this month.",
    r.occasions?.length ? `OCCASIONS THIS MONTH: ${r.occasions.map((o) => `${o.name} (${o.date})`).join(", ")}.` : "",
    r.notes?.trim() ? `STANDING RULES FOR THE WORDS (the month's copy brief): ${r.notes.trim().slice(0, 1500)}` : "STANDING RULES FOR THE WORDS: none yet.",
    r.history.length ? `THE CONVERSATION SO FAR:\n${r.history.map((t) => `${t.role === "user" ? "Designer" : "You"}: ${t.text.slice(0, 600)}`).join("\n")}` : "",
    `THE DESIGNER SAYS NOW: "${r.message.trim().slice(0, 3000)}"`,
    "HOW TO ANSWER:",
    "- actions: what to change. update {post, fields}: post is the post's number exactly as listed (#6 is 6; the Arabic ٦ is 6); fields carries every key; a key that changes holds its complete new value, a key that does not change holds \"\" (never copy an old value back). Every field you say you changed in reply MUST have its new value in fields, and text the designer dictated is copied word for word. add {fields} for a new post (date inside the month, a product from the list or \"\"). remove {post}. make {posts} only when the designer asks for the pictures to be made or made again. post is 0 and posts [] when the op has no use for them.",
    "- THE MONTH'S POSTS above are the truth now. When the conversation says something was changed but the posts do not show it, do it now.",
    `- type is one of: ${POST_TYPES.join(", ")}. date is YYYY-MM-DD inside ${r.month}.`,
    "- The brief (idea) and the scene are written in English and describe the picture: place, subject, action, light, where the product is; never words, letters, logos or signs to draw. The headline is at most 6 words, the caption at most 10 words, both in the client's language as the other posts have them (Arabic stays Arabic).",
    "- \"post 3\" or \"بوست ٣\" means the post listed as #3. \"the Christmas post\" means the post whose title, occasion or idea says so. A change asked for \"all posts\" or \"every caption\" is one update per post.",
    "- When the designer gives a rule for the words of every post from now on (the tone, phrases to use or avoid, the language), put the full updated rules in notes and apply them to the posts' words now.",
    "- When the designer asks a question, answer it in reply with no actions. When the request is ambiguous (two posts could be meant), ask one short question in reply with no actions. Never change what was not asked.",
    "- reply: short, in the designer's own language (Arabic when they write Arabic), saying plainly what you changed (\"غيّرت بوست ٣ لموهيتو الكيوي وعدّلت الكابشن\") or asking your question. No markdown.",
    'Return ONLY JSON: {"reply": "...", "notes": "", "actions": [{"op": "update", "post": 3, "posts": [], "fields": {"product": "...", "brief": "...", "headline": "...", "caption": "...", "type": "", "title": "", "scene": "", "subline": "", "hashtags": "", "date": ""}}, {"op": "add", "post": 0, "posts": [], "fields": {"title": "...", "date": "2026-12-24", "brief": "...", "headline": "...", "caption": "...", "hashtags": "#...", "type": "lifestyle", "scene": "", "subline": "", "product": ""}}, {"op": "remove", "post": 5, "posts": [], "fields": {}}, {"op": "make", "post": 0, "posts": [3], "fields": {}}]}.',
  ]
    .filter(Boolean)
    .join("\n\n");
}

const FIELDS = ["title", "brief", "scene", "headline", "subline", "caption", "hashtags", "date", "product"] as const;

/** The model's answer, checked: known ops, real indexes, products matched to the real names, dates inside the month. */
export function parseIdeasChat(raw: unknown, posts: Post[], products: string[], month: string): ChatAnswer {
  const d = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const date = (v: unknown) => (str(v).startsWith(`${month}-`) && /^\d{4}-\d{2}-\d{2}$/.test(str(v)) ? str(v) : undefined);
  const type = (v: unknown): PostType | undefined => ((POST_TYPES as readonly string[]).includes(str(v)) ? (str(v) as PostType) : undefined);
  const product = (v: unknown) => (str(v) ? matchProduct(str(v), products) : undefined);
  const actions: ChatAction[] = [];
  for (const raw of Array.isArray(d.actions) ? (d.actions as Record<string, unknown>[]) : []) {
    if (!raw || typeof raw !== "object") continue;
    // The fields sit in their own block (or flat, when the model wrote them that way).
    const a: Record<string, unknown> = { ...raw, ...(raw.fields && typeof raw.fields === "object" ? (raw.fields as Record<string, unknown>) : {}) };
    const op = str(a.op);
    const index = Number(a.post ?? a.index);
    if (op === "update" && posts.some((p) => p.index === index)) {
      const fields: ChatUpdate["fields"] = {};
      for (const f of FIELDS) {
        if (!str(a[f])) continue;
        if (f === "date") fields.date = date(a.date);
        else if (f === "product") fields.product = product(a.product) ?? undefined;
        else fields[f] = str(a[f]).slice(0, f === "brief" || f === "scene" ? 1500 : 300);
      }
      const t = type(a.type);
      if (t) fields.type = t;
      if (Object.keys(fields).length) actions.push({ op: "update", index, fields });
    } else if (op === "add") {
      actions.push({
        op: "add",
        post: {
          title: str(a.title).slice(0, 120) || "New post",
          brief: str(a.brief).slice(0, 1500),
          scene: str(a.scene).slice(0, 1500) || undefined,
          headline: str(a.headline).slice(0, 120) || undefined,
          subline: str(a.subline).slice(0, 160) || undefined,
          caption: str(a.caption).slice(0, 300),
          hashtags: str(a.hashtags).slice(0, 300),
          date: date(a.date),
          product: product(a.product) ?? undefined,
          type: type(a.type),
        },
      });
    } else if (op === "remove" && posts.some((p) => p.index === index)) {
      actions.push({ op: "remove", index });
    } else if (op === "make") {
      const indexes = (Array.isArray(a.posts) && (a.posts as unknown[]).length ? (a.posts as unknown[]) : Array.isArray(a.indexes) ? (a.indexes as unknown[]) : [index]).map(Number).filter((i) => posts.some((p) => p.index === i));
      if (indexes.length) actions.push({ op: "make", indexes: [...new Set(indexes)] });
    }
  }
  return { reply: str(d.reply).slice(0, 1500), actions, notes: str(d.notes).slice(0, 2000) || undefined };
}
