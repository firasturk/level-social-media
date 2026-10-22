# UX round · branch `ux-round`

Preview: https://studio-preview.max-fashion-studio.workers.dev (worker `studio-preview`; pictures blocked; demo fixtures answer every text call). Nothing was merged into `main` or deployed to production. No paid call was made. No campaign data was deleted; the four empty "Habibah · 2026-10 · grid 6" months from the double-create burst were left in place.

Built as four parallel branches on top of `connect-tools` (which carries the four integrations from the previous round) and merged here: `ux/start-grids` (sections 1–3), `ux/drive-products` (4–5), `ux/plan-scope` (6–9), `ux/editor-text` (10–14). Gate chain on the merge: typecheck, eslint, 569 tests (133 new), build.

## 1. Implemented and verified

Verified by tests and by a Playwright walk on the preview (desktop 1440 px and phone 390 px), with zero generation calls and zero page errors.

- **Campaign size on Start (1)**: posts · designs · images still to generate as three distinct numbers; editable posts / carousels / slides per carousel / separators / designs per separator / format with live arithmetic; a month with posts gets "Saved plan"; bigger size → explicit "Add N posts" through the existing append path, smaller never removes anything. Tests cover the arithmetic, defaults and the settings round trip.
- **Grid preview before applying (3)**: the grid picture with a numbered tile overlay, actual post count, single/carousel distribution, images to generate vs free text tiles, rows × columns, per-tile purpose/position/background/where the words sit; "Analysing the grid…" state and a concrete failure state. On the preview: "9 posts in the grid · 9 designs, all single pictures · 8 images to generate · 1 text tile drawn here, free · 3 rows × 3 columns" with the nine tiles listed.
- **Grid count mismatch (1)**: "Use the grid's N posts" / "Adapt to my M posts" as two radio choices with a paragraph each; apply refuses until one is chosen. Tests: grid-ideas with 9/6/12 produce plans of 9/6/12.
- **Four methods, consistent (2)**: same card anatomy with Needs / Creates / Controls lines and one blue action pill when selected; the style route has a primary "Pick a style"; saved-plan banner ("Saved plan · 10 posts · 14 designs · 8 images still to generate … the saved posts never change by themselves") and the brief box headed "New request · writes a draft you review first".
- **Double-create of months (investigation)**: cause found (the Start board's "Fresh grid in …" shortcut and the month-create route had no guard). Fixed client-side (one in-flight create per client+month) and server-side (same owner+client+month+name within 60 s returns the existing month; concurrent bursts collapse to one row). Tests: five concurrent creates → one month.
- **Product assignment bug (5)**: root cause: the campaign planner's post carried `product: ""` and the draft→apply chain only wrote a product onto a post that already had one, so the Drive photo was imported but never assigned; the manual assignment wrote exactly the missing name. Fixed in the parser (lead product falls back to the listed products, the title, the headline), in apply (imports are written onto the posts that name them) and in the plan check (a post that names a product but has none selected is blocked with "Choose its product image", never silently painted). Regression test reproduces the exact scenario end to end (draft with two posts + one Drive pick → apply → both posts carry the product, nothing blocked). Side fix: the plan preview no longer blocks a product the run would import from Drive ("comes from the client's Drive when the run starts").
- **Three Drive choices (4)**: "Choose for me from Drive" / "Choose from Drive" / "Upload images (optional)" on Direction and on the Plan; upload demoted when a library is connected; proposal review with Replace / Exclude / Lock per post; per-post product cell; product photos distinguished from visual references in wording. Verified by tests and visible on the preview Plan.
- **Plan summary first (6)**: Objective · Product images · Visual direction · Reference pictures and what each controls · Output (posts, designs, pictures made/making/remaining) · Needs your attention; precedence sentence in plain language; one scene line per post with Details. The optional-theme warnings ("no pins", "pins not read") are raised only when the theme leads the month.
- **Scope and counts (7)**: one shared counts helper for Start, Plan, Studio and dialogs; confirmations name the post / selection / month and plan-change vs edit vs new version; the one-post style route has its own one-post footer; "Counting the month…" instead of zeros; "No posts yet" replaced. Studio head on the preview: "10 posts · 14 designs · 1 making · 5 older ideas · 13 remaining · Make 13 remaining · about $1.74".
- **Studio cards (9)**: picture, short title, status, one primary action ("Make it again · about $0.13" on an older idea), Edit picture one click, overflow for the rest; the leaked spec copy is gone (checked on the preview); "Accepted by the team · name" separate from "Client approved · name".
- **Editor (10)**: scope block before an AI edit, verified on the preview: "Scope: post 1 only. Source: the current picture (21 Oct, 15:24), made for an earlier idea. What changes: … The picture it replaces stays under Versions; the words and layers are redrawn". "Make another version" confirms first everywhere; words/logo/layout edits never generate (code paths checked).
- **Text Studio layouts (11)**: six modern layouts (Bold promotional, Editorial, Minimal premium, Product launch, Clean price/offer, Typographic statement) plus a bilingual split, separated from "Text styles" (outline, neon, saved styles kept); realistic thumbnails from the real renderer; preview → apply to one design → undo; "Apply to all designs" behind a confirmation naming the count. Tests cover the layouts for ar/en/both.
- **Languages (12)**: brand default already existed; month and post overrides added (post override in the editor's Words group); RTL/LTR/auto per layer; prices and numbers through Intl with bidi isolation; bilingual layouts with two independent text layers; no automatic translation. Tests cover resolution, wrapping for Arabic/English/mixed and number runs.
- **Voice (14)**: one state machine for dictation (stop delivers once, cancel drops, never submits), English labels, text fallback; dictation added to the editor's Idea and Caption fields.

## 2. Implemented but not fully verified

- **Direction board on the walk**: the automated walk could not reach Direction through "Continue to Direction" (its handler is asynchronous and the walk moved on too early) and the header rail chip did not respond to a scripted click; the Direction product choices were therefore verified on the Plan board only. Needs one manual pass.
- **Save status (8)**: the reducer and indicator are tested; the walk saw no save in flight so the label stayed empty. Needs a manual edit to see "Saving… / Saved".
- **Stage preservation (8)**: the method and style target persist per month in session storage (code and tests); not exercised end to end in a browser.
- **Text Studio toolbar at 390 px (13)**, the one-panel narrow mode, the layout thumbnails and the trial bar: typecheck/build only; the walk could not open the Text Studio through the workflow overlay. Needs a manual pass on a phone.
- **Post language override select** in the editor's Words group: present in code and tests; the walk did not reach that tab.
- **Grid analysis on pick**: on the preview the demo fixture answers; with a real key it costs one text call per grid, cached for everyone.

## 3. Remaining issues and tradeoffs

- **Grid picker on a phone**: the floating "Follow this grid" bar sits below the 390 px viewport in the automated walk (a scripted click still works). Check on a real phone; likely a bottom-bar position issue at small heights.
- Carousels and separators come from the brief only; a grid plans one picture per tile (stated on the grid preview).
- "Remaining" excludes text tiles (drawn free); the old Studio "planned" count included them.
- "Apply to all designs" in the Text Studio is not undoable across posts (the confirmation says so; per-post "Back to the automatic layout" remains).
- The month-level language override has data, schema and server support but no control on the Plan board yet (post and brand levels have theirs).
- Bidi in the renderer is a pragmatic subset: numbers followed by Latin stay in one LTR run; full UAX#9 is not reimplemented.
- The deterministic month id guards bursts within one minute; a burst that straddles a minute boundary can still make two months (the 60 s check catches most).

## The two Habibah test images

Read only, not resubmitted: in the latest "Habibah · 2026-10 · grid 6" month, "UX Test Overhead Kunafa" (post 1) is ready and "UX Test Kunafa Detail" (post 2) is in review; one made take each at about $0.13.
