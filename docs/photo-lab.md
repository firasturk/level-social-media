# Photo lab (Freepik / Magnific real-photo tools)

Four tools for real photos, applied to a client's approved Drive product photos, to a post's made
picture, or to an earlier Photo lab result:

| Tool | Good for, on real product photos | Needs a prompt |
| --- | --- | --- |
| **Remove background** | A clean cut-out on transparency: packshots, collages, the Text studio's layers. The product's print and shape stay exactly as photographed. | No |
| **Replace background** | The real product kept as it is and set into a new scene you describe (a marble counter, a wooden table by a window), with the light matched to the scene. The honest alternative to asking an image engine to repaint the product. | Yes |
| **Relight** | Flat phone-camera light, mixed kitchen light or a harsh flash fixed without touching the product. Describe the light wanted; the scene stays. | Optional |
| **Upscale** | A small, soft or compressed photo made sharp at twice its size (the creative Magnific upscaler), for large posts and print. | No |

Every run is a job: the input is copied into the bucket first, the provider is given a signed URL
(or the bytes), the result is downloaded next to it, and before/after can be compared. A result can
then become the post's picture (the previous one is kept as a take and under **Versions**), be
saved as a product photo of the month (a `sources` row, like a Drive import), or be downloaded.
A result can also be fed into another tool (remove the background, then upscale).

## Setup for Firas

1. Sign in at freepik.com and open the API dashboard (the docs call it **API Keys** in the
   organisation dashboard; the documentation now lives at docs.magnific.com, where
   docs.freepik.com redirects). Create an API key.
2. In the studio: **Connection → Freepik**, paste the key, **Save**. The key is checked with one
   authenticated call that spends no credits (a stock search, the documented authentication
   example), then stored encrypted on the server. **Remove** (the bin icon) deletes it.
3. Until a key is saved the Photo lab says **Demo · Not connected** and every run is a demo: the
   result is the input itself, nothing is sent anywhere, cost 0.

Credits are bought on freepik.com (the plans include API credits; top-ups on request). A refused
call (bad key, no credits) fails the job with Freepik's own message.

## Where it is

- **Post editor → Image group → "Photo lab (Freepik)"**: the post's current picture or one of the
  client's Drive product photos, the four tools with what each is good for and about what it costs,
  a prompt box with dictation for the two tools that take one, **Run** (the cost is confirmed
  first), progress, the before/after slider, then **Use as the post's picture**, **Save as a
  product photo**, **Download**, **Run another tool on this result**, and **Earlier results**.
- **Drive picker → pick one product photo → "Open in Photo lab"**: the same panel in a dialog, for
  a photo that is not a post's picture yet (save the result as a product photo of the month).

## Approximate costs

`PHOTO_LAB_PRICES` in `shared/pricing.ts`, USD per picture, **approximate**: Freepik bills credits
per call and publishes the credit rates on its pricing page, which the studio could not read while
this was built (the pricing pages refuse automated readers). The working figures are:

| Tool | About |
| --- | --- |
| Remove background | $0.02 |
| Replace background | $0.10 |
| Relight | $0.10 |
| Upscale (2x) | $0.12 |

The confirmation dialog says "about $X"; the job records the figure as its cost. Check the first
real invoice against these and adjust the table.

## Endpoints used

All in one constants block, `FREEPIK` in `server/photolab.ts`. Base URL `https://api.magnific.com`;
the key is sent under both `x-magnific-api-key` (the documented header) and `x-freepik-api-key`
(the former name), so either gateway accepts it.

| Purpose | Call | Status |
| --- | --- | --- |
| Verify a key | `GET /v1/resources?limit=1` | From the docs' authentication example (a stock search). Assumed to spend no credits: stock *searches* are not billed, downloads are. |
| Remove background | `POST /v1/ai/beta/remove-background`, `application/x-www-form-urlencoded`, `image_url` | Read from the docs. **Synchronous**: answers `{original, high_resolution, preview, url}`; the URLs live 5 minutes, so the result is downloaded at once. |
| Relight / Replace background | `POST /v1/ai/image-relight`, JSON `{image (URL or base64), prompt, change_background, style, preserve_details, light_transfer_strength}` → `{data: {task_id, status, generated[]}}`; `GET /v1/ai/image-relight/{task-id}` | Read from the docs. Replace background is the relight tool with `change_background: true` and the prompt: the docs list no dedicated replace-background endpoint (the Magnific MCP has one, the public API does not). |
| Upscale | `POST /v1/ai/image-upscaler`, JSON `{image (base64), scale_factor: "2x", optimized_for: "films_n_photography", creativity, resemblance, engine}` → `{data: {task_id, status, generated[]}}`; `GET /v1/ai/image-upscaler/{task-id}` | Read from the docs. |

Task statuses: `CREATED`, `IN_PROGRESS`, `COMPLETED`, `FAILED`. The UI polls `GET
/api/studio/photolab/jobs/:id` every 2.5 s; each poll asks the provider once and, on `COMPLETED`,
downloads `generated[0]` into `photolab/<id>-out.<ext>`.

### To verify on the first live run

- That a key created on freepik.com is accepted by `api.magnific.com` (the docs moved there; if
  not, switch `FREEPIK.base` to `FREEPIK.legacyBase`, `https://api.freepik.com`).
- That the relight tool with `change_background: true` gives the scene the prompt asks for, as the
  Replace background tool; otherwise an image-editing model (the docs list Seedream 4.5 edit) would
  be the next candidate.
- That `GET /v1/resources` spends no credits (it is the documented authentication example).
- The real credit rates, against the table above.

## Studio API

`/api/studio/photolab` (`server/photolab.ts`):

- `GET /status` → `{connected, provider: "freepik" | "demo", reason, prices, approximate}`
- `POST /key {key}` (verified first), `DELETE /key`
- `POST /run {client, source, op, prompt?}` with `source` one of `{kind: "drive", id}`,
  `{kind: "task", batch, id}`, `{kind: "job", id}` and `op` one of `remove-bg | background |
  relight | upscale` → `{job, connected, provider, reason}`
- `GET /jobs?client=` → the client's jobs, newest first
- `GET /jobs/:id` → polls the provider when running
- `GET /jobs/:id/image?which=in|out`
- `POST /jobs/:id/use {as: "product", batch, name?}` or `{as: "picture", batch, post}`

Table `photolab_jobs` (migration `0066_photolab_jobs.sql`): client, batch and post when the input
came from a month, op, prompt, input and output keys, status `queued | running | done | failed`,
provider `freepik | demo`, the provider's task id, the approximate cost, the error.

## Tests

`tests/photolab.test.ts`, under the paid guard (any network call the test did not stub fails it):
the demo status and a demo job that never calls out; a demo Drive photo as input; the prompt rule
and the other-client refusal; the key saved only after the verification call; each tool's
documented request shape (form `image_url` for remove background, JSON with `change_background`
true/false for replace background and relight, base64 with `scale_factor` for upscale); polling
through `IN_PROGRESS` to `COMPLETED` with the result stored; a `FAILED` task readable with its
error; a 402 refusal failing the job with Freepik's message; a result saved as a product photo
(the `sources` row, a free name on the second save) and set as a post's picture (task output
replaced, the previous kept as a take and a month version).

## Gaps

- Not run against the live API yet: see "To verify on the first live run".
- Upscale is fixed at 2x (the other factors cost more); the relight style and strength are fixed
  to sensible defaults. No image-expand tool yet (the docs have `POST /v1/ai/image-expand/flux-pro`).
- Remove background returns a PNG with transparency; a post's picture with transparency is shown
  over the card's background as the browser draws it.
- The small JPEG copy vision reads (`reference_key`) is made with the thumbnail helper when the
  image library is available; otherwise the original stands in.
- Jobs are not purged with a month; they are small (one input, one output) and listed per client.
