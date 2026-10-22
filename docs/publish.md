# Publishing posts to Instagram (Meta Graph content publishing)

The studio publishes a finished post to the client's Instagram business account, now or at a time,
straight from the card. The artwork that goes out is exactly what the card shows: the engine's
picture with the headline, the sub-line and the logo drawn over it in the browser, at 1080 px, as
a JPEG. The caption and the hashtags go with it, separated by a blank line.

## What it does

- **Card menu → "Publish to Instagram…"** opens the publish dialog: the Instagram account (from the
  Meta connection; the last account used for this client is remembered), **Now** or **On its date at
  10:00** (an editable date and time, defaulting to the post's date at 10:00 in the designer's time
  zone), a preview of the artwork as it goes, the caption as it goes with its character count, and
  the button **Publish** or **Schedule**.
- **A carousel** (posts grouped with `group.kind === "carousel"`) is one Instagram post: every slide
  is composed and sent in one call, whichever slide's menu was opened. Instagram requires all slides
  to have a picture, 2 to 10 of them.
- **Month More menu → "Schedule the approved posts…"** queues every post the client approved on the
  approval link (`approvals[index].status === "approved"`) that is not already scheduled or
  published, each on its own date at 10:00 (a date already past goes out at once; a post with no
  date takes the next 10:00). Carousels are queued once.
- **The card's pill** shows the state: "Scheduled 12 Oct 10:00", "Publishing…", "Published ↗" (a
  link to the post on Instagram), or "Publish failed" with Meta's message on hover. The dialog
  offers **Cancel the schedule** for a queued post and **Retry** for a failed one.
- **Connection → Instagram** shows "Publishing: ready" or the exact reason it is not.
- **The cron** (every minute) publishes queued posts whose time has come, at most three per pass.
  Each row is claimed with `UPDATE … WHERE status = 'queued'` before anything is sent, so two passes
  never publish the same post twice. A row left in `publishing` for 15 minutes (the Worker died
  mid-call) is marked failed with a readable note so it can be retried.

Nothing is published without a real Meta token that carries the publishing permission. Without one,
every screen says **Not connected** and what to do.

## Files

| File | Role |
| --- | --- |
| `migrations/0064_publications.sql` | `publications` (one row per Instagram post, with the R2 keys of its slides) and `client_publish` (which account a client publishes to). |
| `shared/publish.ts` | The `Publication` shape, `buildCaption`, `defaultPublishAt`, `slidesOf`, `publicationFor`, limits. |
| `server/publish.ts` | `publishRoutes` (mounted at `/api/studio/publish` in `server/studio.ts`), `publishDue(env)` (one line in `scheduled()` in `server/index.ts`), the Graph calls. |
| `src/studio/publish.ts` | Browser side: the month's publications, the status, the artwork composer (`renderOverlay` at 1080 px, JPEG 0.9). |
| `src/studio/PublishDialog.tsx` | The post dialog, the month dialog, the card pill, the readiness line in Connection. |
| `tests/publish.test.ts` | Everything against a fake Graph API; a call to any other host fails the test. |

### Routes

- `GET /api/studio/publish/status?client=` → `{connected, reason, accounts: [{igId, username}], chosen}`.
  Connected means a token is saved, it sees at least one Facebook Page with an Instagram business
  account, and `me/permissions` grants `instagram_content_publish`.
- `POST /api/studio/publish` `{batch, index, igAccount, when: "now" | ISO datetime, artwork: [JPEG data URL, …]}`
  stores each slide under `publish/<id>-<n>.jpg`, inserts a queued row and, for "now" (or a time
  already past), publishes immediately. Refuses a second live publication of the same post, a PNG,
  a caption over 2,200 characters, a wrong number of slides, and an account the token does not see.
- `GET /api/studio/publish?batch=` → the month's publications. `POST /:id/cancel` (queued only),
  `POST /:id/retry` (failed or cancelled: re-queued and published at once with the same artwork).

### Graph calls (v23.0)

Single picture: `POST /{ig}/media {image_url, caption}` → poll `GET /{container}?fields=status_code`
until `FINISHED` (12 looks, 2.5 s apart) → `POST /{ig}/media_publish {creation_id}` →
`GET /{media}?fields=permalink`. Carousel: one child container per slide with
`is_carousel_item=true`, each polled, then a container with `media_type=CAROUSEL` and
`children=…`, polled, then `media_publish`. The image URLs are signed studio URLs
(`signObjectUrl`, 24-hour TTL): Instagram fetches the picture from the studio's R2 bucket. Meta's
error message is kept on the row (`error`) with status `failed`; an expired token (code 190) and a
missing permission (codes 10/200) are translated into what to do.

## Setup Firas must do once

1. **Link the Instagram account to a Facebook Page.** In Instagram: Settings → Account type and
   tools → switch to a Professional (Business) account, then Settings → Business tools → Connect a
   Facebook Page. The Page admin must be the person who generates the token. Every client account
   to publish to needs its own Page link, and the token's user must manage that Page.
2. **The Meta app** (already created for the reading connection: type Business, named Level Social
   Media). In App Dashboard → Use cases, add "Manage everything on your Page" / Instagram content
   publishing, so the permissions below can be requested.
3. **Generate a token with the publishing permission.** Graph API Explorer → pick the app → add the
   permissions `instagram_basic`, `instagram_content_publish`, `pages_show_list`,
   `pages_read_engagement` (the reading connection also uses `instagram_manage_insights`,
   `business_management`, `ads_read`; keep them so profiles keep working) → Generate Access Token →
   allow the Pages and their Instagram accounts when Facebook asks.
4. **Extend it.** Access Token Debugger → paste → Debug → Extend Access Token → copy the new
   (60-day) token.
5. **Reconnect in the studio.** Connection → Instagram → paste the token → Replace. The tab then
   reads "Publishing: ready. Posts go to @…". If it still says "Not connected for publishing.
   Reconnect Instagram in Connection with the publishing permission", the token was generated
   without `instagram_content_publish`: repeat step 3.
6. While the app is in **Development mode**, only accounts of people with a role on the app (admin,
   developer, tester) can be published to. Add the client's Instagram user as a tester, or submit
   the app for App Review on `instagram_content_publish` to publish to any account the token manages.

The 60-day token expires; the Connection tab shows the date. Paste a new one before it.

## Limits (Meta's)

- Pictures only, **JPEG** (the dialog composes JPEG; a PNG is refused). Up to 8 MB.
- Aspect ratio between **4:5 and 1.91:1**; a 9:16 story format is refused by Instagram (the dialog
  warns). The studio's 1:1 and 4:5 formats pass.
- **25 posts per account per rolling 24 hours** (`content_publishing_limit`); a carousel counts as
  one. Beyond it Meta answers an error, kept on the row.
- Captions up to **2,200 characters**, at most 30 hashtags.
- Carousels: 2 to 10 pictures, all the same aspect ratio is recommended.
- The image URL must be reachable by Meta's servers: `PUBLIC_BASE_URL` must be the public studio
  address (it is the one the fal.ai inputs use already).

## Costs

Free. The Meta Graph API charges nothing for content publishing. The only spend is the Workers
cron minute and the R2 storage of the composed JPEGs (a few hundred KB per slide).

## Known gaps

- Not exercised against the live Graph API tonight (no token with the publishing permission); the
  calls follow Meta's content publishing reference and are tested against a fake that answers like
  Meta.
- Stories, Reels and videos are not published (pictures and picture carousels only).
- Alt text, location tags, product tags and user tags are not sent.
- The daily limit is not checked before queueing; a refused post shows Meta's message and can be
  retried the next day.
- Deleting a published post has to be done on Instagram; the studio keeps the row as published.
- The composed JPEGs under `publish/` are not purged with the month; a cleanup can be added to
  `cleanupOldBatches` later.
- The scheduled time is the designer's local 10:00 at the moment of scheduling; the cron fires
  within the minute after it.
