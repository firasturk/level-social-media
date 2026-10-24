/**
 * A Reel directed as one filmed commercial: the shared photographic direction and each shot's
 * camera setup, written as the photographic decisions themselves (light, lens, grade, framing,
 * movement) for the picture engine and the clip engine. Words such as "cinematic" alone decide
 * nothing; these lines do.
 */
import type { ReelDirection, ReelFormat, ShotPlan } from "./campaign-plan";
import { angleById } from "./angle-library";

/** The look every picture and clip must avoid (the generic generated look). */
export const LOOK_AVOID =
  "Avoid: plastic, waxy or airbrushed skin; artificial HDR; orange-and-teal grading; oversaturation; unrealistic glow or bloom; excessive background blur; wide-angle distortion of faces or the product.";

/** The motion every clip must avoid. */
export const MOTION_AVOID =
  "Motion: physically plausible and restrained, real-time speed unless slow motion is asked; small candid actions with natural timing; no floating camera, no constant orbiting, no impossible physics, no morphing.";

/** The Reel's direction as lines for a prompt, or none when the plan has none. */
export function directionLines(d: ReelDirection | undefined): string[] {
  if (!d) return [];
  return [
    "PHOTOGRAPHIC DIRECTION (one commercial: the same people, wardrobe, day, light and grade in every shot; each shot its own camera position):",
    d.look && `Look: ${d.look}`,
    d.lighting && `Light: ${d.lighting}`,
    d.colour && `Colour: ${d.colour}; skin tones natural, the product's colours exact.`,
    d.lens && `Lenses: ${d.lens}`,
    d.wardrobe && `Wardrobe and props, the same in every shot: ${d.wardrobe}`,
    d.place && `Place and continuity: ${d.place}`,
  ].filter((l): l is string => !!l);
}

/** A shot's camera setup in words: the library position, size, angle, lens, placement (what the picture is framed as). */
export function setupLine(s: Pick<ShotPlan, "framing" | "angle" | "lens" | "placement" | "angleId">): string {
  const pos = angleById(s.angleId);
  const parts = [pos && `camera position "${pos.name}": ${pos.words}`, s.framing && `shot size ${s.framing}`, s.angle && `camera ${s.angle}`, s.lens && `lens ${s.lens}`, s.placement && `composition: ${s.placement}`].filter(Boolean);
  return parts.length ? `CAMERA SETUP: ${parts.join("; ")}.` : "";
}

/** A picture set in a real place: never a studio. */
export const ON_LOCATION = "Photographed on location in a real place: no studio, no seamless or solid-colour backdrop, no pedestal, no plain matte plane behind the product.";

/** The register a Reel is made in: phone-shot creator content or a polished commercial. */
export function registerLine(format: ReelFormat | undefined): string {
  if (format === "ugc")
    return "REGISTER: authentic creator phone footage: shot on a phone, casual handheld framing, deep focus with the background readable, natural available light or a direct phone flash, phone-sensor grain and real textures, no retouch, no professional gloss; never a studio shoot or a polished commercial.";
  if (format === "tv-spot") return "REGISTER: a polished commercial filmed on location: motivated practical light, deliberate lens choices, composed frames, real places.";
  return "";
}

/** A shot's movement and speed for the clip engine; phone footage moves like a hand holds it. */
export function movementLine(s: ShotPlan, format?: ReelFormat): string {
  const move = s.camera?.trim();
  return [move && `Camera movement: ${move}${format === "ugc" ? ", handheld with a slight natural micro-shake" : ""}.`, s.speed === "slow" ? "Slow motion for this shot." : "Real-time speed."].filter(Boolean).join(" ");
}

/** What a labelled inspiration reference may lend, and what it never may. */
export function referenceLine(role: "colour" | "composition", image: number): string {
  return role === "colour"
    ? `Image ${image} is a colour reference only: borrow its palette, light quality and grade; never its subject, product, people, place or layout.`
    : `Image ${image} is a composition reference only: borrow its framing, camera height and perspective; never its subject, product, people or colours.`;
}
