/**
 * The image-to-video models of Higgsfield Cloud, with the parameters each one accepts.
 *
 * Source: the model pages of https://docs.higgsfield.ai (fetched 22 Oct 2026, the "Input schema"
 * section of each page under /docs/models/<family>/<workflow>.md). The docs give no price per
 * clip: Higgsfield bills in credits and says to ask `POST /estimate/<slug>` with the same body
 * before submitting. So every `price` here is null; the server asks the estimate endpoint at
 * submission, falls back to the admin's `video_price_<slug>` setting, and otherwise refuses until
 * the admin confirms.
 */
export interface VideoModel {
  /** The API path, also the model's id in this app ("bytedance/seedance-2.5/image-to-video"). */
  slug: string;
  name: string;
  family: string;
  note: string;
  /** Seconds: a fixed list, or a range; `default` is what the dialog opens on. */
  duration: { options?: number[]; min?: number; max?: number; default: number };
  /** The `aspect_ratio` values, or null when the model follows the picture's own framing. */
  aspect: string[] | null;
  /** The `resolution` tiers, or null when the model has no such field. */
  resolution: string[] | null;
  /** The longest prompt the model reads (characters), when the docs say. */
  promptMax: number | null;
  promptRequired: boolean;
  /** The field that turns the generated sound off, when the model makes sound. */
  audio: "generate_audio" | "sound" | null;
  /** Approximate USD per clip, or null when the docs give none (every model today). */
  price: number | null;
  docs: string;
}

const DOCS = "https://docs.higgsfield.ai/docs/models";

export const VIDEO_MODELS: VideoModel[] = [
  {
    slug: "bytedance/seedance-2.5/image-to-video",
    name: "Seedance 2.5",
    family: "ByteDance",
    note: "Natural motion, keeps the product exact; the default",
    duration: { min: 4, max: 30, default: 5 },
    aspect: null,
    resolution: ["480p", "720p", "1080p"],
    promptMax: null,
    promptRequired: false,
    audio: "generate_audio",
    price: null,
    docs: `${DOCS}/seedance-2-5/image-to-video`,
  },
  {
    slug: "kling-video/v3.0/std/image-to-video",
    name: "Kling 3.0",
    family: "Kling",
    note: "Cinematic camera moves and people",
    duration: { min: 3, max: 15, default: 5 },
    aspect: null,
    resolution: null,
    promptMax: 2500,
    promptRequired: true,
    audio: "sound",
    price: null,
    docs: `${DOCS}/kling-3/standard-image-to-video`,
  },
  {
    slug: "kling-video/v3.0/pro/image-to-video",
    name: "Kling 3.0 Pro",
    family: "Kling",
    note: "The same engine at its higher quality tier",
    duration: { min: 3, max: 15, default: 5 },
    aspect: null,
    resolution: null,
    promptMax: 2500,
    promptRequired: true,
    audio: "sound",
    price: null,
    docs: `${DOCS}/kling-3/pro-image-to-video`,
  },
  {
    slug: "kling-video/v3.0-turbo/image-to-video",
    name: "Kling 3.0 Turbo",
    family: "Kling",
    note: "Faster, with a resolution choice",
    duration: { min: 3, max: 15, default: 5 },
    aspect: null,
    resolution: ["720p", "1080p"],
    promptMax: 2500,
    promptRequired: true,
    audio: null,
    price: null,
    docs: `${DOCS}/kling-3/turbo-image-to-video`,
  },
  {
    slug: "kling-video/v2.6/pro/image-to-video",
    name: "Kling 2.6 Pro",
    family: "Kling",
    note: "Five or ten seconds, with a frame choice",
    duration: { options: [5, 10], default: 5 },
    aspect: ["16:9", "9:16", "1:1"],
    resolution: null,
    promptMax: null,
    promptRequired: true,
    audio: "sound",
    price: null,
    docs: `${DOCS}/kling-2-6/pro-image-to-video`,
  },
  {
    slug: "kling-video/v2.5-turbo/standard/image-to-video",
    name: "Kling 2.5 Turbo",
    family: "Kling",
    note: "Quick and simple",
    duration: { options: [5, 10], default: 5 },
    aspect: null,
    resolution: null,
    promptMax: null,
    promptRequired: true,
    audio: null,
    price: null,
    docs: `${DOCS}/kling-2-5-turbo/standard-image-to-video`,
  },
  {
    slug: "minimax/hailuo-2.3/standard/image-to-video",
    name: "Hailuo 2.3",
    family: "MiniMax",
    note: "Six or ten seconds, expressive movement",
    duration: { options: [6, 10], default: 6 },
    aspect: null,
    resolution: null,
    promptMax: null,
    promptRequired: true,
    audio: null,
    price: null,
    docs: `${DOCS}/hailuo-2-3/standard-image-to-video`,
  },
  {
    slug: "lightricks/ltx-2.5/image-to-video/fast",
    name: "LTX-2.5 Fast",
    family: "Lightricks",
    note: "Fast, with camera moves and a 16:9 or 9:16 frame",
    duration: { options: [6, 8, 10], default: 6 },
    aspect: ["16:9", "9:16"],
    resolution: ["720p", "1080p", "2k", "4k"],
    promptMax: 5000,
    promptRequired: true,
    audio: "generate_audio",
    price: null,
    docs: `${DOCS}/ltx-2-5/image-to-video-fast`,
  },
  {
    slug: "wan/v2.6/image-to-video",
    name: "Wan 2.6",
    family: "Alibaba",
    note: "Five, ten or fifteen seconds",
    duration: { options: [5, 10, 15], default: 5 },
    aspect: null,
    resolution: ["480p", "720p", "1080p"],
    promptMax: null,
    promptRequired: true,
    audio: null,
    price: null,
    docs: `${DOCS}/wan-2-6/image-to-video`,
  },
  {
    slug: "wan/v2.7/image-to-video",
    name: "Wan 2.7",
    family: "Alibaba",
    note: "Two to fifteen seconds",
    duration: { min: 2, max: 15, default: 5 },
    aspect: null,
    resolution: ["720p", "1080p"],
    promptMax: null,
    promptRequired: false,
    audio: null,
    price: null,
    docs: `${DOCS}/wan-2-7/image-to-video`,
  },
];

export const DEFAULT_VIDEO_MODEL = VIDEO_MODELS[0].slug;
/** The clip length the dialog opens on, and the one the motion idea is written for. */
export const VIDEO_SECONDS = 5;

export function videoModel(slug: string): VideoModel | undefined {
  return VIDEO_MODELS.find((m) => m.slug === slug);
}

/** The setting key an admin fills in Connection when the provider gives no estimate. */
export function videoPriceSetting(slug: string): string {
  return `video_price_${slug}`;
}

export interface VideoSettings {
  duration: number;
  aspect?: string;
  resolution?: string;
  /** False keeps the provider's generated sound off (the clip is an ad over the brand's own music). */
  audio?: boolean;
}

/** The lengths a model offers, as a list the dialog can show. */
export function durationChoices(m: VideoModel): number[] {
  if (m.duration.options) return m.duration.options;
  const out: number[] = [];
  for (let s = m.duration.min ?? 1; s <= (m.duration.max ?? 15); s++) out.push(s);
  return out;
}

/**
 * The settings a request may carry for a model, checked against its catalog entry. Returns the
 * clean settings or the reason they do not fit (plain English, for the dialog).
 */
export function checkVideoSettings(m: VideoModel, s: Partial<VideoSettings>): { ok: true; settings: VideoSettings } | { ok: false; reason: string } {
  const duration = Math.round(Number(s.duration ?? m.duration.default));
  if (!Number.isFinite(duration)) return { ok: false, reason: "The length must be a number of seconds." };
  if (m.duration.options && !m.duration.options.includes(duration)) return { ok: false, reason: `${m.name} makes clips of ${m.duration.options.join(", ")} seconds.` };
  if (!m.duration.options && (duration < (m.duration.min ?? 1) || duration > (m.duration.max ?? 60))) return { ok: false, reason: `${m.name} makes clips of ${m.duration.min} to ${m.duration.max} seconds.` };
  const out: VideoSettings = { duration };
  if (s.aspect) {
    if (!m.aspect) return { ok: false, reason: `${m.name} follows the picture's own frame; it has no frame choice.` };
    if (!m.aspect.includes(s.aspect)) return { ok: false, reason: `${m.name} offers these frames: ${m.aspect.join(", ")}.` };
    out.aspect = s.aspect;
  }
  if (s.resolution) {
    if (!m.resolution) return { ok: false, reason: `${m.name} has no resolution choice.` };
    if (!m.resolution.includes(s.resolution)) return { ok: false, reason: `${m.name} offers these resolutions: ${m.resolution.join(", ")}.` };
    out.resolution = s.resolution;
  }
  if (s.audio !== undefined) out.audio = !!s.audio;
  return { ok: true, settings: out };
}

/** The request body for the model, field names as its docs give them. */
export function videoRequestInput(m: VideoModel, prompt: string, imageUrl: string, s: VideoSettings): Record<string, unknown> {
  const input: Record<string, unknown> = { image_url: imageUrl, duration: s.duration };
  if (prompt.trim() || m.promptRequired) input.prompt = m.promptMax ? prompt.slice(0, m.promptMax) : prompt;
  if (s.aspect && m.aspect) input.aspect_ratio = s.aspect;
  if (s.resolution && m.resolution) input.resolution = s.resolution;
  if (s.audio === false && m.audio === "generate_audio") input.generate_audio = false;
  if (s.audio === false && m.audio === "sound") input.sound = "off";
  return input;
}
