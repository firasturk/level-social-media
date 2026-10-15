---
name: level-social-media
description: Build "Level Social Media", the social-media post studio for Level MENA's clients, by cloning and re-branding Max Fashion Studio (Hono + React on Cloudflare Workers, D1, R2, Google/Vertex, OpenAI, fal.ai, Higgsfield engines). Use this skill whenever Firas asks to set up, extend, rename, debug or deploy Level Social Media, or asks what the product does. It tells you what to reuse from the fashion studio, what the new product must do (clients instead of approaches, brand kits, product or script inputs, grids and themes, post formats), the data model, the build order and the way Firas likes to work.
---

# Level Social Media

Level Social Media is the same engine room as Max Fashion Studio with a different front door.
In the fashion studio a user picks an **approach** (Mannequin to model, Creative direction, No
prompt…) and uploads products. In Level Social Media the user picks a **client**, the client's
**visual identity** drives every image, and the input is either **product photos** or a
**script** (text). The output is social-media posts: single posts, stories, carousels and whole
**feed grids**, in the client's themes, exported ready to publish.

Read the reference files before touching code. They are the contract for the product:

| File                          | Read it when                                                                                                          |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `references/SOURCE_SYSTEM.md` | You need to know what already exists in Max Fashion Studio, which files to copy, which to rename and which to delete. |
| `references/PRODUCT_SPEC.md`  | You need to know what a screen, a client, a theme, a grid or a post must do.                                          |
| `references/DATA_MODEL.md`    | You add a table, a column, a setting key or an API route.                                                             |
| `references/PROMPTS.md`       | You write or change any prompt, rule or brief text.                                                                   |
| `references/BUILD_PLAN.md`    | You start a session: find the current phase, do the next step, deploy, report.                                        |

## Product decisions (15 October 2026, override the sections below where they differ)

Firas reviewed the first build and reset the product. These decisions win over the older text:

- **No fashion, no "batch".** Nothing from the fashion studio's UI remains: no approaches, skills,
  mood boards, model faces, poses or framing. The words in the UI are *client*, *month*,
  *Upload products*, *Generate ideas*, *Generate posts*, *Export*. The `batches` table and the
  engine loop still run underneath; a "month" is a batch row with `mode: "post"`, `client`,
  `month` (YYYY-MM) and `theme`.
- **Twelve posts a month per client** (`config.postCount`, editable). The designer does not
  choose production approaches. The only choice per post is its **type**: product, lifestyle,
  offer, tip, quote, announcement, behind the scenes, testimonial (`shared/posts.ts`).
- **Flow**: pick client → month → (brand kit and theme on the left) → Upload products →
  Generate ideas (text model writes the 12 posts: type, visual brief, caption, hashtags, product)
  → edit → Generate posts (one image per post through the engine, product photo first, one theme
  reference second, no text in the image, brand palette) → review/revise → Export ZIP named
  `<client>_<month>_post##.jpg` plus `captions.csv`.
- **Brand kit** per client: colours (name + hex), headline and body fonts, tone, caption language,
  always/never rules, past-post photos + "Analyse identity" → style text. Stored on `clients`.
- **Themes** per client are `skills` rows with `client` set (`t-<12hex>` ids, also the refs scope).
  References come from uploads or **Pinterest pin links** (`/posts/import-references` reads the
  pin's og:image). "Analyse theme" writes direction and visual language from the references.
- **UI** is a design-agency tool, not a copy of Higgsfield: left rail (brand, pages, clients),
  brand panel on the left of the workspace, month plan on the right with product strip and post
  cards. Illustrative images in `public/guide/` show each post type and the empty month.
- Server: `server/posts.ts` (themes, ideas, plan, generate, caption, captions.csv, imports,
  product removal). Prompt: `buildPostPrompt` in `shared/posts.ts`. Engine: `mode === "post"`
  branches in `server/engine.ts` (prompt, reference image, no fashion review).
- **Overlay** (done 15 Oct): `shared/overlay.ts` holds `OverlaySpec` (every metric a fraction of the
  canvas width) and the templates taken from the clients' Design Systems in Claude (`united`,
  `abusaleh`, `habibah`, `clean`, `none`). `src/lib/overlay.ts` draws logo, headline, sub-line and
  scrim on a canvas in the browser; the ideas model writes `headline`/`subline` per post; the
  export ships the overlaid JPG plus a `clean/` copy. Brand font files live in `brand_assets`
  (kind `font`) and are served at `/clients/:id/fonts/:id/file`; `clients.overlay` stores the spec.
  Habibah, United Insurance and Abu Saleh brand kits, logos, fonts and reference posts were
  imported from their Design System artifacts (claude.ai/artifact/75cn…, T6XZ…, VHWG…).
- **Grid from reference** (`POST /posts/grid-ideas`): one theme reference that shows a whole feed
  (a Pinterest pin of 9 posts) is read tile by tile by the vision model (`GRID_SCHEMA`,
  `gridIdeasInstruction`); the month's posts follow its tiles with the client's products and
  palette; `config.gridRef`/`gridNotes` make every post use that reference and
  `buildPostPrompt` adds a REFERENCE GRID block. Theme analysis now runs automatically after a
  Pinterest import or an upload (`analyseTheme`).
- **On-image editor** (`OverlayEditor.tsx`): per-post `ov` patch (offsets, scale, colours,
  align, logo offset/width) applied by `drawOverlay`; drag the text or the logo on a canvas.
- **Animate this text** (`AnimateDialog.tsx`, `recordAnimation`): fade / rise / typewriter / zoom
  entry of the headline over the still image, recorded in the browser (MediaRecorder, MP4 where
  supported, else WebM) at 1080 px.
- Still to do: per-post format, scheduling export, Pinterest board sync through the official
  API (needs a Pinterest developer app), Abira and Jubilee brand kits (no Design System yet),
  image-to-video motion through an engine.

## How to work with Firas

- Firas is the owner, not a developer. He writes in Arabic or English and expects answers in the
  language he used. Keep explanations short, name screens and buttons, never paste code at him.
- Every request ends deployed. The loop is: change → `pnpm check` (lint, typecheck, tests, build)
  → gate the deploy on the exit code → `pnpm run deploy` → smoke-test the live URL → commit on
  `main` (and the working branch if there is one) → push → tell him in two or three lines what
  changed and where to click.
- Never run a deploy if `pnpm check` failed. Grep pipelines swallow exit codes; test the exit code
  of `pnpm check` itself.
- API keys and service-account files are secrets. If one appears in a screenshot or a pasted
  message, tell him to delete and rotate it and never echo it back.
- Direct writes to D1 that change batch state were refused by the permission layer in the old
  project. Use the app's API routes or a migration instead of working around it.
- When a request is ambiguous, pick the reading a careful product designer would and say which
  one you picked. Do not stop to ask unless the two readings lead to different data models.
- He will look at results as images. When he reports a visual problem (extra limb, white bars,
  halo on the hair, pasted-on look), trace it to the prompt text or the image order first; most
  defects in the fashion studio came from contradictory instructions, not from the engine.

## The product in one screen

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ Level Social Media                                 Connection · Admin · User  │
├────────────────┬─────────────────────────────────────────────────────────────┤
│ CLIENTS        │ CLIENT: Max Fashion                        [Brand kit] [Rules]│
│ ● Max Fashion  │ Theme: ▾ Ramadan 2027   Post type: ▾ Product post            │
│ ○ Nike Jordan  │ Format: 1:1 · 4:5 · 9:16   Count: 3   Engine: Nano Banana Pro │
│ ○ Carrefour    ├──────────────────────────┬──────────────────────────────────┤
│ + Add client   │ INPUT                    │ RESULTS                          │
│                │ [Products] [Script]      │ Grid preview 3×3 · list · review │
│ Brand kit      │ drop product photos or   │ ■ ■ ■                            │
│  logo, colours │ paste the script         │ ■ ■ ■  Export ZIP · Captions CSV │
│  fonts, tone   │                          │ ■ ■ ■                            │
│  identity refs │                          │                                  │
│  grids, themes │          [ Generate ]    │                                  │
└────────────────┴──────────────────────────┴──────────────────────────────────┘
```

- **Clients** replace the approach cards. A client card shows the logo and name; the team can
  add, rename, reorder, hide and archive clients (same mechanics as `ModeCards` and the skills
  list today).
- **Brand kit** per client: logo files, colour palette, fonts, tone of voice, do/don't list,
  identity reference photos (uploaded past posts, campaign shots), feed-grid screenshots and
  **themes**. "Analyse identity" reads the uploads with a vision model and writes the client's
  style text the same way `buildSkillFromReferences` writes a skill today.
- **Rules** per client: the editable Fixed rules list (switch, edit, add, delete, restore) that
  Creative direction has now, scoped to the client, plus a global "house rules" list for Level.
- **Input** is products (photos, sets per product as today) or a script (pasted text or a .txt /
  .docx upload). A script is split into posts by the text model; each post gets a visual brief
  and a caption.
- **Themes** are the client's visual directions (Ramadan, Summer sale, Minimal white, Launch).
  A theme has its own reference library, direction text and example posts, exactly like a skill.
- **Format** is the post size: 1:1 (1080×1080), 4:5 (1080×1350), 9:16 (1080×1920), 16:9 cover.
  A **grid set** plans 3, 6, 9 or 12 images that read as one feed (alternating close/wide/graphic,
  shared palette), previewed as a 3-column grid in the order they will be posted.
- **Results** keep the fashion studio's review flow: open, compare with the original product,
  revise one image with a preset or free text, approve, export. Export is per client and theme,
  JPG fitted under 1.9 MB, ZIP split into parts under 1.4 GB, naming
  `<client>_<theme>_<post##>_<format>.jpg`, plus a `captions.csv`.

## What to reuse unchanged

Copy the repository and keep these as they are (rename only the product strings):

- The Worker, Hono API, auth, encrypted settings, D1 helpers, R2 paths, cron, batch engine loop
  (`server/engine.ts`), the retry/rate-limit/credits-depleted handling, adaptive Vertex
  concurrency.
- All engine clients: `server/google.ts`, `server/vertex.ts`, `server/openai.ts`, `server/fal.ts`,
  `server/higgsfield.ts`, the Connection dialog with its tabs and the model list.
- Vision helpers (`askVision`, framing check, scene and pose reads), the review step.
- Reference libraries (`refs` table, `ReferenceLibrary.tsx`, hover preview, mat-border trim) as
  the storage for identity photos, grids and theme references.
- The Fixed rules editor (`shared/direction-rules.ts`, `DirectionRules.tsx`) with a scope key.
- The skill builder (`server/skillbuilder.ts`) to turn uploaded identity photos into style text.
- Export (`src/lib/zip.ts`, `shared/zip-parts.ts`), image fitting, naming.
- Batches, sources, tasks, revisions, the Results tab, the Review dialog, Batches view, Admin.

## What changes

| Fashion studio                          | Level Social Media                                                                                                  |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Approach cards (modes 1–9)              | Client cards; the "approach" inside a client is the **post type** (Product post, Script post, Grid set, Story)      |
| Skill / mood board                      | **Theme** of a client (same table shape, scoped by client)                                                          |
| Creative direction fixed rules (global) | **Brand rules** per client + Level house rules                                                                      |
| Products only                           | Products **or script**                                                                                              |
| Ratios 2:3, 3:4, 4:5, 1:1               | 1:1, 4:5, 9:16, 16:9 (and 2:3 kept for fashion clients)                                                             |
| One image per card                      | Single, story, carousel slides, grid set                                                                            |
| `-AI` naming                            | `<client>_<theme>_<post##>_<format>`                                                                                |
| No text in images                       | Optional headline / CTA / logo overlay rendered in the browser with the brand fonts (engine never draws brand text) |

## Build order (short form, full detail in BUILD_PLAN.md)

0. Clone, rename, new D1 and R2, deploy as `level-social-media`. Same engines, same keys.
1. Clients table + cards + per-batch client. Hide the old approach cards.
2. Brand kit: logo, colours, fonts, tone, identity uploads, "Analyse identity", brand rules.
3. Themes per client (library + direction text + examples), theme picker on Generate.
4. Script input: paste or upload, split into posts, visual brief and caption per post.
5. Formats and grid sets, 3-column grid preview, carousel slides.
6. Overlay layer (headline, CTA, logo) in the browser; export with and without overlay.
7. Export per client and theme, captions CSV, ZIP parts.
8. Later: scheduling export (Meta/Later CSV), per-client users, cost per client.

Do one phase per session unless Firas asks for more. Deploy at the end of every phase, show him
where to click, then commit.

## Non-negotiable rules carried over from the fashion studio

- Product fidelity: a product in the photo is reproduced exactly, nothing added, removed or
  restyled. Faces of real models are preserved. Tattoos removed only when the client's rules say so.
- Anatomy and full frame: one person, correct limbs, the image fills the frame, no bars.
- Catalogue-safe wording in every prompt (`shared/safety.ts`).
- Random reference choice without repeats inside a batch; retrying an image keeps its references.
- Engine rate limits wait, they do not spend attempts; an empty balance pauses the batch with a
  top-up message naming the vendor.
- Settings holding keys are encrypted at rest and never returned by the API.

### Added 15 October 2026 (evening)
- **Feed PDF** (month toolbar): one long PDF page built in the browser (`src/lib/feedPdf.ts` renders canvases, `src/lib/pdf.ts` writes the PDF): cover with the client's logo, name and month; an Instagram-style profile with the posts in a 3-column grid (newest first, 4:5 tiles, overlay included when the Overlay toggle is on); the month's direction and a note per post (type, headline, brief, caption); a thank-you on black.
- Posts per month is a free number up to 60 (`MAX_POST_COUNT`).
- Pins are read through Pinterest's pin-info/oEmbed endpoints (the pin page returns the Pinterest logo to servers).
- Destructive actions confirm with an in-page dialog (`src/lib/confirm.tsx`), never `window.confirm`.
- The engine moves a month to the connected vendor's model before submitting; a paused month shows its reason and a Resume button.
- Product names from the ideas writer are matched loosely to uploads (`matchProduct`).
