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
