# Integrations: the rules for outside providers

Every outside provider the studio pays per call behind an admin switch goes through one set of
rules, implemented once in `server/integrations.ts`. Today that is Freepik (the Photo lab and its
key), Higgsfield video (the clip made from a post's picture), the video editor (saving a project,
storing an export; no provider is paid, the browser renders) and `audio` (tracks uploaded for a
post's videos and each version's audio choice; no provider is paid yet, see docs/video.md "Audio").
The picture engines, the text keys and the spend ledger of image generation (`server/spend.ts`)
keep their own existing rules; nothing here changes them.

## The rules

1. **Admins only, for now.** Running a provider, saving or removing its key and taking a result
   into the month are limited to admins until the integration is approved for the whole team. A
   member who tries gets 403 "Admins only for now: … ". The entry points stay visible to members
   (the Photo lab in the editor, the Video dialog on a post, the Freepik tab under Connection) with
   that note and no provider controls.
   - `requireIntegrationAdmin(c, provider)` is the first line of every gated route.
2. **Viewing stays open.** Listing Photo lab jobs and their pictures (`GET /photolab/jobs`,
   `GET /photolab/jobs/:id`, `GET /photolab/jobs/:id/image`), listing a post's videos
   (`GET /posts/video/list`) and serving a stored clip (`GET /posts/video/file`) answer every
   signed-in user under the existing session and month permissions. The client approval page is
   untouched.
3. **A switch per provider.** Admin → Integrations has one switch for each provider. Off, every
   gated route answers 503 "… is switched off by an admin. Nothing was sent or charged. Turn it
   back on under Admin → Integrations." at once; viewing is unaffected. The switch is the setting
   `integration_<provider>_enabled`; on by default. A switched-off provider's key can still be
   removed (never saved), so a key can always be taken out.
   - `assertIntegrationEnabled(env, provider)` is the second line of every gated route.
4. **A ledger.** Every operation is a row in `integration_ops` (migration 0068): who, when,
   provider, kind, month and post, the provider's task id, the estimate before and the reported
   cost after, the status (`proposed`, `confirmed`, `running`, `done`, `failed`, `refused`) and a
   note. Admin → Integrations shows the recent rows; `listIntegrationOps` reads them with filters.
   Key saves, removals, switches and estimate changes are rows too.
   - `recordIntegrationOp` / `updateIntegrationOp` / `finishIntegrationOpByTask`.
5. **Confirm before spend.** A paid run is two requests to the same route:
   - without an op id the route **proposes** it: the input is checked, the row is written as
     `proposed` with the estimate, and `{ opId, estimate, needsConfirmation: true }` comes back.
     Nothing reaches the provider.
   - with `{ opId, confirm: true }` the route **executes** it, once. `confirmSpend` checks that the
     proposal exists for this provider and is still `proposed`, that `confirm` is true (otherwise
     409 with the same `{opId, estimate, needsConfirmation}`), and that the estimate is known.
   - **An unknown cost blocks the run**: when the estimate is `null` and the kind is not on the
     free list (searching, previewing, listing, status, verify), the row becomes `refused` with
     "cost not known: blocked until clarified" and the request gets 409. Freepik's estimates come
     from `PHOTO_LAB_PRICES`; a Higgsfield video clip has no published price in `shared/pricing`,
     so an admin enters one under Admin → Integrations (setting
     `integration_higgsfield_estimate_video`). Until then videos are blocked by design.
   - The row records the admin who confirmed. A background pass (the cron, `publishDue`,
     `advanceBatch`) never proposes or confirms one of these operations: only a request handler
     does, with the signed-in admin, so nothing runs on a member's behalf.
6. **No duplicates.** `claimSubmission(env, key, ttlMs)` claims a key in D1 (`integration_claims`)
   before the provider is called; the same key within the time to live (one minute by default) is
   refused with 409. `confirmSpend` claims `op:<opId>`, so a double click, a second tab or a retried
   request cannot submit the same confirmed operation twice; the claim survives an isolate restart.
7. **No automatic paid retries, no provider fallback.** `noRetry(call)` runs a provider call
   exactly once and lets its failure stand. A failed submission is `failed` on the ledger with the
   provider's message; the person decides whether to propose it again. No other provider is tried
   in its place: the admin confirmed this provider at this price, not another. The Photo lab
   (`server/photolab.ts`) and the video submit (`server/posts.ts`) wrap their submissions in it.

## Where the gates sit

| Route | Gates |
| --- | --- |
| `POST /api/studio/photolab/run` | admin, switch, propose / confirm, claim, no retry, ledger |
| `POST /api/studio/photolab/key` | admin, switch, ledger (`key.save`) |
| `DELETE /api/studio/photolab/key` | admin, ledger (`key.remove`); allowed while off |
| `POST /api/studio/photolab/jobs/:id/use` | admin, switch, ledger (`result.picture` / `result.product`, no spend) |
| `POST /api/studio/posts/video/idea` | admin, switch, ledger (`video.idea`: a text-model call under the text key, nothing sent to Higgsfield, no confirmation) |
| `POST /api/studio/posts/video` | admin, switch, propose / confirm, claim, no retry, ledger (`video.submit`); 409 while the billing choice is the subscription credits |
| `POST /api/studio/higgsfield/mcp/signin/start`, `/signin/poll`, `/signout`, `/billing` | admin, switch (not for `/signout` and `/billing`), ledger (`mcp.signin`, `mcp.signout`, `mcp.billing`; estimate 0, nothing spent). docs/higgsfield-mcp.md |
| `GET /api/studio/higgsfield/mcp/models`, `POST …/estimate` | admin, switch, ledger (`mcp.estimate`: the credits `get_cost` named, note "N credits"; nothing submitted) |
| `POST /api/studio/higgsfield/mcp/generate` | admin, switch, the billing choice, `get_cost` estimate → `confirm: true` with the credits shown, claim (ten minutes), no retry (a timeout keeps the row and the claim), ledger (`video`, estimate and reported **in credits**, the note says so); an `unlim_choice` answer is a 409 for the admin, never answered by the server |
| `POST /api/studio/posts/video/audio/upload`, `/choose` | admin, switch (`audio`), ledger (`audio.upload`, `audio.choose`, estimate 0; no provider) |
| `POST /api/studio/posts/video/audio/generate` | admin, switch; always 503 "not connected" with a `refused` row (`audio.generate`) until a music provider is wired |
| `POST /api/studio/posts/video/editor/projects`, `PUT …/projects/:id` | admin, switch (`editor`), ledger (`editor.save`, estimate 0: rendered in the browser, nothing sent out) |
| `POST /api/studio/posts/video/editor/render` | admin, switch (`editor`), ledger (`editor.render`, estimate 0); the file goes through the upload checks and becomes a version |
| `GET /api/studio/video/presets`, `GET …/presets/:id` | every member (browsing, free; a fetch from the provider writes a `preset.browse` row at estimate 0; cached a day). docs/video-studio.md |
| `POST /api/studio/video/presets/run` | admin, switch (`higgsfield`), the credits billing, the detail's price → `confirm: true` (none → 409 `needsEstimate` until confirmed), claim (ten minutes), no retry, ledger (`preset.run`, in credits) |
| `POST /api/studio/video/magnific/generate`, `…/enhance` | admin, switch (`freepik`), `simulate_cost` → `confirm: true`; an unknown cost blocks (409, a `refused` row); claim, no retry, ledger (`video.generate`, `video.enhance` under provider `freepik`, in credits) |
| `POST /api/studio/video/higgsfield/tool`, `…/check`, `GET …/check/status` | admin, switch (`higgsfield`), the credits billing, a `get_cost` preflight when the tool offers one → `confirm: true` (else 409 `needsEstimate` until confirmed), claim, no retry, ledger (`video.enhance`, `video.check`) |
| `GET /api/admin/integrations` | admin: the switches, estimates and recent rows |
| `POST /api/admin/integrations/switch` | admin: `{provider, enabled}` |
| `POST /api/admin/integrations/estimate` | admin: `{provider, kind, usd \| null}` |

`GET /api/studio/photolab/status` and `GET /api/studio/posts/video/list` carry `access:
{admin, enabled, reason}` so the entry points can say "Admins only for now" or "Switched off"
without a provider call.

## How a future provider plugs in

1. Add its name to `IntegrationProvider`, `INTEGRATION_PROVIDERS`, `PROVIDER_LABELS` and
   `PROVIDER_SCOPE` in `server/integrations.ts`. The switch, the ledger and the admin panel pick it
   up from those lists; no migration is needed.
2. If a kind of run has no published price, add it to `ESTIMATE_KINDS` so an admin can enter the
   estimate; otherwise compute the estimate from `shared/pricing` in the route.
3. In each paid route: `requireIntegrationAdmin`, `assertIntegrationEnabled`, then `proposeOp`
   when the body has no `opId`, else `confirmSpend` and the provider call inside `noRetry`.
   Record the provider's task id on the row (`updateIntegrationOp`) and close the row when the
   provider finishes (`finishIntegrationOpByTask`).
4. Keep viewing routes open and tell the entry point what the viewer may do with
   `integrationAccess`.
5. Add the provider's tests to `tests/integrations.test.ts`: member → 403, switch off → 503,
   unknown cost → 409, duplicate confirmation → 409, viewing → 200. The guard in
   `tests/support/paid-guard.ts` fails any test that reaches a real host.
