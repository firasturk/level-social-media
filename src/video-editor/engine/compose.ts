/**
 * One frame of the timeline, the same way for the preview and the export: which clip(s) are on
 * screen at t and at which source time (`frameAt`, shared), each clip's framing (its own or the
 * project's), the colour (look + sliders + the clip's own, LUT strength), the background, and the
 * text and logo layer at t. Only where the pictures come from differs: the preview hands in the
 * hidden <video> elements (the browser turns phone footage upright itself), the export the decoded
 * VideoFrames with the rotation read from the file. Everything else is this function.
 */
import { clipFraming, frameAt, lookOf, type VideoProject } from "@shared/video-project";
import type { Rotation } from "@shared/video-compose";
import { combineColour, type GradeSource, type Grader } from "./grader";
import type { OverlayLayer } from "./overlays";

/** A picture of one clip at a source time: the element or frame, the size it shows at, the rotation still to apply. */
export interface Picture {
  image: TexImageSource;
  width: number;
  height: number;
  rotation: Rotation;
}

/** Where the pictures come from: the clip's index on the timeline and the source time asked. Null when not ready. */
export type PictureSource = (clipIndex: number, sourceTime: number, speed: number) => Promise<Picture | null> | Picture | null;

export interface ComposeOptions {
  /** The footage untouched (hold-to-compare in the preview). */
  bypass?: boolean;
  lutStrength?: number;
}

/** Draws the timeline at t into the grader's canvas. Returns the clips that were on screen (for closing decoders). */
export async function composeFrame(grader: Grader, overlays: OverlayLayer, project: VideoProject, t: number, picture: PictureSource, opts: ComposeOptions = {}): Promise<string[]> {
  const on = frameAt(project.clips, t);
  const base = combineColour(lookOf(project.look).params, project.colour);
  const layer = overlays.draw(project.overlays, t);
  const common = { lutStrength: opts.lutStrength ?? project.lut?.strength ?? 1, bypass: opts.bypass, background: project.background, overlay: layer };
  if (!on.a) {
    grader.draw(null, null, { ...common, params: base });
    return [];
  }
  const pa = await picture(on.a.placed.index, on.a.source, on.a.placed.clip.speed);
  let b: { source: GradeSource; mix: number } | null = null;
  if (on.b) {
    const pb = await picture(on.b.placed.index, on.b.source, on.b.placed.clip.speed);
    if (pb) b = { source: { ...pb, framing: clipFraming(project, on.b.placed.clip) }, mix: on.b.mix };
  }
  const a: GradeSource | null = pa ? { ...pa, framing: clipFraming(project, on.a.placed.clip) } : null;
  grader.draw(a, b, { ...common, params: combineColour(base, on.a.placed.clip.colour) });
  return [on.a.placed.clip.id, ...(on.b ? [on.b.placed.clip.id] : [])];
}
