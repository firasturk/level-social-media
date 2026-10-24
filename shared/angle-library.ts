/**
 * The camera-angle library: sixteen composition plates (a plain unbranded white cup in real
 * places) that show the planner and the picture engine a camera position, not a product. The
 * planner names one per post and per shot by id; the runner sends the plate in black and white as
 * a composition reference, so it lends framing, camera height and perspective only. Plates live in
 * R2 under `library/angles/<id>.jpg` (colour, for people) and `<id>-bw.jpg` (for the engine).
 */
export interface CameraAngle {
  id: string;
  name: string;
  /** The camera decision in words, for the planner and the picture prompt. */
  words: string;
  /** Distance band, for the Reel's variety rule. */
  band: "tight" | "mid" | "wide";
  /** The register it suits best ("any" for both). */
  register: "tv-spot" | "ugc" | "any";
}

export const CAMERA_ANGLES: CameraAngle[] = [
  { id: "handoff-lens", name: "Hand-off to the lens", words: "a hand pushes the product toward the lens; product very close, large and slightly foreshortened in the lower third, the arm receding, the place deep behind; 24 mm look, chest height", band: "mid", register: "any" },
  { id: "worms-eye", name: "Worm's-eye", words: "camera on the ground looking straight up; the product held up toward the lens against open sky and rooftops; 20 mm look", band: "mid", register: "any" },
  { id: "ground-level", name: "Ground level", words: "camera on the pavement or curb; the product sharp in the foreground on a third, the street and passers-by receding behind, soft; 28 mm look", band: "wide", register: "tv-spot" },
  { id: "pov-hand", name: "First-person POV", words: "first-person view: the viewer's own hand holds the product in the lower half, the place ahead in deep focus; phone-wide lens, slight tilt", band: "mid", register: "ugc" },
  { id: "over-shoulder", name: "Over the shoulder", words: "camera just behind a person's shoulder, the shoulder soft and dark in the foreground; the product in their hand sharp; the place ahead; 35 mm look", band: "mid", register: "tv-spot" },
  { id: "top-flash", name: "Top-down flash", words: "straight top-down onto a table lit by a direct on-camera flash: hard frontal light, crisp shadows, dark falloff at the edges; hands reaching in; candid party-photo look", band: "mid", register: "ugc" },
  { id: "flat-lay", name: "Daylight flat lay", words: "straight top-down flat lay in hard window light with long graphic shadows; the product on a third among a few real objects, natural asymmetry; 50 mm look, f/8", band: "mid", register: "tv-spot" },
  { id: "macro-rim", name: "Macro detail", words: "macro: one detail of the product (rim, surface, texture) fills the frame, back-lit, background dark with soft lights; 100 mm macro look, camera at the detail's height", band: "tight", register: "tv-spot" },
  { id: "through-glass", name: "Through the window", words: "shot from outside through a window: reflections and drops on the glass, the product sharp on the ledge behind it, the inside soft; 50 mm look", band: "mid", register: "tv-spot" },
  { id: "foreground-frame", name: "Framed through the foreground", words: "shot through something very close to the lens (leaves, a doorway, a gap) that frames the product, soft; the product sharp off-centre; 85 mm look", band: "mid", register: "tv-spot" },
  { id: "table-level", name: "Table level", words: "camera at the table surface; the surface leads from a sharp foreground into depth; the product in profile on a third; side light; 50 mm look", band: "mid", register: "tv-spot" },
  { id: "wide-place", name: "Wide place", words: "wide environmental shot: a person small in a big real place, the product readable in the hand, the architecture and sky dominate; 24 mm look", band: "wide", register: "tv-spot" },
  { id: "dutch-motion", name: "Dutch tilt in motion", words: "frame tilted about 15 degrees; a person walks quickly with the product at hip height, sharp, the background streaked with slight motion blur; candid street energy", band: "wide", register: "ugc" },
  { id: "sip-crop", name: "Sip close-up", words: "extreme crop on the moment of use: the lower half of a face, lips at the rim, the product filling the lower centre; natural skin texture; 85 mm look", band: "tight", register: "any" },
  { id: "shadow-play", name: "Hard-sun shadow", words: "the product held against a plain wall in hard sun; hand and product cast a long crisp graphic shadow diagonally across the wall", band: "tight", register: "tv-spot" },
  { id: "high-45", name: "High three-quarter", words: "high three-quarter angle, about 45 degrees down onto a table by a window; the product on a third, a plate and resting hands near it, window light from the side; 35 mm look", band: "mid", register: "any" },
];

export const angleById = (id: string | undefined | null): CameraAngle | null => (id ? CAMERA_ANGLES.find((a) => a.id === id.trim()) ?? null : null);

/** The plate's R2 key: black and white for the engine, colour for people. */
export const anglePlateKey = (id: string, forEngine = true) => `library/angles/${id}${forEngine ? "-bw" : ""}.jpg`;
