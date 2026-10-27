/**
 * A client's own picture made in a gallery style (27 Oct). "Restyle" used to edit the picture's
 * light and mood alone, so the style's own idea (the set piece, the angle, the props) never
 * appeared. Now the card's photo becomes a product of the month, the post is written in the style
 * like any planned post (the real photo set in exactly when the style shows one product; when it
 * shows several, each card takes other products of the month so no product repeats, drawn from
 * their photos), and the usual Generate makes the picture as a new version. The photo stays under
 * Versions. Nothing here is paid: the run that follows is confirmed with its price.
 */
import type { Env } from "./env";
import { all, first, run, now, uuid } from "./db";
import { StudioError, errorMessage } from "./errors";
import { askText, assignStyles, describeProducts, ownedPlan, parseJson, productName, saveConfig } from "./posts";
import { styleRow, type StyleRow } from "./styles";
import { resizedPicture } from "./thumbs";
import type { Config } from "@shared/config";
import { isMediaPost, type Post } from "@shared/posts";
import type { User } from "@shared/types";

type SourceRow = Parameters<typeof describeProducts>[1][number];

const COUNT_SCHEMA = { type: "object", properties: { count: { type: "integer" }, same: { type: "boolean" } }, required: ["count", "same"] };

/** The question put to the vision model about a style's picture: how many product units it shows. */
export function productCountInstruction(style: Pick<StyleRow, "title" | "prompt">): string {
  return [
    `This is the reference picture of the photo style "${style.title}". Count the separate product units it shows: cups, glasses, bottles, boxes, plates, bars, jars, each counted once (a stack of three cups is 3; a crowd of tiny copies is 6). Props, ingredients, hands and people do not count.`,
    "same: true when the units are the same product repeated (the same cup three times), false when they are different products side by side.",
    `The style's prompt, for context: ${style.prompt.slice(0, 500)}`,
    'Return ONLY JSON: {"count": 1, "same": true}.',
  ].join("\n\n");
}

/**
 * How many products a style shows, read once from its picture by the vision model and kept on the
 * style (1 when the picture is gone or the answer unusable). The studio puts that many different
 * products of the month into a post made in the style.
 */
export async function styleProductCount(env: Env, style: StyleRow): Promise<number> {
  if (style.products > 0) return style.products;
  const key = style.thumb_key ?? style.image_key;
  const obj = key ? await env.BUCKET.get(key) : null;
  let count = 1;
  if (obj) {
    try {
      const raw = await askText(env, productCountInstruction(style), COUNT_SCHEMA, [{ bytes: await obj.arrayBuffer(), mime: obj.httpMetadata?.contentType || "image/jpeg" }]);
      const n = Math.round(Number(parseJson<{ count?: unknown }>(raw).count));
      if (Number.isFinite(n) && n >= 1) count = Math.min(6, n);
    } catch (e) {
      console.error("[style] product count", errorMessage(e));
    }
  }
  await run(env.DB, "UPDATE styles SET products = ? WHERE id = ?", count, style.id);
  return count;
}

const stemOf = (name: string) => name.replace(/\.[a-z0-9]+$/i, "").trim().toLowerCase();
/** A product name no other source of the month uses ("Mango", then "Mango 2", "Mango 3"). */
function freeName(base: string, taken: Set<string>): string {
  const key = (s: string) => s.normalize("NFC").toLowerCase();
  if (!taken.has(key(base))) return base;
  for (let i = 2; i < 100; i++) if (!taken.has(key(`${base} ${i}`))) return `${base} ${i}`;
  return `${base} ${uuid().slice(0, 4)}`;
}

export interface PreparedCard {
  index: number;
  /** The card's own photo, now a product of the month. */
  product: string;
  /** Other products of the month in the picture, when the style shows several. */
  extras: string[];
  /** The real photo is set in exactly (one product in the style). */
  exact: boolean;
}

export interface StyleAssign {
  index: number;
  style: string;
}

/**
 * The chosen cards made ready for their styles, all in one pass (27 Oct): each card's photo a
 * product source (its stored picture under a free name), the post a planned post again (its
 * product that photo, exact when its style shows one product, with other products of the month
 * when it shows several, rotated across the cards so two do not repeat the same extras), then
 * every style written into its post. The slow steps (counting a style's products, the smaller
 * copies, the products' notes, the style writing) run side by side; the words are not rewritten
 * here (the caption is written from the finished picture). The pictures are made by the usual
 * Generate, which the page calls next with its own confirmation.
 */
export async function prepareMediaForStyle(env: Env, user: User, batchId: string, assign: StyleAssign[]): Promise<{ prepared: PreparedCard[]; counts: Record<string, number>; plan: Post[] }> {
  const styleIds = [...new Set(assign.map((a) => a.style))];
  const styles = await Promise.all(styleIds.map((id) => styleRow(env, id)));
  const counts: Record<string, number> = {};
  await Promise.all(
    styles.map(async (st, i) => {
      if (!st?.prompt) throw new StudioError("That style is no longer in the gallery.", 404);
      counts[styleIds[i]] = await styleProductCount(env, st);
    }),
  );
  const b = await ownedPlan(env, user, batchId);
  const plan = (JSON.parse(b.config) as Config).plan ?? [];
  const t = now();
  const taken = new Set((await all<{ stem: string }>(env.DB, "SELECT stem FROM sources WHERE batch = ?", b.id)).map((r) => r.stem.normalize("NFC").toLowerCase()));
  const keyOf = new Map<number, string>();
  const inserts: { index: number; name: string; mime: string; output: string }[] = [];
  for (const { index } of assign) {
    const post = plan.find((p) => p.index === index);
    if (!post) throw new StudioError(`Post ${index} is not in the month.`, 404);
    // A planned post keeps the usual style path (the style saved, its picture a later step).
    if (!isMediaPost(post)) continue;
    const task = await first<{ output: string | null; status: string }>(env.DB, "SELECT output, status FROM tasks WHERE batch = ? AND post = ? ORDER BY updated DESC LIMIT 1", b.id, index);
    if (!task?.output) throw new StudioError(`Post ${index} has no picture to work from.`, 409);
    if (["queued", "processing", "finalizing"].includes(task.status)) throw new StudioError(`Post ${index} is being made: wait for it first.`, 409);
    keyOf.set(index, task.output);
    const have = await first<{ id: string }>(env.DB, "SELECT id FROM sources WHERE batch = ? AND key = ? AND kind = 'product'", b.id, task.output);
    if (have) continue;
    const ext = (/\.(png|jpe?g|webp)$/i.exec(task.output)?.[1] ?? "png").toLowerCase();
    const mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
    const base = (post.title || `Post ${index}`).replace(/\s*·\s*slide \d+$/u, "").trim().slice(0, 60) || `Post ${index}`;
    const name = `${freeName(base, taken)}.${ext === "jpeg" ? "jpg" : ext}`;
    taken.add(stemOf(name).normalize("NFC"));
    inserts.push({ index, name, mime, output: task.output });
  }
  // The card's picture is the product photo as it is; the smaller copy is the engine's reference.
  await Promise.all(
    inserts.map(async (x) => {
      const referenceKey = await resizedPicture(env, x.output, 720)
        .then((r) => r?.key ?? null)
        .catch(() => null);
      await run(env.DB, "INSERT INTO sources (id, batch, name, stem, key, reference_key, mime, size, role, kind, note, created) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'lead', 'product', '', ?)", uuid(), b.id, x.name, stemOf(x.name), x.output, referenceKey, x.mime, t);
    }),
  );
  // Every product of the month, described once: the style writer and the engine read the notes.
  const sources = await all<SourceRow>(env.DB, "SELECT id, name, stem, key, reference_key, kind, role, note, category FROM sources WHERE batch = ? AND kind = 'product' ORDER BY name", b.id);
  await describeProducts(env, sources);
  const pool = sources.map(productName);
  const prepared: PreparedCard[] = [];
  const used: string[] = [];
  for (const { index, style } of assign) {
    const key = keyOf.get(index);
    const src = key ? sources.find((s) => s.key === key) : undefined;
    if (!src) continue;
    const own = productName(src);
    const want = Math.min((counts[style] ?? 1) - 1, Math.max(0, pool.length - 1));
    // The products no card of this run used yet come first, then the least recently used.
    const candidates = pool.filter((n) => n !== own).sort((x, y) => used.lastIndexOf(x) - used.lastIndexOf(y));
    const extras = candidates.slice(0, want);
    used.push(...extras);
    prepared.push({ index, product: own, extras, exact: extras.length === 0 });
  }
  if (prepared.length) {
    const fresh = await ownedPlan(env, user, batchId);
    const cfg = JSON.parse(fresh.config) as Config;
    cfg.plan = (cfg.plan ?? []).map((p) => {
      const c = prepared.find((x) => x.index === p.index);
      if (!c) return p;
      // The card is a planned post again: its photo is its product; the photo stays under Versions.
      const { source: _source, media: _media, ...rest } = p;
      void _source;
      void _media;
      return { ...rest, product: c.product, products: c.extras.length ? c.extras : undefined, exact: c.exact || undefined, ideaAt: t };
    });
    await saveConfig(env, fresh, cfg);
  }
  const done = await assignStyles(env, user, batchId, assign, { words: false });
  return { prepared, counts, plan: done };
}
