# Overnight report · branch `overnight-scope`

Preview: https://studio-preview.max-fashion-studio.workers.dev (worker `studio-preview`, pictures blocked, demo fixtures for every text call). Production (`studio`, levelstudio.pages.dev) was **not** deployed and `main` was **not** touched. Branch `overnight-scope` is pushed; it starts from `phase-1-workflow` at 39fadca.

Legend for every feature below: **Live** = runs against a real service in this build; **Mock** = runs against a deterministic fixture and says so in the UI ("Not connected · demo"); **Not connected** = the adapter exists, waits for a credential.

## 1. Implemented

### Mockups and the four ways (section 1)
- Start, Direction, Plan, Studio and the editor follow the approved boards (light theme by default; a saved preference still wins). The four ways keep one card design with a picture each; "Pick a style" is a primary button; Quick Campaign replaced Write a brief.
- Brand kit stays one click away: the readiness chip in the workflow top bar and on the Studio rail; the month tools, Feed PDF, WhatsApp, new grid, classic journey and delete sit under the Studio's More (⋯) menu. Nothing was removed.
- Editor: Idea / Image / Words & design / Versions, with the mockup's three choice cards (Edit this picture · about $, Make another version · about $, Edit words & layout · free), the take line, and the Text studio icon above the picture and on every card.

### Planning drafts (section 2) · Live on the preview
- `Plan it` now writes a **draft** (`plan_drafts`, migration 0061). The draft panel shows: new posts, existing posts that would change (and which fields), posts that stay exactly as they are, pictures that would belong to an older idea, and the month after applying (posts · designs · pictures · text tiles).
- **Create new posts** appends after the month's last post. Existing posts, their words, dates, revision stamps and pictures are untouched; `plannedAt` is not bumped any more (that bump was why earlier pictures were being marked as made for an older idea after an append).
- **Replace the month's posts** is a separate choice; the earlier plan and pictures go to Versions.
- Discard changes nothing. Continue never applies a draft quietly; closing the screen leaves it where it is. The typed request is kept in the browser per month until applied.
- Acceptance case walked on the preview, desktop and phone: 3 posts planned and applied, then 2 more → 5 posts, the first three deep-equal to before, `plannedAt` unchanged.

### Scope and counts (section 3)
- Plan Output cell: "N posts, one a 5-slide carousel = N designs · pictures to make · text tiles drawn here, free".
- Style: no post is chosen quietly (a "Choose the post…" placeholder; Continue refuses without one). The footer for a style operation reads "1 picture · post N · another version…" with the same figure as its button, and says the other posts are untouched. The idea before the style is shown in the post's details.
- Grid: the picker and its confirm say the whole grid is planned, one post per tile, with the tile kinds; single tiles cannot be picked on their own (stated); one test picture can be made from the Plan.
- Theme: the Direction card is titled "What the theme's description says" with a note when no reference pictures were read; reference thumbnails and counts are real.

### Input conflicts (section 4) · Live on the preview
- `shared/conflicts.ts`: five guide layers per post (product identity and brand rules · campaign and post constraints · composition · light, palette and mood · headline, caption and artwork text) with the source of each line, and conflict detection (a style, grid tile, theme shot or hand-written shot that brings in people/a hand, writing, food, animals, a logo or props against a "no …" in the brief, the post, the brand kit or an approved rule). English and Arabic negatives are read.
- A conflict blocks that post at Generate until the team takes the style off or allows the exception **on that post only** (`post.allow`); nothing becomes a brand rule. Shown on the Plan row's details with the two actions; "What will guide this picture" is a fold-out there.

### Brand memory (section 5, feature 1) · Live on the preview
- `lessons` table extended (migration 0059): category (brand_rule · campaign_instruction · post_instruction · lesson), scope, source, status, created, approver, approved_at, revision/replaces, deactivated.
- Only approved, active, in-scope items reach prompts. Review findings are proposed as **pending** lessons with their exact text (they used to land approved). Accepting a picture changes no lesson; rejecting one lesson touches no other; no bulk approve/reject/rewrite (the old clear-all keeps approved brand rules unless confirmed).
- Brand kit → "Brand memory" panel (four groups, add a rule or a month/post instruction, approve/reject, revise with history, deactivate). Direction board → "Rules that apply this month".

### Editor (section 6, feature 2)
- Text studio is now a layer editor: text, logo, image and shape layers; move/resize/rotate/hide/lock/reorder; font, size, colour, alignment, spacing; numeric crop and fit for images; the photo itself can be cropped and positioned under the layers; undo/redo; safe zones; export preview at output size with Download PNG; mixed Arabic/Latin runs render in the right order. **Apply this style to all posts** (headline, second line or logo placement) sits in the toolbar. A test fails if any of this reaches a generation route; the preview walk recorded zero generation calls while the studio was open.
- AI edit: the panel names the post, slide and source picture; Background · Lighting · Composition · Remove an object · Product correction presets; dictation with editable transcription (already present); "Mark an area" draws a region that becomes words in the instruction. The note says plainly that this engine redraws the whole picture, the area is not a hard mask, and the product is kept by instruction, not pixel-locked (Exact product is the pixel path). Every edit confirms its scope and cost before spending. Three distinct buttons: Edit this picture · Make another version · Edit words & layout (free).
- Takes and design versions are preserved as before (post_takes, month_versions); each take records cost, note and the idea revision it was made for.

### Client feedback (section 7, feature 3) · Mock interpreter on the preview; rules live
- `client_feedback` and `feedback_actions` (migration 0060). Paste, type or dictate feedback at month level (Studio → Client approval tab) or post level (editor → Idea → Client feedback). Each sentence becomes an action: original text, interpreted change, target (post · slide · version), kind (Layer edit · free / Words · free / AI image edit · paid / Idea / Unclear), ambiguity and conflict notes.
- "The second one" / "the blue one" → Unclear with "Which post?", never a guessed target. Approve and Apply are per action; layer and words edits change only `post.ov`/headline/caption (no task, no spend); image edits go through the normal Generate approval; feedback never writes memory.
- Interpreter: rules (deterministic) today; a Google/OpenAI text key switches to the model with the rules as fallback; the preview answers with a labelled demo fixture.

### OCR (section 8, feature 4) · Not connected (mock on the preview)
- `server/ocr.ts`: Google Vision adapter (REST, API key or Vertex token), deterministic mock, `resolveOcr`. `shared/ocr-check.ts`: Arabic/Latin normalisation (Arabic-Indic and Eastern digits, tashkeel, tatweel, alef and ya variants), artwork comparison (expected vs detected headline/price/numbers, fuzzy match), raw-image check (unintended or garbled writing, packaging words allowed). Low confidence → "Needs a human look", never a retake.
- Routes under `/api/studio/ocr`; `ocr_checks` table (migration 0062). Editor → Image → "Writing check (OCR)" panel with status chip, raw and final-artwork checks (the artwork is composed in the browser), expected-vs-detected table and highlighted regions.
- Engine: when connected, a raw check runs after the review and can add a flag; OCR flags are excluded from automatic retakes by construction.
- Investigation: the text seen with "Text on image" on comes from the browser overlay, not the engine (evidence in docs/ocr.md).

### Drive (section 9, feature 5) · Not connected (mock listing on the preview)
- Approved folders per client with roles (Product photos · Brand assets · References · Outputs), migration 0063; duplicates (same md5) and unavailable files (bin/404) flagged; thumbnails with name/kind; per-post reference pinning from Drive (editor → Idea → Reference from the client's Drive). Each import or pin snapshots the file id, version (modifiedTime) and md5, and copies the bytes: a later Drive change never alters what an older picture used (tested).

### Promptfoo (section 10, feature 6) · Live, offline
- `npm run eval` runs promptfoo (community, dev dependency) against our own prompt builders with the demo fixtures: 24 cases, no network. They cover the four creation methods, counts (posts vs designs vs pictures vs text tiles), append vs replace (3 + 2 = 5, first three unchanged; replace → 2), input conflicts (a hand style vs no people, now checked against `shared/conflicts.ts`), approved memory in prompts and pending memory out, reference ordering (Image 1 = product photo), hand-edited shot/headline surviving, feedback interpretation (layer / image / ambiguous against `shared/feedback.ts`), and five prompt snapshots (a words-only regression check, never visual proof). `npm run eval:paid` is opt-in and refuses to run without a key; `check` does not include evals. Docs: docs/eval.md.
- Finding from the eval: the grid writer's instruction carries no approved-memory block (asserted and commented; worth fixing).

### Langfuse (section 11, feature 7) · Not connected (adapter in place)
- docs/tracing.md maps every traceability field to where it lives in D1 today. Verdict: month, post, run, idea revision, references, engine and cost are already answerable from D1 (tasks, post_takes, spend, plan_preflights); the gaps are history of earlier takes' prompt/review/error, transient events, a named prompt version and the planner's raw answer. Langfuse is not needed for correctness; it is useful for "what exactly was sent".
- `server/trace.ts`: a configurable adapter (env or settings keys), redaction of secrets and e-mails, fire-and-forget with a 5 s timeout, never blocks generation, no-op without keys. Hooked at submit, stored, failed, review and plan written. D1 stays the authority.

### Pricing visibility (section 12) · Live
- Admin → Settings → "Who sees prices": Everyone (default, unchanged presentation) or Admins only (amounts read "(cost shown to admins)"); every confirmation, limit and ledger check stays.

## 2. What was tested

| Area | How | Result |
|---|---|---|
| Unit and route tests | `npm run typecheck`, `npx eslint .`, `npx vitest run`, `npm run build` | 66 files, 433 tests green; all under the network guard (no vendor reached) |
| Offline prompt eval | `npm run eval` | 24/24 cases, no network |
| Tracing adapter | tests/trace.test.ts | no-op without keys; request shape against a stubbed host; redaction; never rejects |
| Drafts 3 + 2 = 5 | tests/plan-drafts.test.ts and the preview walk (desktop + phone) | pass; first three unchanged, plannedAt unchanged |
| Conflicts | tests/conflicts.test.ts | pass (EN/AR constraints, style hand vs no people, exceptions, grid tile vs brand) |
| Memory | tests/memory-items.test.ts | pass (pending never in prompts, accept changes nothing, revise history, scope) |
| Feedback | tests/feedback.test.ts | pass (rules, unclear targets, layer apply makes no task/spend, no lessons) |
| OCR | tests/ocr.test.ts | pass against a **stubbed** Vision response; live Vision never ran |
| Drive | tests/drive-folders.test.ts | pass against the **mock**; live Drive never ran |
| Text studio | tests/text-studio.test.ts | pass; fetch spy fails on any network call; recording-canvas renders of every layer type |
| Preview walk (desktop and phone) | scratchpad overnight.mjs: fresh test month, four ways, draft/apply, Direction, Plan guide, Studio tabs, Text studio from the card icon; every POST recorded | 0 generation calls, 0 page errors; the test month was deleted afterwards |
| Direct design edits make no generation call | Text studio walk + text-studio test | 0 requests while the studio was open |
| Single-post operation affects only its target | plan-drafts route test (post 2 untouched by a pin), feedback apply test, style footer wording | pass |
| Versions and reference history remain | post_takes/month_versions untouched; Drive pin keeps old bytes until re-pin (test) | pass |

Not tested live tonight: Google Vision, Google Drive, the model interpreter for feedback, Langfuse ingestion, any paid picture.

## 3. Remaining work and limitations
- Masks: no engine adapter in this codebase accepts a mask; the area marker guides the instruction only (said in the UI). Brush masks are not implemented.
- Image crop in the Text studio is numeric (no on-canvas crop handles); logo variants tint the single logo file.
- Feedback rules are English-first; Arabic feedback lands as Unclear or Words until the model interpreter is connected. The approval page does not yet post `source: approval-page` feedback.
- OCR raw check allows only product names and the client name as expected print; packaging text may read as "extra" (a note, never a retake).
- Approved lessons stay brand-wide; a lesson's originating post index is not stored.
- Drafts cover Quick Campaign; "Write the ideas again" and grids keep their confirm + Versions behaviour (the grid confirm now states the full scope).
- The classic journey still calls the direct `/campaign` route (unchanged behaviour).
- The grid writer's instruction carries no approved-memory block (found by the eval; one builder change).
- `traceIdle()` is not wired into `ctx.waitUntil`; a Worker may end before a trace send completes (D1 is the authority, nothing is lost for the product).
- Prettier is not part of the gate; new files are formatted, older ones keep their style.

## 4. Preview and evidence
- Preview: https://studio-preview.max-fashion-studio.workers.dev · worker `studio-preview` · migrations 0059–0063 applied to the preview D1 only.
- Screenshots in the session scratchpad (`preview/ov-*.jpg`, `ov-phone-*.jpg`, `ts-*.jpg`): Start with the four ways, the draft panel (3 then 2), Direction with rules, Plan with the guide fold-out, Studio tabs, Text studio with Apply to all.
- Branch: `overnight-scope` (pushed), 25 commits after `phase-1-workflow`.

## 5. Connect tomorrow
1. **Google Cloud Vision** (OCR): enable the Cloud Vision API on the project; use the saved Google key (project with Vision enabled, key not restricted away from it) or give the Vertex service account the "Cloud Vision API User" role; billing on (~$1.50 per 1,000 images after the free tier). Check `GET /api/studio/ocr/status` → connected.
2. **Google Drive**: save the Vertex service account in Connection; enable the Drive API; share each client folder with the service-account email as Viewer; in the Drive picker approve folders per role (product · brand · references · outputs).
3. **Text key** (Google or OpenAI) in Connection: switches the feedback interpreter to the model and the planning/readings off the demo fixtures (billed per call by the provider).
4. **Langfuse** (only if adopted after reading docs/tracing.md): public key, secret key, host, saved as settings or env; generation never depends on it.
5. **Release** (your call, not done): merge `overnight-scope` → `main`, apply migrations 0059–0063 on the production D1, deploy `studio`. Rollback = redeploy the previous version; the migrations are additive.
6. Decisions that need you: whether prices go admins-only now; whether the classic journey should also use drafts; which Drive folders to approve per client.
