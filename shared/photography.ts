/** Photography direction presets: lens, light and angle that every picture of the brand follows. */
export const PHOTOGRAPHY_PRESETS: { id: string; label: string; text: string }[] = [
  { id: "editorial", label: "Editorial daylight", text: "50mm lens at f/2.8, eye level, soft window daylight from one side, natural soft shadows, true colours, a light film grain; nothing staged-looking." },
  { id: "studio", label: "Product studio", text: "100mm macro lens at f/8, camera 15° above the product, one large key softbox and a thin rim light, clean seamless surface, crisp edges, every texture of the product readable." },
  { id: "golden", label: "Lifestyle golden hour", text: "35mm lens at f/2, warm backlight at golden hour, a candid moment with slight motion, lens flare kept subtle, long warm shadows." },
  { id: "hardsun", label: "Hard sun", text: "35mm lens at f/5.6, hard midday sun, crisp dark shadows, high contrast, saturated colours, surfaces that catch the light." },
  { id: "moody", label: "Moody low key", text: "85mm lens at f/2, a single warm practical light, dark surroundings, deep shadows, highlights only on the product and faces." },
  { id: "flatlay", label: "Flat lay", text: "50mm lens straight down from above, even soft light with almost no shadows, items arranged on one clean surface with breathing room." },
];
