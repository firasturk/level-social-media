# Freepik assets (stock content API and the Magnific MCP)

Stock photos, vectors, PSDs and templates from Freepik, brought into the studio as a post's
**reference picture** or as an **image layer** of a design. One shared layer (`server/freepik.ts`)
serves the API routes and the MCP adapter (`server/freepik-mcp.ts`; the JSON-RPC client itself lives in `server/mcp-client.ts`, shared with the Higgsfield MCP adapter), over one library
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
| Authorization server: Keycloak realm `https://auth.magnific.com/realms/mcp` with `authorization_endpoint`, `token_endpoint`, a **device authorization endpoint** (`…/protocol/openid-connect/auth/device`) and an **open dynamic client registration endpoint** (`…/clients-registrations/openid-connect`): a custom app can register itself and sign a user in with the authorization-code (PKCE) or device flow | `/.well-known/oauth-protected-resource`, `/.well-known/oauth-authorization-server` | **Verified** (a registration probe named `level-studio-probe`, a public client with no secret, was created and can be ignored or removed by Magnific support) |

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
3. **Magnific MCP token** (optional): the server wants an OAuth access token for the Magnific
   account, not the API key. Obtain one with the device flow against
   `https://auth.magnific.com/realms/mcp` (register a public client at
   `…/clients-registrations/openid-connect`, start `…/protocol/openid-connect/auth/device` with
   scope `openid profile email mcp:custom-audience`, sign in in the browser, exchange the device
   code at the token endpoint), or copy the token a connected MCP client holds. Paste it under
   **Connection → Freepik → Magnific MCP**: it is checked with `initialize` and `tools/list` (no
   credits) and stored as the encrypted setting `freepik_mcp_token`. Access tokens expire; the
   studio does not refresh them (a refused token says so: paste a fresh one).

With no key the panel searches a **labelled demo catalogue** (six fixtures with server-drawn
placeholder cards, `/api/studio/freepik/demo/<id>.svg`) and nothing leaves the server; with no
MCP token the MCP routes answer **Not connected** and a labelled demo tool list.

## Where it is

- **Post editor → Image group → "Freepik assets"** (slot `freepik`, next to the Photo lab):
  search with type, orientation and colour filters; the result grid with the licence badge
  (**Free with attribution** / **Premium · in your plan** / **Credits: N** / **Premium · cost not
  known**); the chosen item with its format note (**Flattened picture, not editable layers** for a
  photo or PSD; **Editable vector (SVG)** for a vector); **Use as reference** (the post's reference
  picture, through the same storage as the reference route) and **Download to library**; the
  **Library** tab lists what was brought in for the client.
- **Text Studio → Layers → Add → Freepik asset**: the same picker in design mode; **Add to
  design** records the use against the new layer's id and adds the image layer (a flattened
  picture is said so).
- **Direction board → "pictures pinned to posts" row → Add from Freepik**: the picker with a
  post selector; the asset becomes that post's reference. The theme references row is untouched.
- Members see every entry with **Admins only for now** (the server refuses them with 403).

## Studio API

All under `/api/studio/freepik`; admin-only through `requireIntegrationAdmin(c, "freepik")` and
`assertIntegrationEnabled`, except `GET /status` (every member, so the UI can say "Admins only
for now"), `GET /assets/:id/file` (members may view a stored file: a design shows it) and
`GET /demo/:id.svg`.

- `GET /status` → `{connected, demo, reason, admin, access, plan, planLabel, downloadEstimate,
  entitlements, mcp: {connected, url}, switch: {enabled, reason}}`
- `POST /plan {plan: "premium" | "business" | "unknown"}`
- `GET /search?q=&type=photo|vector|psd|template&orientation=&color=&page=&client=` →
  `{items[], page, lastPage, total, demo, connected, downloadEstimate}`; each item
  `{id, kind, title, author, license{type, attribution, uses, url}, preview, width, height,
  orientation, flattened, formats, url, demo}`
- `GET /resource/:id` → `{item, asset | null, connected, downloadEstimate}`
- `POST /download {id, confirm?, client?, batch?, post?}` → `200 {asset, reused, estimate, opId}`;
  `409 {needsConfirm: true, estimate, opId, asset}` until confirmed; `409 {blocked: true, plan}`
  when the cost is not known
- `POST /use {asset, batch, post, slide?, role: "reference" | "design", layerId?}` →
  `{asset, use, reference?}` or `{asset, use, layer: {src, name, flattened, layerable}}`
- `GET /assets?client=` → `{assets[]}` (with `uses` counts); `GET /assets/:id/file`
- `GET /mcp/tools` → `{connected, demo, reason, url, tools[{name, description, inputSchema, cost:
  free|download|credits, demo}]}`; `POST /mcp/token {token}`, `DELETE /mcp/token`
- `POST /mcp/call {tool, arguments, confirm?, client?, batch?, post?}` → `{ok, tool, cost,
  estimate, opId, result, assets[]}`; `409 {needsConfirm, estimate, cost}` / `409 {blocked}` /
  `409 {connected: false}`

For the Prompt Box: `GET /api/studio/freepik/search`, `POST /api/studio/freepik/download`,
`POST /api/studio/freepik/use`.

## Tests

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

Not run live: no key, no token and no paid call were used while this was built.

## Limitations

- The studio stores one MCP access token and does not refresh it; the OAuth sign-in itself is
  done outside the studio (see Setup).
- The Business/Enterprise per-download credit rate is unknown to the studio, so downloads on
  those plans are blocked until the pricing page can be read (or the rate is entered by hand in
  `downloadEstimate`).
- The daily cap (100 on the Premium family) is not counted locally; the API's 429 is surfaced.
- The MCP result parser recognises stock items by an id with a preview, URL or title; other
  tools' answers are returned as they come and not turned into assets.
- Vector downloads through the API are source bundles (ZIP): kept in the library, not usable as
  a reference or a layer; the SVG of a vector comes through the MCP's `stock_download`
  (`type: icon`) or an upload.
