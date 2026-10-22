# Prompt evaluation (promptfoo)

The studio's text prompts are built by plain functions (`shared/campaign.ts`, `shared/posts.ts`,
`shared/brief.ts`, `shared/styles.ts`). `eval/` runs those builders on fixed inputs through
[promptfoo](https://www.promptfoo.dev) (community edition, a devDependency) and checks what came out:
the words the writers and the image engine receive, the counts a plan produces, what a brief adds to
a month, what a hand edit survives into. **Nothing in the default run reaches a network.**

## Run

| Command | What it does | Network |
| --- | --- | --- |
| `npm run eval` | The deterministic suite, `eval/promptfooconfig.yaml`. Exit code 1 on any failed case. | none |
| `npm run eval:update` | The same, rewriting `eval/snapshots/*.txt` for an intended prompt change. | none |
| `npm run eval:paid` | **Opt-in, paid.** `eval/promptfooconfig.paid.yaml`: the real planner instruction on a text model. Needs `OPENAI_API_KEY` (or another promptfoo provider swapped in). Never part of `npm run check`. | yes, billed |

Results are written to `eval/results.json` (git-ignored). `eval/run.mjs` turns off promptfoo's
telemetry, update check, sharing and local results database, so the default run leaves nothing
behind and works offline.

`npm run eval` is not in `npm run check`. CI still covers the same code paths through
`tests/eval-fixtures.test.ts`, which calls every provider method from vitest and checks the same
invariants, so a broken builder fails `npm test` even where promptfoo is not installed.

## How it works: mock vs paid

**Mock (default).** One promptfoo provider, `eval/providers/studio.ts`, dispatches on `vars.method`:

| method | builder | fixture answer |
| --- | --- | --- |
| `brief-plan` | `briefPlanInstruction` → `parseBriefPlan` (Quick Campaign) | `demoAnswer(…, BRIEF_PLAN_SCHEMA)` |
| `grid-ideas` | `gridIdeasInstruction` → `parseIdeas` (Follow a grid) | `demoAnswer(…, GRID_SCHEMA)` |
| `theme-analyse` | `themeBuilderInstruction` (Analyse theme) | `demoAnswer(…, THEME_SCHEMA)` |
| `theme-shots` | `adaptShotsInstruction` (the month's shoot list) | `demoAnswer(…, SHOTS_SCHEMA)` |
| `style-scene` | `adaptStyleInstruction` (One post from a style) | `demoAnswer(…, ADAPT_SCHEMA)` |
| `plan-scope` | `/campaign`'s append/replace steps + `planShape` | `demoAnswer(…, BRIEF_PLAN_SCHEMA)` |
| `post-prompt` | `buildPostPrompt` (the image engine's prompt) | none (pure) |
| `feedback` | `shared/feedback.ts interpretFeedback` when present | TODO (see below) |

Every text call is answered by `server/demo.ts` `demoAnswer`, the same fixture a preview deployment
uses when no text key is connected. It answers from the instruction's own words (the post count in
the brief, the product list, the post numbers), so a case is deterministic and free. It also means
the mock suite tests **our side** of the conversation: the instruction we send and how we parse an
answer of the right shape. It cannot tell whether a real model would follow the instruction.

**Paid (opt-in).** `eval/promptfooconfig.paid.yaml` sends the real `briefPlanInstruction` (built by
`eval/prompts/brief-plan.ts`) to a text model and checks only what needs no human: valid JSON in
the planner's shape and the post count the brief asked for. Keep it small; every case is billed.

## Adding a case

A case is one block under `tests:` in `eval/promptfooconfig.yaml`: the method, its inputs, and the
expectations, all in `vars`. The default assertion `eval/asserts.mjs:check` reads these vars:

```yaml
- description: "Append · 3 existing posts + a brief for 2 → 5 posts, the first 3 unchanged"
  vars:
    method: plan-scope
    case: append-keeps-existing
    brief: "Plan 2 posts, each a single picture …"
    only: false
    expect: { existing: 3, added: 2, total: 5, indexes: [1, 2, 3, 4, 5], firstUnchanged: true }
    expectContains: { instruction: ["The month already has 3 posts; yours come after them."] }
```

| var | meaning |
| --- | --- |
| `expect` | `{ "dotted.path": value }`, deep equality against the provider's output |
| `expectMin` | `{ "dotted.path": n }`, output at least n |
| `expectContains` / `expectLacks` | `{ "dotted.path": ["text", …] }`, every text present / absent in the string at that path |
| `expectOrder` | `{ "dotted.path": ["a", "b", …] }`, all present, in this order |
| `expectTruthy` | `["dotted.path", …]` |

Other assertions, added per test under `assert:`:

- `file://asserts.mjs:memoryCarried` — every approved lesson line is in the built text, no pending or rejected one is (the provider reports them under `memory`).
- `file://asserts.mjs:matchesSnapshot` — see below.
- `file://asserts.mjs:feedbackKind`, `file://asserts.mjs:conflictSurfaced` — the TODO cases.

To add inputs a provider does not read yet, extend the provider in `eval/providers/` (they are
small) and, when the new input matters in CI, add the same check to `tests/eval-fixtures.test.ts`.
The fixtures (client, products, plans, lessons, styles) live in `eval/providers/fixtures.ts`.

The demo fixture has limits worth knowing: the brief planner reads the single-post count from
"N posts" in the brief and a carousel from "N-slide"; with no count it plans 6. Use a fixture plan
(`plan: full`) when a case is about counting rather than about the brief.

## Snapshots

`eval/snapshots/*.txt` hold the exact prompt text for the four creation methods and the planner's
instruction. `matchesSnapshot` compares the built text to the file; a missing file is written and
passes; `npm run eval:update` rewrites them. A changed snapshot is an intentional change to what a
model receives and belongs in the commit message, like `tests/__snapshots__/golden-prompts.test.ts.snap`.

A snapshot is **one regression check on the words**, not proof of visual quality: it catches a rule
that silently disappeared or a reference that moved to the wrong image number. Whether the picture
is good is still decided by the review and by people.

## TODO cases

Two cases point at modules another branch is writing and pass with a TODO reason until they land:

- `shared/feedback.ts` `interpretFeedback(text)`: "make the logo larger" → a layer edit,
  "remove the cup" → an image edit, "the second one" → ambiguous. `eval/providers/feedback.ts`
  imports the module when it exists and reads the kind from whatever shape it returns.
- `shared/conflicts.ts` `detectConflicts(inputs)`: a style that brings a hand or people into a
  post whose brand says "no people" must be surfaced as a note, never resolved silently. Until then
  the case asserts the constraint itself (the writer and the engine prompt carry
  `NEVER: no people in the pictures` and the people rule).
