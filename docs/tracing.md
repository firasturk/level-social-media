# Tracing: from a picture back to what made it

A finished picture (a task's output) should answer: which month and post it belongs to, which
attempt made it, which revision of the idea it followed, which prompt and rules it carried, which
references and engine were used, what it cost, what failed on the way and what the review said.
This note checks what the data in D1 answers today, where each piece lives, and what is missing.

## Field → where it lives today → gap

| Field | Where it lives today | Gap |
| --- | --- | --- |
| Campaign (month) | `tasks.batch` → `batches` (`client`, `month`, `config`) | none |
| Post | `tasks.post` (index into `config.plan`); `post_takes.post` | a post renumbered by `withDates` keeps its index only through the plan; a task of a removed post is deleted with it |
| Run / attempt | `tasks.id`, `tasks.attempts`, `tasks.auto_retries`, `tasks.request_id` (engine id while processing), `tasks.lease` | `attempts` is a counter: the attempts themselves (when, which engine, why it failed) exist only as `post_takes` rows and `console.log` lines; the engine request id is cleared when the task settles |
| Brief and idea revision | `tasks.making_for` (captured at submission), `tasks.made_for` (set when the picture is stored), `post_takes.made_for`; the revision is `postRevision(post, config)` = max of `ideaAt`, `reference.at`, `clientNote.at`, `gridAt`, `plannedAt`; a brief's `config.campaign.at` equals `plannedAt` when the brief planned the month | the revision is a timestamp, not a copy: the idea's text at that revision is recoverable only when `month_versions` kept it (`keepMonthVersion` runs on replace and on a replan, not on every hand edit); pictures made before migration 0054 have `made_for NULL` ("lineage unknown") |
| Prompt | `tasks.prompt` (the final text sent, after `sanitizePrompt`, overwritten on every submission); `plan_preflights.brief` (the PostBrief after the art director's reading) | one prompt per task, so a retake overwrites the previous prompt; `post_takes` keeps the picture and the note, not the prompt that made it. There is no named prompt version: builders are code, so the version is the deployed commit. The adapter adds a fingerprint of the sent prompt (`metadata.promptVersion`) |
| Approved rules carried | `PostBrief.lessons` (in `tasks.brief`, JSON), written from `lessons WHERE status='approved'` at preparation; `PostBrief.rules`, `always`, `never`, `photography` | the rows are the client's current lessons; which were approved at the time is only in the brief snapshot on the task (good) and lost when the task row is overwritten by a regenerate |
| References | `tasks.brief` → `styleKey`, `tileKey`, `ref`, `editRef.key`, `extraProducts[].key`, `ambassadors[].key`, `place.key`, `realRef.key`; the order the engine gets is `postImages()` and is readable from the prompt's "Image N is …" lines | the attached picture's bytes may have changed since (a style re-read, a product photo replaced); keys are kept, not content hashes |
| Engine | `tasks.model` (an override after a refusal), else `config.model` on the batch; the fallback is logged by `[router]` | the engine of a past take is not on `post_takes`; a month whose model was moved by `connectedModel` loses the original |
| Attempts and errors | `tasks.error` (last message), `post_takes` rows with `status='failed'` and `note` (the message), `tasks.attempts`; transient requeues are logged only | one error at a time on the task; rate limits, requeues and the router's move live in logs |
| Review | `tasks.qa` (the latest QA JSON with `flags`), `lessons` (findings remembered per client), `tasks.phash` (look-alike check) | the review of an earlier take is overwritten; `post_takes` has no `qa` column |
| Costs | `tasks.cost` (running total of attempt estimates), `post_takes.cost` (per take, as reserved), `spend` (`approved`, `reserved`, `uncertain` per batch), `spend_runs` | estimates at list price, never the vendor's invoice; "uncertain" attempts are counted but not reconciled against anything |
| Art director's reading (preflight) | `plan_preflights` (per post and revision: the brief after the reading, the inputs, the notes), `tasks.preflight` | kept per post, not per take: a later reading replaces the earlier one |
| Plan written | `config.plannedAt`, `config.campaign` (`text`, `at`, `added`, `summary`, `only`, `styles`, `colours`), `month_versions` | the planner's instruction and raw answer are not stored; only the parsed posts |

## Verdict

**For tracing a stored picture back to its month, post, revision, references, engine and cost, D1
already answers**: `tasks` + `post_takes` + `spend` + `plan_preflights`, with `made_for` giving the
revision honestly (NULL when unknown). The gaps are about **history of the steps**, not identity:

1. The prompt, engine, review and error of **earlier takes** are overwritten on the task row
   (`post_takes` keeps the picture, the cost and a note, not the prompt or the QA).
2. **Transient events** (rate limits, requeues, the router's fallback, the preflight's drops) are
   `console.log` lines only.
3. There is **no named prompt version**; the version is the deployed commit.
4. The **planner's instruction and raw answer** are not stored.

Langfuse (free tier) covers 1, 2 and 4 cheaply as a mirror: one trace per month, one observation
per step of a task (submit, stored, failed, review) and per plan written, with the prompt
fingerprint standing in for 3. It is **not needed for correctness or for the designer's workflow**,
which read D1; it is useful for the team when a picture is wrong and the question is "what exactly
was sent, and what happened in between". If that question is rare, the same information can be
kept in D1 by adding `prompt`, `qa`, `model` and `error` columns to `post_takes`; the adapter is
there so the choice can be made later without touching the engine again.

## The adapter

`server/trace.ts` — `traceEvent(env, event)` with
`event = { kind: "generation" | "review" | "plan" | "edit", traceId (batch id), spanId (task id or plan:<stamp>), name, input, output, model, cost, metadata: { client, post, revision, promptVersion, references, engine, attempt, error } }`.

- Posts to `POST {host}/api/public/ingestion` (basic auth `public:secret`) a batch of
  `trace-create` (the month, upserted) and `generation-create` / `span-create` (the step).
- On only when `LANGFUSE_PUBLIC_KEY` and `LANGFUSE_SECRET_KEY` are set in the environment, or
  `langfuse_public_key` and `langfuse_secret_key` are saved in the settings table (`getSetting`);
  `LANGFUSE_HOST` / `langfuse_host` default to `https://cloud.langfuse.com`. `traceEnabled(env)`
  false → no-op. The keys are cached for a minute per isolate.
- Redacts before sending: fields named key/token/secret/password/authorization (and anything
  that looks like an API key) are dropped, e-mail addresses become `[email]`, strings longer than
  4000 characters are cut.
- Fire-and-forget: returns at once, 5 s timeout, every failure to `console.error("[trace]", …)`,
  never a rejection to the caller. `traceIdle()` awaits the sends in flight (tests; a Worker can
  pass it to `ctx.waitUntil`). `traceStatus(env)` reports enabled/host/source and the isolate's
  sent/failed counters for an admin screen.

D1 stays the authority; the adapter only mirrors.

### Hook points

| Where | Event |
| --- | --- |
| `server/engine.ts` `promptFor`, after the prompt is written to `tasks.prompt` (every engine path) | `generation` / `submit`: the prompt, the image roles, engine, attempt, references, prompt fingerprint |
| `server/engine.ts` `storeResultBytes`, after `recordTake(… "made")` | `generation` / `stored`: the picture key, engine, cost |
| `server/engine.ts` `settleFailedAttempt`, after `recordTake(… "failed")` | `generation` / `failed`: the message, billing class, cost |
| `server/engine.ts` `storeResultBytes`, once the QA is computed (post months and fashion cards) | `review` / `review`: automated, notes, flags |
| `server/posts.ts` `/campaign` and `/ideas` (replace and append), after `saveConfig` | `plan`: what was asked, how many posts were added, the month's shape |

### Connect

Set `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` (and `LANGFUSE_HOST` for a self-hosted or EU
instance) as Worker secrets, or save them as settings `langfuse_public_key`, `langfuse_secret_key`,
`langfuse_host`. Nothing else changes: with the keys absent the engine behaves exactly as before.

### Known limits

- A Worker may end the request before a fire-and-forget fetch completes; the engine's drivers
  (tick, webhook, cron) are short-lived. Passing `traceIdle()` to `ctx.waitUntil` in those
  handlers would make delivery reliable; it is not wired yet because D1 is the authority.
- The event carries R2 keys, never picture bytes, and prompts cut at 4000 characters.
- `edit` events (a designer's revision note) are defined but not yet emitted: the revision text
  reaches the `submit` event as `input.edit`.
