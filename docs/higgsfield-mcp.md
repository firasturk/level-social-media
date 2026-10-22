# Higgsfield subscription credits (the MCP sign-in)

The owner's Higgsfield subscription (a creator plan with thousands of credits a month) pays for
what the Higgsfield **web product and its MCP server** make. The studio's videos used to go only
through the **Higgsfield Cloud API** (`server/higgsfield.ts`, the key under Connection →
Higgsfield), a separate account billed per clip that never touches those credits. This adapter
(`server/higgsfield-mcp.ts`) makes a post's video through `https://mcp.higgsfield.ai/mcp` on the
signed-in Higgsfield account, so the clip is paid **only from the subscription credits**, and adds
a **billing choice** per provider so the two paths never run at once.

Nothing here was run live: no OAuth client was registered, no sign-in started, no clip made. What
is "verified" below was read from Higgsfield's public metadata documents on 22 October 2026
(`curl -s`, no credentials); what is "assumed" comes from the tool descriptions the MCP server
lists for Claude and must be checked on the first live run.

## Verified from the metadata (22 Oct 2026)

- `POST https://mcp.higgsfield.ai/mcp` without a token → `401 {"error":"Unauthorized"}` with
  `WWW-Authenticate: Bearer resource_metadata="https://mcp.higgsfield.ai/.well-known/oauth-protected-resource/mcp", scope="openid email offline_access"`.
- Protected-resource metadata: `resource: https://mcp.higgsfield.ai/mcp`,
  `authorization_servers: ["https://clerk.higgsfield.ai"]`, scopes `openid email offline_access`,
  bearer in the header; `higgsfield_auth_hints` recommends `authorization_code_pkce` against
  `https://clerk.higgsfield.ai` for a client that "can complete an OAuth authorization-code redirect".
- `https://clerk.higgsfield.ai/.well-known/oauth-authorization-server`:
  `authorization_endpoint …/oauth/authorize`, `token_endpoint …/oauth/token`,
  `device_authorization_endpoint …/oauth/device_authorization`, `registration_endpoint …/oauth/register`,
  `revocation_endpoint …/oauth/token/revoke`; grants `authorization_code`, `refresh_token`,
  `urn:ietf:params:oauth:grant-type:device_code`; `code_challenge_methods_supported: ["S256"]`;
  `token_endpoint_auth_methods_supported: client_secret_basic, none, client_secret_post`;
  `client_id_metadata_document_supported: true`.
- `https://mcp.higgsfield.ai/.well-known/oauth-authorization-server` exists too (issuer
  `https://mcp.higgsfield.ai`, `/oauth2/authorize`, `/oauth2/token`, `/oauth2/register`, no device
  endpoint). The adapter follows the protected-resource document, which names Clerk, and reads
  whatever `authorization_servers[0]` publishes at run time, so a change on Higgsfield's side is
  picked up without a code change.

## The sign-in flow (built; not run live)

Routes under `/api/studio/higgsfield/mcp` (mounted from `server/studio.ts`; the studio session is
required, admins for everything but `GET /status`, the `higgsfield` switch under Admin →
Integrations gates every call that reaches Higgsfield):

1. **Discovery** — `GET` the protected-resource metadata, then
   `<authorization server>/.well-known/oauth-authorization-server` (falling back to
   `/.well-known/openid-configuration`). Cached an hour in the isolate.
2. **Registration, once** (RFC 7591) — `POST registration_endpoint` with
   `client_name: "Level Studio"`, `redirect_uris: ["${PUBLIC_BASE_URL}/api/studio/higgsfield/mcp/callback"]`,
   `grant_types: ["authorization_code", "refresh_token"]`, `response_types: ["code"]`,
   `token_endpoint_auth_method: "none"`, `scope: "openid email offline_access"`. The answer's
   `client_id` (and `client_secret`, if one is issued) is stored as the encrypted setting
   `higgsfield_mcp_client` with the issuer and the redirect; it is reused while both match.
   `PUBLIC_BASE_URL` is `https://studio.levelmena.com` in wrangler.jsonc; the preview worker has its
   own, so it registers its own client.
3. **Authorization code + PKCE** — `POST /signin/start` (admin) makes a `code_verifier` (32 random
   bytes, base64url) and its S256 challenge, a random `state`, keeps them fifteen minutes as the
   encrypted setting `higgsfield_mcp_pending` with the admin's id, writes a `mcp.signin` ledger
   row, and answers `{mode: "redirect", url}`: the authorize link with `response_type=code`,
   `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`, `code_challenge_method=S256`
   and `resource=https://mcp.higgsfield.ai/mcp` (RFC 8707, as the MCP authorization spec asks; a
   server that does not know it ignores it). The page opens it in a new tab.
4. **Callback** — `GET /callback?code&state`: the session cookie (`SameSite=Lax`) comes along on
   the top-level redirect; the user must be an admin and the one who started; `state` must match;
   the code is exchanged at the token endpoint with `grant_type=authorization_code`, `code`,
   `redirect_uri`, `client_id`, `code_verifier` (and `client_secret` when one was issued). Access
   token, refresh token, expiry, scope and the e-mail read from the `id_token` payload (shown,
   never trusted for access) are stored as the encrypted setting `higgsfield_mcp_tokens`; the
   browser is sent to `/?higgsfield=connected` (the studio shows a toast and opens Connection →
   Higgsfield). Any refusal lands on `/?higgsfield=error&reason=…` with Higgsfield's words.
5. **Refresh** — the access token is refreshed with the refresh token a minute before its expiry,
   and once more when the MCP server answers 401; the same tool call is then made once more (a
   token refresh, never a job retry: nothing was submitted). `invalid_grant` on a refresh ends the
   sign-in: the tokens are dropped and the dialog says "sign in again".
6. **Device-flow fallback** — when the registration with a redirect is refused, `POST /signin/start`
   says exactly what was refused (`"Higgsfield refused to register the studio as an OAuth client
   with a redirect (400): <body>"`), registers a device-flow client (no `redirect_uris`,
   `grant_types: [device_code, refresh_token]`), calls `device_authorization_endpoint` and answers
   `{mode: "device", userCode, verificationUri, verificationUriComplete, interval, expires, refused}`.
   The page shows the code and the link and calls `POST /signin/poll` every `interval` seconds; each
   poll is one `urn:ietf:params:oauth:grant-type:device_code` token request
   (`authorization_pending` / `slow_down` keep waiting). If Clerk lists no device endpoint either,
   the error says so and the studio cannot sign in by itself.
7. **Sign-out** — `POST /signout` drops the tokens, the pending sign-in and the cached catalog;
   the registered client stays; ledger row `mcp.signout`. The revocation endpoint is not called
   (the first live run may add it).

Nobody is ever asked to paste a token.

## Sign-in: the shared helper

The seven steps above are not Higgsfield code any more: they live in `server/oauth-signin.ts` as
`OAuthSignIn`, configured per provider with `{label, ledgerProvider, resource,
protectedResourceUrl, scopes, optionalScopes?, redirectPath, settingsPrefix, clientName: "Level
Studio", returnParam, signInHint, notSignedIn, onReset?}` and offering `start(env, user)`,
`poll(env, user)`, `callback(env, user, query)` + `returnPath(result)`, `accessToken(env, force?)`
(refresh when due or on a 401), `isSignedIn(env)`, `status(env, user)`, `signOut(env, user, also?)`,
`storedTokens(env)`, `useFetch(fn)` for tests. `server/higgsfield-mcp.ts` exports its instance as
`higgsfieldSignIn` with `settingsPrefix: "higgsfield_mcp"`, so the settings keys of the first
release (`higgsfield_mcp_client`, `higgsfield_mcp_tokens`, `higgsfield_mcp_pending`) are unchanged
and an existing sign-in is kept. The Magnific MCP (`server/magnific-signin.ts`, docs/freepik.md)
runs on the same helper with `settingsPrefix: "freepik_mcp"`, the scopes its resource demands and
`optionalScopes: ["offline_access"]` (added only when the realm lists it in `scopes_supported`;
Higgsfield's scopes already include it). Two things the helper does that the first release did
not: it checks the `iss` of the callback when the server sends one (RFC 9207), and it reads the
e-mail from `userinfo` when the id token carries none. `GET /status` now also carries `expired`,
`expiresAt` and `refresh` (whether a refresh token exists); a sign-in without one ends at
`expiresAt` and the status says so instead of returning a stale token.

## Credits vs Cloud API: the billing choice

Setting `higgsfield_billing` = `"credits"` (the subscription through the sign-in) or `"cloud"`
(the API key). With no choice made, the studio uses the credits once a sign-in exists, else the
Cloud key (`server/higgsfield-billing.ts`). `POST /api/studio/higgsfield/mcp/billing {billing}`
sets it (admins; ledger row `mcp.billing`). Connection → Higgsfield shows two radios:
**Subscription credits · sign-in** / **Cloud API · pay per clip**.

- With **credits** chosen, `POST /api/studio/posts/video` and `/retry` (the Cloud path) answer 409
  "Videos are set to use the subscription credits (Higgsfield sign-in). Switch the billing under
  Connection → Higgsfield to use the Cloud API." Nothing else on the Cloud path changes.
- With **cloud** chosen, `POST /api/studio/higgsfield/mcp/generate` answers 409 "Videos are set to
  use the Cloud API key (pay per clip). Switch the billing…". The estimate stays open (it costs
  nothing).
- The Video dialog, the Versions list and the Prompt Box follow the choice (`GET
  /api/studio/posts/video/list` now carries `billing`).

## Making a video on the credits (built against the tool descriptions; not run live)

The tool names come from the live `tools/list` after sign-in and are mapped **by name**; a missing
name is a clear 502 (`Higgsfield MCP lists no tool named "generate_video_batch" (it lists N: …)`)
and nothing runs. The adapter needs `balance`, `models_explore`, `media_import_url`,
`generate_video`, `generate_video_batch`, `jobs_wait`; it uses `show_generation_by_ids` when a
finished job carries no link.

| Step | Tool and arguments (assumed from the descriptions) | What the studio does with the answer |
| - | - | - |
| Catalog | `models_explore {action: "list", type: "video", input: "image", limit: 60}` | Objects with an `id`/`model_id`, their `name`, `durations`, `aspect_ratios`, `supports_unlim` become the engine chips; cached a day as `higgsfield_mcp_models`; "Refresh list" asks again. `GET /models`. |
| Picture | `media_import_url {url, type: "image"}` with a `signObjectUrl` link (two hours) to the post's picture, or to the artwork stored under a key made from its bytes | `media_id`, cached an hour per key so an estimate and its run import once. |
| Estimate | `generate_video {params: {model, prompt?, medias: [{value, role: "image"}], duration?, aspect_ratio?, count: 1, get_cost: true}}` | The credits (`cost` / `credits` / "N credits" in the text), `balance` for the line "About N credits · balance M". Nothing is submitted. Ledger `mcp.estimate` (estimate in credits, note says "credits"). `POST /estimate`. |
| Unlimited allowance | the same call, or the batch, answering `unlim_choice` | Surfaced to the admin as 409 `{unlimChoice}` (two buttons in the dialog); never answered by the server. The next call carries `use_unlim: true|false`. |
| Confirm | — | `POST /generate` without `confirm: true` → 409 `{needsConfirm, credits, balance}`; with an unknown cost → 409 `{needsEstimate}` (the admin may confirm anyway). |
| Submit | `generate_video_batch {requests: [{index: 0, params: {…same, count: 1, use_unlim?}}]}` (headless) | The `job_id` of index 0 → a `videos` row with `provider = 'higgsfield-mcp'`, `request_id = job_id`, `model = <engine id>`, settings `{duration, aspect, estimate, credits, unit: "credits", mcpModel, useUnlim, balanceBefore, plan}`; ledger `video` op (estimate in credits, note "… credits (subscription, MCP) · balance before N"), `claimSubmission` on `video:<batch>:<post>:<sha256 of provider+engine+idea+settings+source+picture+useUnlim>` for ten minutes. |
| Poll | `jobs_wait {jobs: [{index, job_id}], timeout_seconds: 1}` from `settlePending` (six rows per list call, `registerPendingSettler` in `server/video.ts`) | Terminal `completed`-like status → the result URL (or `show_generation_by_ids`) → the mp4 into R2 (`storeFinishedClip`, shared with the Cloud path) → `done`; `balance` again → `reported = before − after` (else the estimate), note "N credits reported (balance a → b)". `failed`-like → the message. Thirty minutes without an end → given up. |
| Timeout | the batch call times out | The row is kept as `queued` with no job id and `outcomeUnknown`; the op says "outcome unknown (timeout)"; the claim stands, so the same ask is refused for ten minutes; nothing is resubmitted; after thirty minutes the row is marked failed with "the outcome was never learned". |

Answers are read defensively (`server/mcp-client.ts`: `structuredContent`, else the first text
block that is JSON, else the words); when a figure cannot be read the raw text goes in the ledger
note.

## Where it is in the studio

- **Connection → Higgsfield**: the block "Subscription credits (Higgsfield sign-in)" with **Sign in
  to Higgsfield** (a new tab; the page updates by itself), the signed-in state (account, plan,
  credits, **Refresh credits**, **Sign out**), the device code when the fallback is needed, and
  the billing radios. The Cloud API key block sits under it, titled "Cloud API · pay per clip".
- **Video dialog**: with the credits chosen, the engine chips come from the subscription catalog
  (with "Refresh list"), length and frame follow the engine's lists, **Get the cost** shows "About
  N credits · balance M", then **Make the video · N credits**; the unlimited-allowance question
  appears as two buttons; "Not signed in: Connection → Higgsfield → Sign in" when no sign-in
  exists. Versions and the Versions group label such clips "Higgsfield (credits) · <engine id>"
  with "N credits".
- **Admin → Integrations**: the Higgsfield card says which account pays, who is signed in and the
  credits; ledger rows whose note says "credits" show "N credits" instead of dollars (the table
  stores numbers only; the unit lives in the note).
- **Prompt Box**: `videoGenerate` follows the billing choice; with the credits, the Cloud engine
  the sentence named is matched to the subscription catalog by name ("Seedance 2.5" →
  `seedance_2_5`), and an engine with no match says to open the Video dialog or switch the
  billing. The card says the engine list follows the billing choice.

## Limits and unknowns

- The MCP server's own rate limits, the exact answer shapes of every tool, the `jobs_wait` status
  words, where the result URL sits and whether the URL is public for the time it takes to
  download: all assumed; the first live clip tells. `tests/higgsfield-mcp.test.ts` fixes the
  shapes the adapter understands.
- Whether Clerk's dynamic registration accepts a web redirect for an unknown client, and whether
  the device flow is open to dynamically registered clients: the fallback and the exact refusal
  text are there for that case.
- The `resource` parameter on the authorize and token requests is what the MCP spec asks for;
  Clerk may ignore it. If Clerk rejects an unknown parameter, drop it (one line in `signin/start`
  and `tokenRequest`).
- No revocation on sign-out; no retry of anything, anywhere.
- The subscription catalog's engine ids differ from the Cloud API slugs; prices per clip are not
  published for either: the credits are asked per clip.

## What the first live sign-in and clip must check

1. **Sign in** under Connection → Higgsfield: a registration row appears in the ledger
   (`mcp.signin` running → done "signed in … as <e-mail>"); the status shows the e-mail, the plan
   and **Credits: N** equal to what higgsfield.ai shows. If the start answers a device code
   instead, read the `refused` text and decide whether to keep the device flow or to ask
   Higgsfield for a registered client.
2. **Engines**: the Video dialog lists the subscription's image-to-video engines; compare two ids
   with `models_explore` in Claude's own Higgsfield MCP.
3. **Get the cost** on one post (Seedance, 5 s): "About N credits · balance M" with the balance
   unchanged afterwards (`get_cost` must submit nothing).
4. **Make the video** once: the row appears queued with a job id; the list turns it `generating`
   then `done`; the mp4 plays; Admin → Integrations shows the `video` op with the estimate and
   "N credits reported (balance a → b)"; the Cloud API account's invoice shows nothing.
5. If Higgsfield asked the **unlimited-allowance** question, both buttons must send a second call
   with `use_unlim` and only that one may create a job.
6. Check the `videos.settings` of the finished clip for `codecs`/`faststart` (what the MCP
   delivers), as docs/video.md asks for the Cloud path.
