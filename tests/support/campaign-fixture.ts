/**
 * A campaign of 3 image posts and 4 multishot Reels (16 shots), built so every count can be checked
 * by hand:
 * - vid-1, vid-2: a start-image shot (the key frame), a start-image shot (Change camera), an
 *   animated shot from the key frame, a shot from the client's Drive clip;
 * - vid-3: four start-image shots (the key frame, then three Change camera frames);
 * - vid-4: no key frame: three shots animated from the client's photos, one Drive photo as it is.
 * So: 16 shots, 3 existing, 13 clips, 3 key frames, 5 camera frames, 11 pictures in all.
 */
import { normalizePlan, type CampaignPlan, type ClipEngine, type ImageEngine, type PlanRef, type PriceBook, type ShotPlan } from "../../shared/campaign-plan";

export const IMAGE_ENGINE: ImageEngine = { kind: "engine", model: "gemini-3.1-flash-image" };
export const FRAME_ENGINE: ImageEngine = { kind: "mg-camera", model: "images_change_camera" };
export const CLIP_ENGINE: ClipEngine = { provider: "higgsfield-mcp", model: "kling-3.0", name: "Kling 3.0" };
export const DEFAULTS = { imageEngine: IMAGE_ENGINE, frameEngine: FRAME_ENGINE, clipEngine: CLIP_ENGINE, frame: "9:16" as const, videoSeconds: 15 };

export const driveClip: PlanRef = { kind: "asset", id: "drive-clip-1", label: "Pouring shot.mp4", thumb: null, from: "the client's Drive", media: "clip" };
export const drivePhoto: PlanRef = { kind: "asset", id: "drive-photo-1", label: "Mango cup.jpg", thumb: null, from: "the client's Drive", media: "photo" };
export const inspiration: PlanRef = { kind: "reference", id: "style-9", label: "Sunlit street (Styles)", thumb: null, from: "Styles library" };

const shot = (key: string, source: ShotPlan["source"], asset: PlanRef | null = null, seconds = 3): Partial<ShotPlan> => ({ key, seconds, action: `${key} action`, framing: "medium", camera: "slow push in", reference: inspiration, source, asset, text: `${key} words` });

export function campaign3x4(): CampaignPlan {
  return normalizePlan(
    {
      summary: { concept: "Summer of mango", mix: "3 posts, 4 Reels", together: "The posts announce, the Reels show it poured." },
      images: [1, 2, 3].map((n) => ({ key: `img-${n}`, selected: true, idea: `Post ${n}`, objective: "awareness", product: { id: "p1", name: "Mango cup", from: "library", thumb: null }, visual: "sunlit", reference: inspiration, headline: `H${n}`, caption: `C${n}`, cta: "Order now", engine: IMAGE_ENGINE, outputs: 1 })) as never,
      videos: [
        { key: "vid-1", shots: [shot("s1", "start-image"), shot("s2", "start-image"), shot("s3", "animate"), shot("s4", "existing", driveClip)] },
        { key: "vid-2", shots: [shot("s1", "start-image"), shot("s2", "start-image"), shot("s3", "animate", null, 6), shot("s4", "existing", driveClip)] },
        { key: "vid-3", shots: [shot("s1", "start-image"), shot("s2", "start-image"), shot("s3", "start-image"), shot("s4", "start-image")] },
        { key: "vid-4", shots: [shot("s1", "animate", drivePhoto), shot("s2", "existing", drivePhoto), shot("s3", "animate", drivePhoto), shot("s4", "animate", drivePhoto)] },
      ].map((v) => ({ ...v, selected: true, concept: `${v.key} concept`, hook: "Wait for it", product: { id: "p1", name: "Mango cup", from: "library", thumb: null }, frame: "9:16", music: { direction: "upbeat", trackId: null, trackTitle: null }, transitions: "cuts", look: "", cta: "Order now", caption: "c", voiceover: "", keyFrameEngine: IMAGE_ENGINE, frameEngine: FRAME_ENGINE, clipEngine: CLIP_ENGINE })) as never,
    },
    DEFAULTS,
  );
}

/** Prices as the server would learn them: the image engine's list price, Magnific's and Higgsfield's own estimates. */
export const PRICES: PriceBook = {
  "image:gemini-3.1-flash-image": { amount: 0.101, unit: "usd", source: "catalog" },
  "tool:mg-camera": { amount: 10, unit: "magnific-credits", source: "provider" },
  "clip:higgsfield-mcp:kling-3.0:5:9:16": { amount: 30, unit: "higgsfield-credits", source: "provider" },
  "clip:higgsfield-mcp:kling-3.0:10:9:16": { amount: 55, unit: "higgsfield-credits", source: "provider" },
};
