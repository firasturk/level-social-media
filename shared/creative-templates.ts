/**
 * Higgsfield Marketing Studio templates a Reel can be made from instead of a filmed lifestyle
 * storyboard: one generation from the product's photo and a written brief makes the whole video
 * (no key frame, no shot pictures). The fifteen Firas chose (24 Oct), each described from its preview
 * so the planner can match a template's mechanic to an idea. Credits as Higgsfield priced each one
 * for a product photo on 24 Oct (`get_cost`); null where it was not asked.
 */
export type TemplateFamily = "video_mode" | "hypermotion" | "mixed_media";

export interface CreativeTemplate {
  id: string;
  name: string;
  family: TemplateFamily;
  /** Length of the template's video, seconds. */
  seconds: number;
  credits: number | null;
  /** What happens in it, beat by beat (from its preview). */
  mechanic: string;
  /** The ideas and products it fits. */
  bestFor: string;
  /** People on screen: none, optional, or the template is built on a person. */
  person: "none" | "optional" | "needed";
  /** What a brief for this brand's audience must change from the preview. */
  adapt: string;
  /** Higgsfield's own preview video. */
  preview: string;
}

const MS = "https://d29nkk4626dxhc.cloudfront.net/marketing_studio_video_preset";
const MOTION = "https://cdn.higgsfield.ai/marketing-studio-motion-preview";

export const CREATIVE_TEMPLATES: CreativeTemplate[] = [
  {
    id: "bedf8af1-02d9-4fd7-9ba6-3dfcf97a31e4",
    name: "TV Spot",
    family: "video_mode",
    seconds: 10,
    credits: 70,
    mechanic: "a polished broadcast commercial: a person enjoys the product, a fun moment with friends, two close hero shots of the product with condensation or steam, a wide closing shot with a short tagline",
    bestFor: "launches and brand awareness for drinks and food, when the product itself is the star",
    person: "optional",
    adapt: "the preview is a pool party in swimwear: set it in a modest, local scene (a terrace, a car, a café, a family table) with the brand's cast dressed modestly; no toasting",
    preview: `${MS}/bedf8af1-02d9-4fd7-9ba6-3dfcf97a31e4-f03c0e8e212e6a34.mp4`,
  },
  {
    id: "3787dd10-0ef2-4645-86ba-1ddd02400b8a",
    name: "Wild Card · Giant Jelly Kick",
    family: "video_mode",
    seconds: 12,
    credits: 84,
    mechanic: "an action stunt: a person runs at a giant, glossy version of the product's ingredients in a stadium at sunset, kicks it and it bursts into pieces, then talks to camera holding the pack",
    bestFor: "sweets, desserts and drinks with colourful ingredients; energetic, youthful ideas",
    person: "needed",
    adapt: "the person is one of the brand's cast (a young man unless the brand says otherwise), dressed modestly; the giant object is the product's own ingredients",
    preview: `${MS}/3787dd10-0ef2-4645-86ba-1ddd02400b8a-da50f8793349baaf.mp4`,
  },
  {
    id: "0fccea17-f6f1-4e3b-a635-b48dd93a85be",
    name: "Wild Card · Delivery Skit",
    family: "video_mode",
    seconds: 10,
    credits: 84,
    mechanic: "a short cinematic comedy skit: a person waiting on the couch, the doorbell, a rush to the door, the delivery seen through the peephole, the box opened and the first bite",
    bestFor: "delivery, takeaway and food brands; craving and impatience ideas",
    person: "needed",
    adapt: "a local living room, the brand's cast; the delivered box or cup is the product exactly as photographed",
    preview: `${MS}/0fccea17-f6f1-4e3b-a635-b48dd93a85be-c3aa277abeeeeae0.mp4`,
  },
  {
    id: "04a5d814-1547-4c1f-929d-e0ce169b339b",
    name: "Wild Card · Giant Wave Chase",
    family: "video_mode",
    seconds: 12,
    credits: 84,
    mechanic: "a surreal chase: a person sprints down a city street away from a giant rolling wave of the product's ingredients, ending on a hero shot of the product",
    bestFor: "fruity or indulgent products; big, surprising, scroll-stopping ideas",
    person: "needed",
    adapt: "a street in the brand's city, the brand's cast dressed modestly; the wave is the product's own ingredients",
    preview: `${MS}/04a5d814-1547-4c1f-929d-e0ce169b339b-a223e78ad7b8c947.mp4`,
  },
  {
    id: "f27dd492-3500-4cab-8908-3761e90e2c3a",
    name: "Reboxing",
    family: "video_mode",
    seconds: 10,
    credits: 70,
    mechanic: "a satisfying first-person restock: hands fill an empty fridge or shelf with the product, row after row, until it is full",
    bestFor: "packaged products, new stock, abundance and 'it's back' ideas",
    person: "none",
    adapt: "hands only; the packs are the product exactly as photographed",
    preview: `${MS}/f27dd492-3500-4cab-8908-3761e90e2c3a-641858734e476a04.mp4`,
  },
  {
    id: "6017577c-d9f9-4d1a-87d6-26e96e8e4f25",
    name: "Giant Figure",
    family: "video_mode",
    seconds: 12,
    credits: 84,
    mechanic: "a creator talks to camera holding the product on a city street, then turns to reveal a giant statue of the product standing behind them, and stands beside it",
    bestFor: "a new product or a new pack; launch and hype ideas",
    person: "needed",
    adapt: "the creator is one of the brand's cast (a young man unless the brand says otherwise), dressed modestly, in a street of the brand's city",
    preview: `${MS}/6017577c-d9f9-4d1a-87d6-26e96e8e4f25-19ef25a6c2ac8cc9.mp4`,
  },
  {
    id: "fd5645a1-1cfc-4db1-bc9c-2b5a043e3079",
    name: "Chili Burst",
    family: "hypermotion",
    seconds: 15,
    credits: 78,
    mechanic: "ingredient-led hypermotion: macro shots of the ingredients bursting and pouring, big bold kinetic words between them, ending on the product as a hero with a 3D title",
    bestFor: "products defined by an ingredient or a taste (spicy, chocolate, fruit); no people needed",
    person: "none",
    adapt: "the ingredients are the product's real ones; the words are short and true to the product, never invented claims",
    preview: `${MOTION}/5b54eb77-0ebb-4e84-91fb-b53ee9e7d87f.mp4`,
  },
  {
    id: "cea9def5-33a2-4c60-b4f8-a46c1094f4c4",
    name: "Candy Color Swap",
    family: "hypermotion",
    seconds: 15,
    credits: null,
    mechanic: "the pack spins and floats against flat backgrounds that swap colour on every cut, with close-ups of its details, ending on a title card",
    bestFor: "colourful packs and cups; playful product reveals; the brand's palette as backgrounds",
    person: "none",
    adapt: "background colours from the brand's palette; only the product's real details",
    preview: `${MOTION}/2270a163-40c5-4908-a3bc-bb18807d85fd.mp4`,
  },
  {
    id: "000b690e-7f6d-4a7c-9196-a90f15494bb6",
    name: "Pixel Block Yard",
    family: "mixed_media",
    seconds: 15,
    credits: null,
    mechanic: "mixed media: a macro of the product, 3D pixel letters and dice flying around it, the product flying over a yard of colourful shipping containers and landing on one under the sun",
    bestFor: "youthful, playful brands and drinks; gaming or summer moods",
    person: "none",
    adapt: "the pixel letters use the brand's palette; no other brands' words",
    preview: `${MOTION}/353daae1-e520-486b-b7d5-83f026169305.mp4`,
  },
  {
    id: "be48cd11-9821-4be2-9d31-b33ba7a68ce1",
    name: "Crunch Heat Umami",
    family: "hypermotion",
    seconds: 14,
    credits: null,
    mechanic: "appetite close-ups: the product as hero, a spoon lifting its texture with one bold word on screen, a drizzle or pour, a hand bringing a spoonful to camera, a flat lay of several packs among the ingredients, a final hero shot",
    bestFor: "food with texture you can see (sauces, toppings, desserts, crispy or creamy things); craving ideas",
    person: "optional",
    adapt: "hands only, the brand's cast if any; the words are one or two true ones about taste or texture",
    preview: `${MOTION}/e2a96084-9c1a-4d05-840e-d9b9bab41a7a.mp4`,
  },
  {
    id: "e1fadf0c-2aef-43a7-b9e8-81bcb78982e4",
    name: "Illustration",
    family: "mixed_media",
    seconds: 15,
    credits: null,
    mechanic: "mixed media: the real product photographed in a real street with 2D cartoon characters and doodles (stars, bubbles, splashes) drawn around it, leaning on it, throwing it and lounging beside it",
    bestFor: "youthful brands and drinks; playful, street-culture ideas; making a product feel like a character",
    person: "none",
    adapt: "a street of the brand's city; the drawn characters are young men and boys only, modestly dressed, unless the brand says otherwise; doodles in the brand's palette",
    preview: `${MOTION}/ceed4b26-b7f5-4557-9221-510263d4b976.mp4`,
  },
  {
    id: "4f191523-f0fc-453d-b82f-cfbabf6a166d",
    name: "Chili Flake Drift",
    family: "hypermotion",
    seconds: 15,
    credits: null,
    mechanic: "the pack floats in slatted window light while its ingredients drift and rain around it and pile up below, then on a clean pastel background the lid lifts off for the hero shot",
    bestFor: "ingredient-led products in a jar, tub or cup with a lid; calm, premium ideas",
    person: "none",
    adapt: "the drifting ingredients are the product's own; the background in the brand's palette",
    preview: `${MOTION}/7a457f4a-0925-4c6b-a0a5-dc036b68f776.mp4`,
  },
  {
    id: "29d153c2-cc42-451a-a91c-6127c165985e",
    name: "Plum Studio Hero",
    family: "hypermotion",
    seconds: 8,
    credits: null,
    mechanic: "a short premium bakery spot: the box with a few ingredients around it, a macro of the baked surface, the product breaking open in slow motion behind one short line of text, ending on the brand's name on a deep coloured background",
    bestFor: "pastries, cakes, desserts and anything with an inside worth showing; freshness and quality ideas",
    person: "none",
    adapt: "the inside is the product's real one; the line is short and true (no invented claims); the background colour from the brand's palette",
    preview: `${MOTION}/444d3ce1-130a-466d-aba5-240e67eef14a.mp4`,
  },
  {
    id: "00f3a579-54dd-4d1c-aa5b-8672f5af0ede",
    name: "Pastel Beat Pop",
    family: "hypermotion",
    seconds: 15,
    credits: null,
    mechanic: "beat-synced macro details of the pack (lid, logo, label, back) on pastel backgrounds that swap colour on every beat, ending on a black title card",
    bestFor: "packs and cups with a strong design; music-led, playful launches",
    person: "none",
    adapt: "backgrounds from the brand's palette; only the product's real details and words",
    preview: `${MOTION}/0cbd94d9-0457-4a89-ab65-b200659bb14d.mp4`,
  },
  {
    id: "9fdcd3a3-63a6-40a5-9436-eef4c261fa26",
    name: "Whip-Pan Quartet",
    family: "hypermotion",
    seconds: 12,
    credits: null,
    mechanic: "fast whip-pans between four flavours or colours of the product, each on a background of its own colour, ending on the four side by side",
    bestFor: "a range: several flavours, sizes or colours of one product line",
    person: "none",
    adapt: "the four are the brand's real variants (from its product list); backgrounds matched to each",
    preview: `${MOTION}/7b41197b-0b4a-4d4b-af84-77cf99840846.mp4`,
  },
];

export const templateById = (id: string | undefined | null): CreativeTemplate | null => (id ? CREATIVE_TEMPLATES.find((t) => t.id === id.trim()) ?? null : null);

/** The price key's model part for a template Reel. */
export const templateModel = (id: string) => `template:${id}`;
