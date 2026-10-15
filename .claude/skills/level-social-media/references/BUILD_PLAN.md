# Build plan

One phase per session unless Firas asks for more. Each phase ends deployed, smoke-tested on the
live URL, committed and pushed, with a two-line note to Firas in his language saying what
changed and where to click. Keep `pnpm check` green at every phase; add tests beside the new
shared and server code (`tests/*.test.ts`, vitest).

## Phase 0: clone and rename

- [x] New repo `firasturk/level-social-media` from `max-fashion-studio` main (history optional).
- [x] Rename package, wrangler `name`, D1 (`level-social-media`), R2 bucket, `PUBLIC_BASE_URL`,
      titles, boot screen, README, hero keys. Remove `assets/kids`; keep `assets/zaid` only as
      sample theme photos if Max Fashion is a client.
- [x] `wrangler d1 create`, `wrangler r2 bucket create`, migrations 0001–0015 applied remote.
- [x] Secrets: `SESSION_SECRET`, `INVITE_CODE`; vendor keys entered via Connection (Google API
      key, Vertex service account, OpenAI, fal, Higgsfield) as today.
- [ ] Deploy, create first account, confirm a product batch runs with the old approach UI.
      Acceptance: live URL shows "Level Social Media", one image generated on Nano Banana Pro.

## Phase 1: clients

- [ ] Migration 0016, `Client` types, routes `/clients*` (list/create/update/archive/assets).
- [ ] `ClientCards.tsx` replaces `ModeCards.tsx`: logo, name, add, rename, reorder, hide/archive.
- [ ] `config.client`, `batches.client`; Batches view filter by client; selected client remembered.
- [ ] Approach cards hidden; `mode` fixed to a single internal value.
      Acceptance: two clients created, a product batch under each, history filtered per client.

## Phase 2: brand kit and rules

- [ ] Brand kit dialog: logos, colours (hex picker with names), fonts, tone, do/don't, language.
- [ ] Identity references (`client:<id>:identity`) and grid references (`client:<id>:grid`)
      through `ReferenceLibrary` with kinds.
- [ ] `/analyze-identity` and `/analyze-grid` via `skillbuilder` pattern → `style`, `grid_rhythm`,
      editable text areas.
- [ ] House rules and client rules with `DirectionRules` scoped by setting key; brand do/don't
      lines become switchable rules.
- [ ] `buildPostPrompt` v1 (product post): product first, theme ref second, client style, rules.
      Acceptance: a product post batch for a client visibly follows its palette and style; toggling a
      brand rule changes the prompt shown in Review.

## Phase 3: themes

- [ ] Migration 0017; themes = skills with `client`; `ThemeDialog` from `SkillDialog`;
      default theme "Brand standard" auto-created from identity references.
- [ ] Theme picker in the brand panel; favourites, hide, restore, reorder.
- [ ] Theme references with `pickLeastUsed` rotation; saved looks per theme.
      Acceptance: two themes on one client give visibly different sets from the same products.

## Phase 4: script input

- [ ] Migration 0018 (sources.kind/text, tasks.post); Script tab (paste, .txt/.md/.docx).
- [ ] `/batch/plan`: split instruction with JSON schema on Gemini (API key or Vertex), OpenAI
      stand-in; plan editor (edit, delete, reorder, add, assign products).
- [ ] Engine plans one task per post; script posts without products use the theme reference as
      image 1.
- [ ] Captions per task after acceptance; shown and editable in Review.
      Acceptance: a 10-line script becomes 5–8 posts with briefs and captions, generated as 4:5.

## Phase 5: formats, grid sets, carousels, stories

- [ ] `format` replaces `ratio` in the UI; engine ratio mapping per vendor; `SOCIAL_FRAME_RULE`.
- [ ] Grid set planner (`/batch/plan` with kind grid), slot tasks, 3-column preview in posting
      order with both orders, drag to reorder, replace keeps slot, `GRID_COHESION_RULE`.
- [ ] Carousel (slides, hook/CTA) and Story (9:16, headline space).
      Acceptance: a 9-image grid set with alternating rhythm and one palette; a 5-slide carousel.

## Phase 6: overlay

- [ ] Canvas overlay in the browser: templates, brand fonts (Google Fonts or uploaded), RTL
      Arabic, logo corner, safe margins per format; live preview in Review and Results.
- [ ] `tasks.overlay` spec saved; export "with overlay" and "image only".
      Acceptance: an Arabic headline renders correctly with the client's font and logo on export.

## Phase 7: export and captions

- [ ] Naming `<client>_<theme>_<post##>_<format>`, per-client ZIP with parts, `captions.csv`.
- [ ] Spend per client in Batches and Admin.
      Acceptance: one ZIP per client/theme with fitted JPGs and a CSV that opens in Excel with Arabic
      intact (UTF-8 BOM).

## Phase 8: later

- Scheduling export (Meta Business Suite / Later CSV), per-client users with limited views,
  video covers, product library per client reused across batches, A/B variants per post.

## Session checklist

1. Read `git log --oneline -5` and the phase list; find the first unchecked item.
2. Implement, add tests, `pnpm check` (gate on exit code).
3. Migrations: `npx wrangler d1 migrations apply <db> --remote` before deploy when added.
4. `pnpm run deploy`, open the live URL, run the acceptance line for the phase.
5. Commit on `main` (and the session branch if one is assigned), push, tick the box here.
6. Tell Firas: what changed, where to click, what to test. Two or three lines, his language.
