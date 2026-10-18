/**
 * The skillbook: every skill and library the studio works with, what each does and where it lives,
 * so the team sees what the system knows and a developer knows where to extend it.
 */
export interface Skill {
  id: string;
  title: string;
  /** What it does for a month of posts. */
  what: string;
  /** Where the team meets it. */
  where: string;
  /** The code that holds it. */
  files: string[];
}

export const SKILLBOOK: Skill[] = [
  {
    id: "autopilot",
    title: "Autopilot",
    what: "Runs the whole journey for a client: reads its profile, picks products from Drive, picks the grid, writes ideas and shots, fixes, generates, writes captions and sets the typography.",
    where: "The journey's first screen (admins).",
    files: ["shared/autopilot.ts", "server/autopilot.ts", "src/studio/Journey.tsx"],
  },
  {
    id: "profile",
    title: "Client Analysis",
    what: "Reads the client's Instagram, website and the brands it is compared with; writes its voice, offer, branding and tips; suggests grids.",
    where: "The profile card on the journey's first screen.",
    files: ["shared/profile.ts", "server/profile.ts", "server/meta.ts"],
  },
  {
    id: "grids",
    title: "Grid fidelity",
    what: "A month follows a feed grid tile by tile: the tiles are read, each post takes its tile's role, words, lettering and colours; the test grid previews the whole feed.",
    where: "Visual identity → Pick a grid; Test grid.",
    files: ["shared/posts.ts", "shared/testgrid.ts", "server/posts.ts", "server/engine.ts"],
  },
  {
    id: "drive",
    title: "Drive knowledge",
    what: "Reads every photo (and video frame) in the client's Drive and sorts it: packshot, lifestyle, drink, shop, kitchen & factory, people, design. Products are picked from it; place tiles are set in the real shop.",
    where: "Products → Drive; Recommended products; Fill from Drive.",
    files: ["shared/drive.ts", "server/drive.ts", "src/studio/DrivePicker.tsx"],
  },
  {
    id: "products",
    title: "Product matching and exact product",
    what: "Finds each post's product among the month's, the gallery's and Drive's photos; exact mode sets the real photo into the picture and blends it.",
    where: "Props and shots → Recommended products; Test grid → Exact product.",
    files: ["shared/drive.ts", "server/exact.ts", "server/compose.ts", "src/studio/ProductSwap.tsx"],
  },
  {
    id: "review",
    title: "Automatic review and fixes",
    what: "Every picture is checked against its product photo: product truth, size, invented items, writing, bags, foreign items, people, tile drift, AI look. Next fixes what it can by itself.",
    where: "Generate step; the issues list on every screen.",
    files: ["shared/qa.ts", "server/engine.ts", "src/studio/Journey.tsx"],
  },
  {
    id: "realism",
    title: "Real people",
    what: "Rules that keep people photographed, not generated (skin, light, lens, candid moment); the client's real-people references; one automatic realism pass when the review flags an AI look.",
    where: "Brand kit → Real people; ambassador portraits.",
    files: ["shared/realism.ts", "server/ambassadors.ts", "server/engine.ts"],
  },
  {
    id: "wardrobe",
    title: "Wardrobe",
    what: "Outfits for the month's ambassadors in the month's colours, modest where the person's rules say so; each post wears one.",
    where: "Props and shots → Wardrobe.",
    files: ["shared/posts.ts", "server/posts.ts", "src/studio/BrandPanel.tsx"],
  },
  {
    id: "typography",
    title: "Typography",
    what: "Each post's words set as design: a big word behind or across the product (the product cut out as a matte), repeated or outlined, in a second font; a switch brings the plain headlines back.",
    where: "Feed step and studio toolbar → Typography styles; Text on image.",
    files: ["shared/typography.ts", "server/posts.ts", "src/lib/overlay.ts", "src/studio/TypographyControls.tsx"],
  },
  {
    id: "captions",
    title: "Captions from the pictures",
    what: "Captions and hashtags written from each finished picture in the brand's tone and language, with the client's profile.",
    where: "Captions step.",
    files: ["shared/posts.ts", "server/posts.ts"],
  },
  {
    id: "styles",
    title: "Style library",
    what: "Photo styles and feed grids read from Pinterest pins, scored against the team's bar, refreshed daily, approved by an admin; a style is rewritten for a post's real product.",
    where: "Styles; Approvals.",
    files: ["shared/styles.ts", "server/styles.ts", "src/studio/StyleGallery.tsx"],
  },
  {
    id: "versions",
    title: "Month versions",
    what: "Every month keeps its earlier plans and pictures; a version opens as the feed it was and comes back to the studio whole or one picture at a time.",
    where: "Studio → Earlier versions.",
    files: ["server/posts.ts", "src/studio/MonthVersions.tsx"],
  },
  {
    id: "share",
    title: "Client approval link",
    what: "A link that opens on the month's feed; the client approves each post or asks for a change, and the comment comes back to the Feed step with a Make the change button.",
    where: "Feed step → Copy the client's approval link.",
    files: ["server/share.ts", "src/share/SharePage.tsx", "src/studio/JourneyResults.tsx"],
  },
  {
    id: "audit",
    title: "System check",
    what: "Checks production: connected tools, background jobs, every client and month, the library, storage and the month's writing; runs daily and tells the admin when something is wrong.",
    where: "Admin → System check.",
    files: ["shared/audit.ts", "server/audit.ts", "src/studio/AdminView.tsx"],
  },
];
