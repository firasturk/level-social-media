# Level Social Media

Social-media post studio for Level MENA's clients. The team picks a **client**, the client's brand
kit and **themes** drive every image, and the input is either **product photos** or a **script**.
The output is publish-ready posts (1:1, 4:5, 9:16, 16:9), stories, carousels and whole **feed
grids**, reviewed against the originals and exported per client with captions.

The app is a re-branded clone of Max Fashion Studio: one Cloudflare Worker serving a React SPA
(Vite) plus a Hono API, with **D1** for metadata, **R2** for originals and every generated
revision, and a **cron trigger** that keeps batches moving when nobody has the tab open. The
engines (Google Nano Banana via API key or Vertex, OpenAI, fal.ai, Higgsfield) are unchanged.

The product contract, data model, prompts and build plan live in
[docs/level-social-media](docs/level-social-media/README.md) (the `level-social-media` Claude
skill). Phase 0 (clone, rename, new D1 and R2, deploy) is done; the approach cards from the fashion
studio are still visible until Phase 1 replaces them with client cards.

## How generation runs

1. Originals are stored in R2 untouched. A downsized JPEG reference is created in the browser and
   stored alongside for inference and thumbnails.
2. Saving a batch creates one task per output.
3. `Generate` marks the batch `running`. The engine loop (`server/engine.ts`) submits up to
   `MAX_CONCURRENT_GENERATIONS` tasks, polls status, downloads finished images into R2 and sets
   each task to `review` (or `ready` when automated review is on).
4. The loop is driven from three places with the same idempotent function: the browser tick while
   the batch is open, the optional engine webhook, and the Worker cron (every minute). Every
   transition is a conditional `UPDATE`, so concurrent drivers never double-submit.
5. Revisions re-submit only that task with the product, any reference and the latest result
   attached. Each revision is stored as a new object; the visible result points to the latest.

Vendor keys (Google API key, Vertex service account, OpenAI, fal, Higgsfield) are entered in the
**Connection** dialog, stored encrypted in D1 and never returned by the API.

## Setup

```sh
pnpm install
cp .dev.vars.example .dev.vars   # fill in the values
pnpm db:migrate:local
pnpm dev                          # http://localhost:5173
```

Create the first account from the sign-in screen with the invite code from `.dev.vars`.

### Secrets and variables

| Name                         | Where            | Purpose                                                                     |
| ---------------------------- | ---------------- | --------------------------------------------------------------------------- |
| `SESSION_SECRET`             | secret           | Long random string that signs session cookies                               |
| `INVITE_CODE`                | secret           | Required to create an account; unset to close registration                  |
| `HIGGSFIELD_API_KEY`         | secret, optional | `KEY_ID:KEY_SECRET` from https://cloud.higgsfield.ai (or set in Connection) |
| `HIGGSFIELD_MODEL`           | var              | Model slug on `api.higgsfield.ai` (default `nano-banana-pro`)               |
| `HIGGSFIELD_BASE_URL`        | var              | `https://api.higgsfield.ai`                                                 |
| `MAX_CONCURRENT_GENERATIONS` | var              | Parallel engine requests per batch (default 6)                              |
| `GEMINI_API_KEY`             | secret, optional | Automated review when no Google key is set in Connection                    |
| `WEBHOOK_TOKEN`              | secret, optional | Protects `/api/hooks/engine`; with `PUBLIC_BASE_URL` enables webhooks       |
| `PUBLIC_BASE_URL`            | var              | Public URL of the deployed Worker                                           |

## Deploy

Cloudflare resources (account "Firas@levelmena.com's Account"):

- Worker `level-social-media` at https://level-social-media.max-fashion-studio.workers.dev
- D1 `level-social-media`, R2 bucket `level-social-media` (ids in `wrangler.jsonc`)

```sh
wrangler secret put SESSION_SECRET
wrangler secret put INVITE_CODE
pnpm db:migrate:remote            # after adding a migration
pnpm check                        # typecheck + lint + unit tests + build; deploy only on exit 0
pnpm run deploy
```

`pnpm run deploy` builds the client, embeds it into the Worker bundle (`scripts/embed-assets.mjs`
writes `wrangler.deploy.json`) and runs `wrangler deploy`. `wrangler.jsonc` `alias` must list every
`@shared/*` module; a missing alias fails the Worker build only, not `pnpm check`.

## Reference libraries

Identity photos, feed-grid screenshots and theme references are stored as library photos in R2
under `refs/<scope>/<id>` with rows in the `refs` table, managed inside the app ("Add photos" /
remove). Each generation borrows place, light and camera from one library photo, rotating so
results differ; products, faces and accessories are never copied. `assets/zaid/` holds the sample
fashion mood board used as the first theme example; upload it once per bucket if needed:

```
for f in assets/zaid/*.jpg; do
  npx wrangler r2 object put "level-social-media/refs/zaid/$(basename "$f")" --file "$f" --content-type image/jpeg --remote
done
```

## Checks

```sh
pnpm check        # typecheck + lint + unit tests + build
pnpm test         # vitest: naming rules, prompts, config rules, engine clients, password hashing
```

## Layout

```
server/      Worker: Hono routes, auth, engine loop, engine clients
shared/      Config schema, prompt builders, rules, naming (used by both sides)
src/         React client (studio UI, review dialog, ZIP export)
migrations/  D1 schema
tests/       Vitest unit tests
docs/        Product brief and the level-social-media skill
```
