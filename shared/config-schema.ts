import { z } from "zod";
import {
  INPUT_TYPES,
  MARKETS,
  MAX_COUNT,
  MODES,
  OUTPUT_FORMATS,
  RATIOS,
  SIZES,
  type Config,
} from "./config";
import { FORMATS, MAX_POST_COUNT, POST_TYPES, TILE_KINDS } from "./posts";

export const postSchema = z.object({
  index: z.number().int().min(1).max(MAX_POST_COUNT),
  type: z.enum(POST_TYPES),
  title: z.string().max(80),
  brief: z.string().max(2000),
  caption: z.string().max(2200),
  hashtags: z.string().max(400),
  product: z.string().max(300).optional(),
  products: z.array(z.string().max(300)).max(4).optional(),
  people: z.array(z.string().max(40)).max(3).optional(),
  format: z.enum(FORMATS).optional(),
  headline: z.string().max(80).optional(),
  shot: z.number().int().min(1).max(200).optional(),
  subline: z.string().max(120).optional(),
  overlay: z.boolean().optional(),
  ov: z
    .object({
      dx: z.number().min(-1).max(1).optional(),
      dy: z.number().min(-2).max(2).optional(),
      scale: z.number().min(0.2).max(4).optional(),
      color: z.string().max(12).optional(),
      subColor: z.string().max(12).optional(),
      align: z.enum(["center", "left", "right"]).optional(),
      logoDx: z.number().min(-1).max(1).optional(),
      logoDy: z.number().min(-2).max(2).optional(),
      logoWidth: z.number().min(0.02).max(1).optional(),
      photo: z.string().max(400).optional(),
      fade: z.boolean().optional(),
      position: z.enum(["top", "center", "bottom"]).optional(),
      typo: z
        .object({
          style: z.enum(["behind", "overlap", "repeat", "outline", "stack", "band", "sticker", "vertical", "shadow", "marker"]),
          word: z.string().max(80),
          font: z.string().max(60),
          color: z.string().max(12).optional(),
          subject: z.string().max(400).optional(),
        })
        .optional(),
      typoFor: z.string().max(400).optional(),
      typoOff: z
        .object({
          style: z.enum(["behind", "overlap", "repeat", "outline"]),
          word: z.string().max(80),
          font: z.string().max(60),
          color: z.string().max(12).optional(),
          subject: z.string().max(400).optional(),
        })
        .optional(),
    })
    .optional(),
  briefBeforeStyle: z.string().max(4000).optional(),
  tile: z.string().max(400).optional(),
  tileSpec: z
    .object({
      kind: z.enum(TILE_KINDS),
      items: z.string().max(400),
      background: z.string().max(160),
      text: z.object({
        position: z.enum(["top", "center", "bottom", "none"]),
        align: z.enum(["left", "center", "right"]),
        size: z.enum(["small", "medium", "large", "huge"]),
        color: z.string().max(12),
        style: z.string().max(80),
      }),
    })
    .optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  occasion: z.string().max(80).optional(),
  scene: z.string().max(1500).optional(),
  style: z
    .string()
    .max(80)
    .nullable()
    .optional()
    .transform((v) => v ?? undefined),
  captionFrom: z.string().max(400).optional(),
  captionHand: z.boolean().optional(),
  textCheck: z.object({ ok: z.boolean(), note: z.string().max(400), for: z.string().max(400), at: z.number() }).optional(),
  prechecks: z.object({ at: z.number(), notes: z.array(z.string().max(300)).max(12) }).optional(),
  ideaAt: z.number().optional(),
  group: z.object({ id: z.string().max(40), kind: z.enum(["carousel", "series"]), slide: z.number().int().min(1).max(10), of: z.number().int().min(1).max(10), role: z.string().max(30).optional() }).optional(),
  exact: z.boolean().optional(),
  ingredients: z.string().max(300).optional(),
  reference: z.object({ key: z.string().max(200), thumb: z.string().max(200), note: z.string().max(600).optional(), name: z.string().max(200).optional(), at: z.number() }).optional(),
  clientNote: z.object({ note: z.string().max(1000), at: z.number(), summary: z.string().max(300).optional() }).optional(),
  seenBefore: z.string().max(120).optional(),
  offer: z
    .object({
      products: z.array(z.string().max(300)).max(6),
      price: z.string().max(120),
      details: z.string().max(1000),
    })
    .optional(),
});

export const configSchema = z.object({
  /** Client (clients.id) the batch is produced for. Required for new batches. */
  client: z.string().max(80).optional(),
  theme: z.string().max(80).optional(),
  month: z
    .string()
    .regex(/^\d{4}-\d{2}$/)
    .optional(),
  postCount: z.number().int().min(1).max(MAX_POST_COUNT).optional(),
  format: z.enum(FORMATS).optional(),
  plan: z.array(postSchema).max(MAX_POST_COUNT).optional(),
  notes: z.string().max(2000).optional(),
  chat: z.array(z.object({ role: z.enum(["user", "studio"]), text: z.string().max(4000), at: z.number() })).max(60).optional(),
  campaign: z.object({ text: z.string().max(6000), at: z.number(), added: z.number().int().optional(), summary: z.string().max(600).optional(), error: z.string().max(300).optional(), only: z.boolean().optional(), styles: z.array(z.string().max(80)).max(8).optional() }).optional(),
  plannedAt: z.number().int().nonnegative().optional(),
  ambassadors: z.array(z.string().max(80)).max(3).optional(),
  exact: z.boolean().optional(),
  testPost: z.number().int().min(1).max(MAX_POST_COUNT).optional(),
  continuedFrom: z.string().regex(/^\d{4}-\d{2}$/).optional(),
  gridRef: z.string().max(80).optional(),
  gridNotes: z.string().max(12000).optional(),
  gridAt: z.number().optional(),
  gridFonts: z.object({ headline: z.string().max(80), body: z.string().max(80), why: z.string().max(400) }).optional(),
  monthFonts: z.object({ headline: z.string().max(80), body: z.string().max(80) }).optional(),
  mode: z.enum(MODES),
  /** Kept optional so batches saved before the category picker was removed still load. */
  category: z.string().max(80).optional(),
  input: z.enum(INPUT_TYPES),
  prompt: z.string().max(20000),
  ratio: z.enum(RATIOS),
  size: z.enum(SIZES),
  /** Engine model slug chosen for this batch; empty means the server default. */
  model: z.string().max(120).optional(),
  /** Images per original for modes 2-4. Mode 1 always produces six. */
  count: z.number().int().min(1).max(MAX_COUNT).default(1),
  /** Export format for the ZIP; PNG keeps the engine bytes, JPG/WebP are converted in the browser at export. */
  output: z.enum(OUTPUT_FORMATS).default("png"),
  outputQuality: z.number().int().min(50).max(100).default(90),
  /** Each JPG/WebP export fitted to 1-1.9 MB, or encoded at outputQuality. */
  outputSize: z.enum(["fit", "quality"]).default("fit"),
  /** Economy mode: Google Flex tier at half price with slower, queued delivery. Google models only. */
  economy: z.boolean().default(false),
  /** Backdrop-colour mode: comma-separated colours, one image per colour. */
  colors: z.string().max(400).default("pure white, warm beige, light grey"),
  /** Skill workflow: which ready-made prompt-builder skill writes the per-image prompt. */
  skill: z.string().max(60).default("editorial"),
  /** Skill workflow: look of a generated face when the reference face is not visible. */
  market: z.enum(MARKETS).default("auto"),
  look: z.string().max(80).optional(),
  /** Studio backdrop for mode 1 cards 2-5; identical across the set. */
  backdrop: z.string().max(1000).default("warm beige seamless paper backdrop"),
  identity: z.string().max(160).optional(),
  modelDescription: z.string().max(4000),
  center: z.boolean(),
});

/** Compile-time check that the schema produces exactly the shared Config shape. */
const _typed: z.ZodType<Config, z.ZodTypeDef, unknown> = configSchema;
void _typed;
