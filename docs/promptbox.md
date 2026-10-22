# The Prompt Box

The Prompt Box is the planner chat ("Talk to the planner" on the Plan board, and the **Prompt** button
next to More on the Studio board) taught to recognise when a sentence asks a tool to act. A sentence
about the ideas, words, dates or products is handled as before: the art director changes exactly
that. A sentence that asks for stock, a clip or an edit becomes an **intent card** the person reads
and confirms. Nothing runs from the sentence alone.

Files: `shared/promptbox.ts` (the contract and the resolver), `server/promptbox.ts` (the run
route), `server/promptbox-tools.ts` (the one adapter every provider call goes through),
`src/studio/IntentCard.tsx` and `src/studio/IdeasChat.tsx` (the card and the box),
`tests/promptbox.test.ts`.

## The intent

```ts
ToolIntent = {
  tool: "freepik.search" | "freepik.use" | "video.generate" | "photolab.run" | "none";
  target: { batch: string; post: number | null; slide: number | null; version?: string | null };
  asset?: { id: string; source: string; url?: string; title?: string };
  operation: string;           // "Search Freepik", "Add to the design", "Animate the picture"
  provider: "freepik" | "higgsfield" | "none";
  settings: Record<string, unknown>;
  estimate: number | null;     // credits; null = not known, the card is blocked
  estimateNote: string;
  needsConfirmation: boolean;
  questions: string[];         // at most one focused question
}
```

## The grammar (deterministic)

`resolveIntent(text, context)` reads the sentence with rules only; the brief's examples work with no
model, and the preview's demo fixture answers the same way. The context is the month (`batch`, the
posts' numbers and titles), the post open in the editor (`openPost`, `openSlide`) and the asset shown
or picked last (`lastAsset`). Arabic numerals are read (`بوست ٣` is post 3).

| Sentence | Tool | How it is read |
| --- | --- | --- |
| "Find a minimal background from Freepik for post 3" | `freepik.search` | a search verb (find, search, look for, browse, show me) with Freepik or a stock word; `q` is what sits between the verb and "from Freepik" / "for post N" ("minimal background"); type from the words (vector, icon, video, photo), orientation when named; target post 3; estimate 0, no confirmation |
| "Add this asset behind the headline" | `freepik.use` | a use verb (add, use, put, place, set, insert) and "this/that/it/asset"; `asset` is the one shown last; role `reference` when the words say reference, inspiration or mood, else `design`; placement "behind the headline", "background"; target the open post; needs confirmation; estimate 0 |
| "Animate this post using Kling through Higgsfield" | `video.generate` | animate, video, motion, clip, Kling, Seedance, Higgsfield; the model named from the catalog (the first one when none is named); duration "8 seconds", aspect "9:16" / story / landscape (default 5 s, 1:1); source `artwork` when the design with its words is asked for, else `picture`; target the open post; estimate from the catalog's `credits` or null with "Cost not known yet" |
| "Remove the background of post 2", "upscale", "relight", "expand" | `photolab.run` | a Photo Lab edit; estimate null until the catalog knows |
| anything else | `none` | the planner changes the ideas as before |

The post is found in this order: a number in the sentence ("post 3", "#3", "بوست ٣"), the open post
for "this post" / "it", then a title the words name when exactly one post carries it. Two posts
matching ("the mojito post" when two mojito posts exist), no post at all, or a number the month does
not have: one question, never a guess. The same for the asset: "this asset" with nothing shown yet
asks for a search first.

## Model-assisted, with the same rules

When the deterministic reading finds no tool but the words sound like one (`hintsTool`: Freepik, a
video word, a Photo Lab word, "use … as reference"), the chat may ask the text model for a proposal
(`intentInstruction` + `INTENT_SCHEMA`). The proposal is advice only: `validateIntent` turns it into a
card with the same rules (known tool, a real post, the model from the catalog, the asset that was
shown, the estimate from the catalog, never from the proposal) or asks the question it would have
asked. With no key on the preview the demo fixture returns the deterministic result, so nothing is
paid for and the two paths agree.

## Confirmation rules

- The chat (`POST /api/studio/posts/chat`, body `{batch, message, context?: {post, slide, asset}}`)
  answers `{kind: "intent", intent, canRun, reply}` for a tool and `{kind: "ideas", …}` otherwise. It
  records the intent as a `proposed` integration op and writes the summary into the thread. It never
  executes.
- `POST /api/studio/promptbox/execute` `{intent, confirm: true, estimate?, context?}` runs one card.
  It is refused without `confirm: true` (428), with an open question (409), with an unknown cost
  (409; an admin may send `estimate`), and for members on every provider tool (403 "Admins only
  for now…" from `requireIntegrationAdmin`, then `assertIntegrationEnabled`). The card's own
  `estimate` is never trusted: the catalog's or the admin's is used.
- Every run is recorded (`recordIntegrationOp` confirmed → done/failed). Searching is free and is
  still recorded with estimate 0; **browsing never generates** anything: the results are shown,
  nothing is downloaded or made.
- "Use as reference" and "Add to design" under the results make their own `freepik.use` card. Being
  free and complete (a post and an asset), the click is the confirmation and the card runs at once,
  recorded like any other; with no post chosen, the card asks first.
- Members see every card with "Admins only for now" and no Run.

## The card

Target (campaign · post · slide), Selected asset (thumbnail, or "none yet"), Operation and provider,
Settings (model, duration, aspect; query, type, orientation; role, placement), Credit estimate
("Free", "About N credits", or "Cost not known yet · blocked until clarified" with "Set the cost"
for admins), the open question when there is one, then **Run** and **Change target** (a post
picker). Search results render under their card with "Use as reference" and "Add to design".

## What is wired here, and what is wired at merge

`server/promptbox-tools.ts` is the only file that touches a provider; the routes call
`promptboxTools` and tests swap tools with `setPromptboxTools`. In this build:

- `freepikSearch` and `freepikUse` answer from a fixture (six deterministic results per query,
  "DEMO FIXTURE" in their titles). At merge they call the functions behind
  `GET /api/studio/freepik/search` and `POST /api/studio/freepik/use` (int/freepik).
- `videoGenerate` makes this build's own image-to-video call (the one the Video dialog makes), which
  ignores aspect and source. At merge it calls the function behind `POST /api/studio/posts/video`
  (int/video), which takes `{batch, index, model, prompt, duration, aspect, source, artwork?}`.
- `videoCatalog()` in `shared/promptbox.ts` reads `VIDEO_MODELS` from `shared/qa.ts`; a `credits`
  field there (or `shared/video-models.ts`, when it lands) gives the estimate. Until then every
  clip is "Cost not known yet" and an admin sets the cost on the card.
- `photolabRun` refuses (503) until Photo Lab is wired.
- `server/integrations.ts` is the governance stub (int/governance owns it): the gate, the enabled
  check and the op records are no-ops that return success.
