# Freepik assets (stock content API and the Magnific MCP)

Stock photos, vectors, PSDs and templates from Freepik, brought into the studio as a post's
**reference picture** or as an **image layer** of a design. One shared layer (`server/freepik.ts`)
serves the API routes and the MCP adapter (`server/freepik-mcp.ts`; the JSON-RPC client itself lives in `server/mcp-client.ts`, shared with the Higgsfield MCP adapter; the MCP's OAuth sign-in is `server/magnific-signin.ts` on the shared `server/oauth-signin.ts`), over one library
(`assets`, `asset_uses`, migration `0070_assets.sql`): a file is downloaded once and reused.

A Freepik asset never changes the theme (Pinterest pins stay the theme references), never switches
an engine, and never replaces a product photo (Drive stays products and brand).

## Verified against the documentation (read 22 October 2026)

docs.freepik.com redirects to **docs.magnific.com**. Every page is readable as Markdown by
appending `.md`; the index is https://docs.magnific.com/llms.txt.

| Claim | Source | Status |
| --- | --- | --- |
| Base URL `https://api.magnific.com`, header `x-magnific-api-key` ("Your Magnific API key. Required for authentication.") | https://docs.magnific.com/authentication, https://docs.magnific.com/api-reference/resources/get-all-resources | **Verified** |
| Search: `GET /v1/resources` with `term`, `page` (1–100), `limit`, `order` (`relevance`, `recent`), `filters[orientation][landscape\|portrait\|square\|panoramic]=1`, `filters[content_type][photo\|psd\|vector]=1`, `filters[license][freemium\|premium]=1`, `filters[color]=black\|blue\|gray\|green\|orange\|red\|white\|yellow\|purple\|cyan\|pink`, people, period, author, ai-generated, vector type/style, psd type, `ids` | https://docs.magnific.com/api-reference/resources/get-all-resources | **Verified** |
| Search answer: `data[]` of `{id, title, url, filename, licenses[{type: freemium\|premium, url}], image{type, orientation: horizontal\|vertical\|square\|panoramic\|unknown, source{url, size "740x640"}}, author{name…}, meta{available_formats}}`, `meta{current_page, per_page, last_page, total}` | same page | **Verified** |
| Detail: `GET /v1/resources/{resource-id}` → `data{id, name, type, vertical, url, license (uri), premium, preview{url, width, height}, dimensions{width, height}, available_formats{jpg\|psd\|ai\|svg…}, author, related…}`; errors 401 "Invalid API key" / "Missing API key", 404 "Resource not found" | https://docs.magnific.com/api-reference/resources/get-the-detail-of-a-resource-psd-vector-or-photo | **Verified** |
| Download: `GET /v1/resources/{resource-id}/download` (`image_size=small\|medium\|large\|original\|NNNpx`, photos only) answers **JSON** `data{filename, url, signed_url}`: the file is then fetched from `data.url`. Errors: 403 "The user cannot download this item because it is premium", 429 "The user can't download more items because the download limits has been reached" | https://docs.magnific.com/api-reference/resources/download-a-resource | **Verified** |
| `GET /v1/resources/{resource-id}/download/{resource-format}` exists (format not documented) | https://docs.magnific.com/api-reference/resources/images-and-templates-api | **Verified** (unused) |
| **Downloads and credits**: "Stock downloads through the API follow a different model than AI generations": on **Premium, Premium+ and Pro** "stock downloads via API don't consume credits, but they're capped at 100 downloads per day"; on **Business and Enterprise** "no daily cap … each one is deducted from your credit balance like any other API call" | https://docs.magnific.com/pricing | **Verified** |
| **Unlimited website subscription does not include the API**: "If your subscription includes "Unlimited" allowances, note that they only cover usage inside the Magnific web app. API calls always run on the credit model" | https://docs.magnific.com/pricing | **Verified** |
| Rate limits: 30,000 requests per minute per key; 50 hits per second per IP | https://docs.magnific.com/ratelimits | **Verified** |
| MCP server at `https://mcp.magnific.com`, **streamable HTTP** transport, **OAuth 2.0** with the Magnific account ("You don't need to manage an API key"), 236 tools in 13 groups including `stock_search`, `stock_get`, `stock_show`, `stock_download`, `stock_to_creation`; "MCP tools draw from the same credit balance as the rest of Magnific"; `simulate_cost` estimates before running; a few tools marked free (`video_cut`, `video_zoom`, `images_split_grid`); "the live tools/list response is the source of truth" | https://docs.magnific.com/modelcontextprotocol | **Verified** |
| An unauthenticated `POST https://mcp.magnific.com/` answers **401** with `WWW-Authenticate: Bearer error="invalid_token", resource_metadata="https://mcp.magnific.com/.well-known/oauth-protected-resource", scope="openid profile email mcp:custom-audience"` (the earlier 405 was the GET: the MCP path takes POST) | live probe, no credentials | **Verified** |
| Authorization server: Keycloak realm `https://auth.magnific.com/realms/mcp` with `authorization_endpoint` (`…/protocol/openid-connect/auth`), `token_endpoint` (`…/token`), `userinfo_endpoint`, `revocation_endpoint`, a **device authorization endpoint** (`…/protocol/openid-connect/auth/device`) and an **open dynamic client registration endpoint** (`…/clients-registrations/openid-connect`): a custom app can register itself and sign a user in with the authorization-code (PKCE) or device flow. `code_challenge_methods_supported: plain, S256`; `token_endpoint_auth_methods_supported` includes `none` (public clients); grants include `authorization_code`, `refresh_token`, `urn:ietf:params:oauth:grant-type:device_code`; **`scopes_supported: profile, openid, mcp:custom-audience, email, basic, offline_access`** (so a refresh token can be asked for); `authorization_response_iss_parameter_supported: true` | `/.well-known/oauth-protected-resource` (`resource: https://mcp.magnific.com`, `authorization_servers: [https://auth.magnific.com/realms/mcp]`, `scopes_supported: openid profile email mcp:custom-audience`), the realm's `/.well-known/oauth-authorization-server` and `/.well-known/openid-configuration` (identical), re-read 22 Oct 2026 | **Verified** (a registration probe named `level-studio-probe`, a public client with no secret, was created and can be ignored or removed by Magnific support; the studio's own registration will be named `Level Studio`) |

### Assumed (not stated in the docs)

- **Searching is free.** The pricing page prices generations and downloads; it says nothing about
  a search, and `GET /v1/resources` is the documented authentication example. Treated as free
  (estimate 0, still recorded as an op).
- **Attribution.** The API reports only the licence type and URL. Freepik's published licence:
  a free (freemium) resource must credit the author, a premium one need not. The badge says
  "Free with attribution" for freemium; the panel reminds to credit the author where the post is
  published. The `uses` list in the stored licence stays empty because the API reports none.
- **The credits per download on Business and Enterprise** are on
  https://www.magnific.com/ai/docs/stock-content-download-credits, which refuses automated
  readers (HTTP 403). The studio therefore cannot know that cost: see "What costs credits".
- **Which stock MCP tools are free.** The MCP page marks no stock tool as free or paid.
  `stock_search`, `stock_get` and `stock_show` are treated like the API's search (free);
  `stock_download` follows the plan rule above; every other tool is treated as credit-consuming.
- **The MCP's same-plan rule.** It is assumed the MCP's `stock_download` follows the same
  per-plan rule as the API download (same balance, per the page). Not verified live.
- **Vector downloads** come as source files (the detail's `available_formats` lists `ai`,
  `eps`, `svg`; the MCP's `stock_download` says "source = layered PSD/vector ZIP"). A ZIP is
  stored in the library but cannot be a reference or a layer; an SVG can be a layer.

## Entitlements, and what costs credits

| Action | Cost | Rule in the studio |
| --- | --- | --- |
| Search, detail, demo catalogue | 0 (assumed free) | Runs at once; recorded as an op with estimate 0 (`kind: search`, `detail`). |
| Download on Premium / Premium+ / Pro | 0 credits, 100 a day | Estimate 0: proposed, then `confirm: true`. The API's own 429 ends the day. |
| Download on Business / Enterprise | Credits per download, amount unknown | Estimate `null` → **blocked "cost not known"** (op recorded as refused). |
| Download with the plan not set | Unknown | Blocked the same way: set the plan under **Connection → Freepik**. |
| Download of a file already in the library | 0 | Reused: no second download, op recorded with the note "Reused". |
| Use as reference / add to design | 0 | Recorded (`kind: use`) with the batch, post, slide, role and layer id. |
| MCP browsing tools (`stock_search`, `stock_get`, `*_list`, `*_show`, `account_*`, `simulate_*`…) | 0 | Run at once, op recorded. |
| MCP `stock_download` | As the API download, by plan | Same estimate rule, confirm required, file stored on the same library row. |
| MCP generative tools (`images_*`, `video_*`, `audio_*`, `models3d_*`…) | Credits from the Magnific balance | `simulate_cost` runs first (read-only); its figure is the estimate and `confirm: true` is required; no figure → blocked. |

The pricing page: an **Unlimited** website subscription covers the web app only; the API and
the MCP run on the organisation's credit balance (plus the per-plan download rule).

## Setup for Firas

1. **API key** (stock search and downloads, the Photo lab): freepik.com → API dashboard → create
   a key; **Connection → Freepik → Save** (verified with `GET /v1/resources?limit=1`, stored as
   the encrypted setting `freepik_api_key`).
2. **Plan**: under the key, pick **Premium, Premium+ or Pro** (downloads in the plan) or
   **Business or Enterprise** (credits; downloads stay blocked until the rate is known). Stored as
   `freepik_plan`. Left unset, downloads are blocked as "cost not known"; searching still works.
3. **Magnific MCP sign-in** (optional): the server wants an OAuth sign-in to the Magnific account,
   not the API key. **Connection → Freepik → Magnific MCP → Sign in to Magnific**: Magnific's own
   sign-in (auth.magnific.com) opens in a new tab; sign in there; the studio page updates by itself
   and says "Signed in as <e-mail>". Nothing is pasted: the studio registers itself as an OAuth
   client once (named `Level Studio`) and keeps the tokens encrypted (`freepik_mcp_tokens`),
   refreshing the access token itself. If Magnific gives no refresh token, the line reads "Signed
   in until <time>" and the button is pressed again after that. If the sign-in start answers a code
   to type instead of a tab, Magnific refused the redirect registration: the text says what was
   refused and the device flow finishes the sign-in. **Advanced: paste a token** (under the same
   block) keeps the old path for one release: a bearer access token obtained by hand (the device
   flow against `https://auth.magnific.com/realms/mcp` with scope `openid profile email
   mcp:custom-audience`, or the token a connected MCP client holds), checked with `initialize` and
   `tools/list` (no credits), stored as `freepik_mcp_token`, never refreshed, and used only while
   no sign-in exists. Once signed in, remove it.

With no key the panel searches a **labelled demo catalogue** (six fixtures with server-drawn
placeholder cards, `/api/studio/freepik/demo/<id>.svg`) and nothing leaves the server; with no
MCP sign-in (and no pasted token) the MCP routes answer **Not connected** and a labelled demo tool list.

## The Magnific MCP sign-in (built; not run live)

`server/magnific-signin.ts` configures the shared OAuth helper `server/oauth-signin.ts` (the one
the Higgsfield sign-in runs on, docs/higgsfield-mcp.md) for `https://mcp.magnific.com`:

1. **Discovery** — `GET https://mcp.magnific.com/.well-known/oauth-protected-resource`, then the
   named authorization server's `/.well-known/oauth-authorization-server` (falling back to
   `/.well-known/openid-configuration`). Cached an hour in the isolate.
2. **Registration, once** (RFC 7591) — `POST …/clients-registrations/openid-connect` with
   `client_name: "Level Studio"`, `redirect_uris: ["${PUBLIC_BASE_URL}/api/studio/freepik/mcp/callback"]`,
   `grant_types: ["authorization_code", "refresh_token"]`, `response_types: ["code"]`,
   `token_endpoint_auth_method: "none"`, `scope` as below. The `client_id` (and `client_secret`,
   if one is issued) is stored as the encrypted setting `freepik_mcp_client` with the issuer and the
   redirect; reused while both match. The preview worker has its own `PUBLIC_BASE_URL`, so it
   registers its own client.
3. **Scopes** — what the resource's Bearer challenge demands, `openid profile email
   mcp:custom-audience`, plus **`offline_access`** because the realm lists it in `scopes_supported`
   (the helper adds an optional scope only when the metadata lists it). With `offline_access`
   Keycloak issues a refresh token; without one the sign-in simply ends when the access token does
   and the status says so ("Signed in until …").
4. **Authorization code + PKCE** — `POST /signin/start` (admin): `code_verifier` and S256
   challenge, a random `state`, kept fifteen minutes as `freepik_mcp_pending` with the admin's id;
   ledger row `mcp.signin` under provider `freepik`; answer `{mode: "redirect", url}` with
   `response_type=code`, `client_id`, `redirect_uri`, `scope`, `state`, `code_challenge`,
   `code_challenge_method=S256`, `resource=https://mcp.magnific.com` (RFC 8707; Keycloak ignores a
   parameter it does not know).
5. **Callback** — `GET /api/studio/freepik/mcp/callback?code&state[&iss]`: the session cookie comes
   along on the top-level redirect; admin only, the one who started, `state` must match, `iss`
   (RFC 9207, which the realm supports) must be the issuer; the code is exchanged with
   `code_verifier`; access token, refresh token, expiry, scope and the e-mail from the `id_token`
   (or from `userinfo` when the id token carries none; shown, never trusted for access) are stored
   as `freepik_mcp_tokens`; the browser lands on `/?magnific=connected` (a toast, Connection opens)
   or `/?magnific=error&reason=…`.
6. **Refresh** — a minute before expiry and once on a 401 from the MCP server, then the same tool
   call once more (a token refresh, never a job retry). `invalid_grant` ends the sign-in (tokens
   dropped, 409 "Magnific sign-in expired: sign in again under Connection → Freepik").
7. **Device-flow fallback** — when the redirect registration is refused, a device-flow client is
   registered (no `redirect_uris`), `…/auth/device` is called, the page shows the code and the
   link and polls `POST /signin/poll`.
8. **Sign-out** — `POST /signout` drops the tokens and the pending sign-in; the registered client
   and any pasted token stay; ledger row `mcp.signout`. The realm's revocation endpoint is not
   called yet.

The adapter's token source is the sign-in's access token; the pasted `freepik_mcp_token` is the
fallback while no sign-in exists (one release). `GET /api/studio/freepik/status` reports
`mcp: {connected, signedIn, token, url}`; `GET /api/studio/freepik/mcp/status` the sign-in itself.

## Where it is

- **Post editor → Image group → "Freepik assets"** (slot `freepik`, next to the Photo lab):
  search with type, orientation and colour filters; the result grid with the licence badge
  (**Free with attribution** / **Premium · in your plan** / **Credits: N** / **Premium · cost not
  known**); the chosen item with its format note (**Flattened picture, not editable layers** for a
  photo or PSD; **Editable vector (SVG)** for a vector); **Use as reference** (the post's reference
  picture, through the same storage as the reference route) and **Download to library**; the
  **Library** tab lists what was brought in for the client.
- **Photo studio → Assets** and **Text studio → Assets tab** (also *Layers › Add › Image… ›
  Freepik assets…*): one panel, described under "Assets as design elements" below.
- **Direction board → "pictures pinned to posts" row → Add from Freepik**: the picker with a
  post selector; the asset becomes that post's reference. The theme references row is untouched.
- Members see every entry with **Admins only for now** (the server refuses them with 403).

## Studio API

All under `/api/studio/freepik`; admin-only through `requireIntegrationAdmin(c, "freepik")` and
`assertIntegrationEnabled`, except `GET /status` (every member, so the UI can say "Admins only
for now"), `GET /assets/:id/file` (members may view a stored file: a design shows it) and
`GET /demo/:id.svg`.

- `GET /status` → `{connected, demo, reason, admin, access, plan, planLabel, downloadEstimate,
  entitlements, mcp: {connected, signedIn, token, url}, switch: {enabled, reason}}`
- `POST /plan {plan: "premium" | "business" | "unknown"}`
- `GET /search?q=&type=photo|vector|psd|template&category=icons|photos|backgrounds|textures|typography&orientation=&color=&page=&client=` →
  `{items[], page, lastPage, total, demo, connected, downloadEstimate}`; each item
  `{id, kind, title, author, license{type, attribution, uses, url}, preview, width, height,
  orientation, flattened, formats, url, demo}`
- `GET /resource/:id` → `{item, asset | null, connected, downloadEstimate}`
- `POST /download {id, confirm?, client?, batch?, post?}` → `200 {asset, reused, estimate, opId}`;
  `409 {needsConfirm: true, estimate, opId, asset}` until confirmed; `409 {blocked: true, plan}`
  when the cost is not known
- `POST /use {asset, batch, post, slide?, role: "reference" | "design", layerId?}` →
  `{asset, use, reference?}` or `{asset, use, layer: {src, name, flattened, layerable, preview,
  format, editable, colors, note, lettering, kind, aspect}}`
- `GET /assets?client=` → `{assets[]}` (with `uses` counts, and per asset `format`, `contents`,
  `editable`, `colors`, `formatNote`, `layerSrc`, `lettering`); `GET /assets/:id/file`
  (`?layer=1` the file an image layer draws, `?preview=1` the preview picture; every answer carries
  `Content-Security-Policy: default-src 'none'; … sandbox`)
- `GET /mcp/status` (every member) → `{signedIn, expired, email, signedInAt, expiresAt, refresh,
  scope, token, source: "signin" | "token" | null, admin, switch, access, url, callback, device}`
- `POST /mcp/signin/start` → `{ok, mode: "redirect", url}` or `{ok, mode: "device", userCode,
  verificationUri, verificationUriComplete, interval, expires, refused}`; `POST /mcp/signin/poll` →
  `{ok, signedIn, email}` or `{ok, signedIn: false, pending: true, interval}`;
  `GET /mcp/callback?code&state` → `302 /?magnific=connected|error&reason=…`; `POST /mcp/signout`
- `GET /mcp/tools` → `{connected, demo, reason, url, source, tools[{name, description, inputSchema,
  cost: free|download|credits, demo}]}`; the advanced path `POST /mcp/token {token}`,
  `DELETE /mcp/token`
- `POST /mcp/call {tool, arguments, confirm?, client?, batch?, post?}` → `{ok, tool, cost,
  estimate, opId, source, result, assets[]}`; `409 {needsConfirm, estimate, cost}` / `409 {blocked}` /
  `409 {connected: false}` / `409 {notSignedIn, expired}` when the sign-in ended

For the Prompt Box: `GET /api/studio/freepik/search`, `POST /api/studio/freepik/download`,
`POST /api/studio/freepik/use`.

## Assets as design elements (Photo studio and Text studio)

One panel (`src/studio/FreepikPanel.tsx`) in the Photo studio's Assets panel, the Text studio's
Assets tab and the dialog: a search box, the filter chips **All · Icons · Photos · Backgrounds ·
Textures · Typography** (more filters: type, orientation, colour), the results in their own
scrolling area, and a **sticky footer** with the selected asset's compact preview (title, source
badge, format, licence, the vector's colours when known, the format note) and its actions:

| Action | What it does | Cost |
| --- | --- | --- |
| **Add as layer** | an image layer on top of the design (move, resize, turn, fade, stack, duplicate, hide, delete like any layer) | the download (once, confirmed, in the Premium plan); the layer itself is free |
| **Set as background** | a full-canvas image layer at the bottom of the stack, drawn **behind the photo**: it shows where the photo is transparent and around it when the photo is made smaller (Properties › Background › Photo size) | as above; the photo is never made again |
| **Use as reference** | the post's reference picture for its next AI edit | as above (the AI edit itself is asked for separately) |
| **Save to library** | the download only, kept and reused | as above |

The chips map onto the search filters (`CATEGORY_RULES` in `server/freepik.ts`): Icons = vectors,
the word *icon*, SVG vectors first (`filters[vector][type][svg]`); Photos = photos; Backgrounds =
the word *background*; Textures = photos and the word *texture*; Typography = vectors, the word
*lettering*, SVG first. `filters[vector][type][svg]` is the documented vector-type filter as we
read it; if the API ignores it, the results are simply not narrowed.

**One search, one import.** In the Photo studio, *Add as layer* and *Set as background* download
the asset there (once), record the use, hand the layer over (`src/studio/assetHandoff.ts`,
sessionStorage) and open the Text studio on the same post with the asset already placed. The
search, its results and the selection are kept for the tab, so the Text studio's Assets tab shows
the same results and the stored asset without searching again. The library dedupes by provider id
(`assets` unique on `source, provider_id`): a second save, layer or background reuses the file.

**Sources.** Freepik, the client's Drive, Pinterest and uploads carry their own badge
(`src/studio/SourceBadge.tsx`) on the Assets tabs, the result footer, the layers list, a layer's
properties and the post's reference.

### Formats: read from the bytes (`server/asset-format.ts`)

| Downloaded file | What the layer draws | Colours editable? | Split into layers? | What the UI says |
| --- | --- | --- | --- | --- |
| SVG | the sanitised SVG | yes (per layer) | **yes** | *Editable vector (SVG): its colours can be changed on the layer.* |
| ZIP with an SVG (Freepik's vector bundle) | the sanitised SVG (EPS/AI stay in the library) | yes | **yes** (the SVG) | *Vector bundle with an SVG: …* |
| ZIP with EPS/AI and a PNG/JPG | that PNG/JPG | no | no | *This file is EPS/AI: colours cannot be changed here. The PNG/JPG it carries is placed instead.* |
| ZIP with EPS/AI only, an EPS, an AI | the preview picture (flattened) | no | no | *This file is EPS/AI: colours cannot be changed here. The preview picture is placed instead.* |
| PSD | the preview picture (flattened) | no | no | *This file is PSD: its layers and colours cannot be changed here…* |
| JPG, PNG, WebP, GIF | the file itself | no | no | *A picture (JPG/PNG): placed as it is…* |
| an uploaded SVG graphic (Layers › Add › Upload) | the sanitised SVG | yes | **yes** | the same as a Freepik SVG |
| anything else, a broken ZIP or SVG | the preview picture | no | no | said plainly |

No EPS, AI, PDF or PSD is converted: a Worker has no safe renderer for them and no outside
converter is used. An SVG is rebuilt from an allow-list (elements, attributes): scripts,
`foreignObject`, editor data (`i:pgf`, `sodipodi:*`), event handlers, `href` other than `#id` or
an embedded PNG/JPG/GIF/WebP, `url()` to anything but `#id`, `@import`, DOCTYPE and processing
instructions are dropped; Illustrator's plain DOCTYPE entities are expanded first; the root gets
the SVG namespace and a size from its viewBox; a shape with no fill gets the (default) black
written on the root so that black is a swatch too. The colours are the distinct `fill`, `stroke`,
`stop-color`, `flood-color`, `lighting-color` and `color` values (attributes, `style`, `<style>`
rules), up to 24, most used first (`shared/svg-colors.ts`).

**Recolouring** is a per-layer colour map (`ImageLayer.recolor`, original → new #rrggbb, at most
32) applied when the browser draws the layer: the same scanner rewrites those paint values and the
SVG is drawn from a data URL (`src/lib/textLayers.ts`, used by the studio, the cards, the exports
and the share page's preview alike). The library file never changes. Gradients recolour stop by
stop; colours set through CSS custom properties or `currentColor` are not listed or changed.

**Decorative lettering** (the Typography chip, or a title with lettering, typography,
calligraphy, word art, slogan, quote) is an image layer labelled *Decorative lettering (not
editable text)*, never a text box; **Add editable text** next to it adds a normal text layer.

### Vector layers: Split into layers, Remove background, Merge back

**Why a vector could not be taken apart before.** A Freepik vector (or any SVG) became *one*
image layer: the layer points at one stored file (`assets.layer_key`, served by
`GET /assets/:id/file?layer=1`), the renderer loads that file into an `<img>` and draws it on the
canvas as one picture (`src/lib/textLayers.ts`, `paintImage`), and the only per-layer control over
its inside was the colour map. Nothing in the layer model or the renderer knew about the SVG's
elements, so a shape could not be moved, deleted or recoloured on its own and a background rect
could not be dropped.

**What is there now** (`shared/svg-split.ts`, pure; `src/lib/svgSplit.ts`, the browser half;
`src/studio/text/VectorActions.tsx`, the UI):

- **Split into layers** (Layers panel and Properties › *Vector layers*, on any SVG image layer;
  also **Add as separate layers** in the Assets footer for a vector). The layer's SVG is fetched,
  sanitised again and parsed; the pieces are the root's painted children, descending through every
  group that is the only painted child of its parent (Illustrator's `Layer_1`, a named wrapper);
  a group with a `filter` or `mask` is never descended into (its effect is on the whole group);
  hidden elements are skipped. Each piece's bounding box is measured on the SVG rendered offscreen
  in the page (`getBBox` on every painted element mapped into the vector's coordinates with
  `getScreenCTM`; stroke width added, with the miter allowance; 15% added around filtered
  pieces) and cut to the part the layer shows (its viewport, crop and a cover fit). Each piece
  becomes its own small SVG: view box = its box in the vector's units, the same pixels per unit,
  the root's paint and every wrapper group around it (transforms and inherited fill kept), the
  definitions it needs closed over (gradients and their `href` chains, clip paths, masks, filters,
  patterns, markers, symbols reached through `<use>`) and only the CSS rules whose class/id
  selectors can apply to it (plus the `url(#…)` those rules point at). Each becomes an image layer
  (`piece: true`, the vector's `source`/`asset`, `format: "SVG"`, its own `colors`, the vector's
  recolour map kept for the colours it has) placed so the composition is unchanged: the box maths
  is the renderer's own (view box → natural pixels per `preserveAspectRatio`, crop, contain/cover,
  then the rotation about the layer's centre; a piece's centre is turned about the vector's centre
  and the piece keeps the angle). A box smaller than the schema's 1% minimum is grown by
  transparent margin, never by scaling. The pieces replace the vector in the stack, in paint
  order, under one **group** id (the existing layer groups): clicking the vector on the picture
  selects and moves all of it; **a row of the Layers list selects that piece alone** (as does a
  double-click on the picture), so a piece can be moved, resized, turned, faded, reordered,
  recoloured (*Vector colours*, the same `shared/svg-colors.ts` scanner) or deleted on its own.
  A design holds at most 40 layers: when a vector has more elements than the room left (at most
  30 pieces), neighbours in paint order with the smallest combined box are kept together (never
  the background) and the toast says so. Splitting a piece again splits that piece (same group).
  One undo step puts the single layer back.
- **Remove background**. On a whole vector: the background is found (from the bottom of the paint
  order, each *filled single shape* — rect, path, polygon, circle, ellipse, image, through groups
  of one — or a piece whose id/class says background, whose box covers at least 90% of the view
  box; an outline, a clipped or masked shape, a nearly transparent one, or a run that would take
  every element is never a background), **highlighted on the stage** (hatched red outline) with
  *Remove it and keep the other elements?*; on confirm a copy of the SVG without it is stored and
  the layer points at it (same frame: nothing moves). On a split vector the background is the piece
  marked `bgShape` at the split; it is highlighted the same way and removed on confirm. Esc or
  Cancel leaves everything as it was; ⌘Z undoes the removal. Any other piece is removed with Delete.
- **Merge back** (a piece of a split vector): the group's pieces are composed into one SVG again
  with every change made to them (each nested at its box, turned, faded, recoloured; deleted
  pieces stay deleted, hidden ones are left out; ids prefixed and CSS scoped per piece so they
  cannot collide), stored, and put in the stack where the lowest piece was. Pieces' different
  blend modes become normal (the toast says so). ⌘Z gives the pieces back.

**Lettering inside a vector is shapes**: a piece holding SVG `<text>` is named *… (lettering)* /
*Lettering N* and labelled *Decorative lettering (not editable text)*; outlined lettering (paths)
is simply shapes. Neither becomes a text box; **Add editable text** adds real words.

**Storage.** `POST /api/studio/posts/graphic/pieces?batch=` `{pieces: string[]}` (1–40 pieces,
each at most 2 MB after sanitising, 8 MB together) — the same month-scoped graphic storage as an
uploaded graphic (`<owner>/<batch>/graphics/<id>`, served by `GET /api/studio/posts/graphic`, the
month's owner or an admin, as every graphic). **Every piece is sanitised by the Worker** with the
same allow-list (`shared/svg-sanitize.ts`, moved out of `server/asset-format.ts` so the browser
runs it too before measuring); nothing the browser sends is stored as it came. A piece's id is
the first 128 bits of the SHA-256 of its sanitised bytes: an identical piece (the same vector
split twice, the same badge in two posts) is stored once. `POST /graphic` (an uploaded graphic)
now sanitises an SVG too (it stored the file as uploaded before), and `GET /graphic` answers an
SVG with the sandbox CSP. Pieces are ordinary image layers of the design (`ov.design`), so they
survive the auto-save, a refresh, reopening, *Save & return* and the card; the client's review
link draws them through `GET /api/share/<token>/layer/<post>/<layer id>`, which serves a piece
only when it is on that post of that month (`layerFile` already allowed this month's graphics).
The Freepik admin-only rules are unchanged: downloading and using an asset stay admin routes;
splitting a layer already in a design is a design edit (like moving it), open to whoever may
edit the month.

**Demo.** In the preview (no Freepik key) the demo *Sale badge set* (`demo-4`) is now a vector
bundle with an SVG of five elements (a background square, a ring, a ribbon, lettering, dots) so
*Add as separate layers* and *Remove background* can be tried; the *Lightning icon* (`demo-7`) is
one shape and says *nothing to split*; *Brush lettering* (`demo-9`, EPS only) says why it cannot be
split.

**Verified** (`tests/svg-split.test.ts`, `tests/svg-pieces.test.ts`,
`scripts/svg-layers-smoke.mjs`): with real fixtures in `tests/fixtures/svg/` (a badge: background
rect, gradient ring with a CSS-classed stroke, a disc whose gradient `href`s another, stripes
clipped to a circle, stars through `<use>` of a `<symbol>`, lettering with a drop-shadow filter;
an Illustrator icon set in a `Layer_1` wrapper with `.st0`-style classes, transforms and
strokes; an illustration with nested scaled/rotated groups, inherited fill and a CSS-painted
cloud), in headless Chromium at a 1080 × 1350 canvas, the composition before and after a split
differed in **8 of 1,458,000 pixels** (badge), **222** (icon set) and **856** (illustration)
by more than 24 of 255 on a channel (antialiasing at piece edges; mean difference ≤ 0.042), and
after *Merge back* in 187; after a save and a reload, **0**.

**Not possible here.** EPS, AI and PSD are not split: a browser cannot read them, the Worker has
no safe renderer, and no outside converter is used (a converter service could turn EPS/AI into
SVG; that would be a separate, priced decision). PDF likewise. The UI says so on the layer and in
the toast of *Add as separate layers*.

Existing assets stored before this change are read once on their next use (`ensureInspected`).
Migration `0074_asset_formats.sql` adds `format, contents, layer_key, layer_mime, colors,
format_note` to `assets`.

## Tests

`tests/asset-format.test.ts`: format sniffing; the sanitiser against scripts, handlers, split
tags, outside references, entities, `foreignObject`; a ZIP with an SVG (editable, colours), an
EPS-only ZIP (refused with the message), EPS+PNG, PNG/JPG, EPS/AI/PSD alone, broken files; colour
normalising, listing and recolouring. `tests/layer-ops.test.ts`: add, duplicate, remove, reorder,
bring forward/back, move/resize/rotate/opacity/hide, *Set as background* as the bottom layer (one
at a time), recolour maps, the layer an asset becomes, the schema keeping the new fields.
`tests/freepik-assets.test.ts` (paid guard): the chips' query, the demo chips, a vector ZIP stored
and used as an editable layer (the layer file served with the CSP), an EPS-only lettering bundle
placed as its preview, an old row read on use, an SVG reference sanitised and labelled, one
download for repeated saves and layers, member 403 on every action, and placing an icon,
recolouring it, setting a background and saving the design with no network call and no task.
`scripts/assets-smoke.mjs` (Chromium, mocked API): the flow at 1440×1000 and 390×844 with the
sticky footer measured at the top and the bottom of the results.

`tests/svg-split.test.ts`: parsing and writing the sanitised SVG back; the splitting rules (root
children, single-child wrappers, no descent through filters/masks, hidden elements); piece names
(lettering, editor ids and classes ignored); the definitions closure (gradient `href` chains,
clip paths, `<use>` symbols, filters, CSS rules by selector and their `url()`); a piece keeping its
wrappers' transform and fill; pieces passing the sanitiser and a hostile file split into clean
pieces; background detection (first in paint order, ≥ 90%, never an outline/clipped/small shape,
never everything; the illustration's sky through its wrapper's transform at 90.25%); removing it
keeps the frame; the placement maths with rotation, meet offsets, slice, crop and `none` (every
test point of a piece lands within 1e-6 px of where it was), tiny pieces grown by margin;
merging to the layer budget; *Merge back* (ids and CSS scoped, nested boxes, rotation, opacity);
the schema keeping `piece`/`bgShape`; the demo badge splitting into five with its background.
`tests/svg-pieces.test.ts` (paid guard): pieces stored sanitised (scripts, handlers,
`foreignObject`, outside references gone), deduplicated, limits (not SVG, 0 or 41 pieces, over
2 MB), another owner's month refused (an admin allowed), an uploaded SVG graphic sanitised, and
the review link serving a piece through its post and refusing it through another post, another
month's piece and an unknown layer.
`scripts/svg-layers-smoke.mjs` (Chromium, mocked API storing pieces the Worker's way; run with
`node --experimental-strip-types`): split three fixtures with pixel comparisons, remove the
illustration's background (highlight, confirm, undo, redo), move/recolour/delete badge pieces,
remove the badge's background piece, save, reload (same layers, same pixels), *Save & return*,
reopen, *Merge back*, *Add as separate layers* for an SVG and an EPS-only vector, the review link
drawing every piece, and the actions on screen at 390 × 844.

`tests/freepik.test.ts`, under the paid guard (any network call the test did not stub fails it):
the demo status and the member view; the search shape and every filter against the fixtures;
member 403 on every admin route; a download proposed, confirmed, stored once and reused (one
`assets` row, one bucket object, ops proposed → running/done → done "Reused"); use as reference
(the post's `reference` updated, the thumbnail made for a raster file through the reference
storage, an SVG kept as is, a ZIP refused); use as design (the layer file URL, the layer id and
slide recorded); the documented search query and list mapping with a key; the blocked download
while the plan is unknown or Business, then the two-step download on Premium; the MCP adapter
against a mocked server (initialize with a session id, `notifications/initialized`, paged
`tools/list`, JSON and event-stream answers, a free call with its items into the library,
`simulate_cost` → confirm → run, an unknown cost blocked, a stock download landing on the row the
search made, a refused token), and Not connected without a token.

`tests/magnific-signin.test.ts`, under the same guard, against stand-ins for the metadata
documents, the Keycloak realm and the MCP endpoint: discovery, one registration, the PKCE start
(S256, state, the demanded scopes plus `offline_access` only when the realm lists it), the
callback exchange and the encrypted rows (no token or e-mail in clear), the status, a refresh
ahead of expiry and once on a 401 (then the same call once), the "signed in until …" path with
no refresh token (the e-mail from `userinfo`) and its expiry, `invalid_grant`, the device-flow
fallback, sign-out, member 403, switch 503, and `POST /call` on the sign-in's token with the
pasted token as the fallback.

Not run live: no key, no token, no sign-in and no paid call were used while this was built
(the metadata documents were read with `curl -s`, nothing registered).

## Limitations

- The sign-in has not run live: whether the realm's anonymous registration policy accepts the
  `scope` with `mcp:custom-audience` and `offline_access`, whether a web `redirect_uri` is
  accepted (else the device fallback), and whether `offline_access` yields a refresh token are
  the first things to check (see "The Magnific MCP sign-in"). The pasted-token path is kept one
  release as the fallback and is not refreshed.
- The Business/Enterprise per-download credit rate is unknown to the studio, so downloads on
  those plans are blocked until the pricing page can be read (or the rate is entered by hand in
  `downloadEstimate`).
- The daily cap (100 on the Premium family) is not counted locally; the API's 429 is surfaced.
- The MCP result parser recognises stock items by an id with a preview, URL or title; other
  tools' answers are returned as they come and not turned into assets.
- Vector downloads through the API are source bundles (ZIP): when the bundle carries an SVG it
  becomes an editable layer; EPS/AI-only bundles and PSDs are placed as their preview picture and
  their colours cannot be changed here (no converter runs in the Worker).
- Image layers point at `/api/studio/...` URLs; the review link rewrites them to
  `/api/share/<token>/layer/<post>/<layer id>`, which serves only the layers on that post.
- Splitting: an element drawn partly outside the vector's view box is cut at it (as the vector
  showed it); a piece's box is the bounding box of its shapes (a rotated ellipse's box is a little
  larger than the ellipse: transparent margin only). Group opacity on a wrapper becomes per-piece
  opacity, which differs only where pieces overlap. SVG `<text>` is measured with the browser's
  fonts, as it is drawn. Merge back of pieces that were interleaved with other layers puts the
  merged vector at the lowest piece's place in the stack. Pieces of a vector split in a design are
  stored with that month; they are not written back to the Freepik library.
- A background shows only where the photo is transparent or around a smaller photo: making an
  opaque photograph's own backdrop disappear needs a cut-out (a paid tool, asked separately).
