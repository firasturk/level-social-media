# Connect tools · branch `connect-tools`

Four integrations built in parallel on `tools/publish`, `tools/drive-delivery`, `tools/photo-lab` and `tools/notify`, merged here on top of `overnight-scope`. Preview: https://studio-preview.max-fashion-studio.workers.dev (migrations 0064–0067 applied on the preview D1). Production was **not** deployed from this branch; `main` was not touched.

Every feature answers "Not connected" with the exact step to take until its credential is saved in Connection, and nothing is sent to a provider before then. Each one has its own doc: docs/publish.md, docs/drive-delivery.md, docs/photo-lab.md, docs/notifications.md.

## 1. Publish to Instagram (`server/publish.ts`, `src/studio/PublishDialog.tsx`, migration 0064)

- Card menu → **Publish to Instagram…**: the artwork as the card shows it (picture, words, logo) composed in the browser as a 1080 px JPEG, the caption plus hashtags, the Instagram account remembered per client, **Now** or **On its date at 10:00** (editable). Carousels go out as one carousel.
- Month → More → **Schedule the approved posts…**: every post the client approved, each on its date at 10:00.
- The cron publishes what is due (three per pass, each row claimed once); a pill on the card shows Scheduled / Published (link) / Failed with Retry and Cancel in the dialog.
- Connection → Instagram shows "Publishing: ready" or the reason it is not.
- Needs: the Meta token re-generated with `instagram_content_publish` (plus `instagram_basic`, `pages_show_list`, `pages_read_engagement`); each client's Instagram business account linked to a Facebook Page the token's user admins; while the Meta app is in Development mode only accounts with an app role can be published to. Cost: free.

## 2. Deliver to the client's Drive (`server/drive-delivery.ts`, `src/studio/DeliverDialog.tsx`, migration 0065)

- Month → More → **Deliver to the client's Drive…**: approved posts (or all made posts) as `NN Title.jpg` plus `captions.txt`, into a subfolder `<Month> · Level Social Media` under the client's **Outputs** folder. Re-delivery updates the same files, never duplicates.
- Needs: in Drive, share the client's Outputs folder with `level-studio@level-social-media-ffa8.iam.gserviceaccount.com` as **Editor** (a shared drive if Google refuses ownership in My Drive); in the Drive picker give that folder the role Outputs and approve it. Cost: free.

## 3. Photo lab (`server/photolab.ts`, `src/studio/PhotoLabPanel.tsx`, migration 0066)

- Editor → Image → **Photo lab (Freepik)**, and Drive picker → pick a photo → **Open in Photo lab**: Remove background · Replace background (prompt) · Relight (prompt) · Upscale 2x, on the post's picture or on any of the client's approved Drive photos. Before/after slider; the result can become the post's picture (the previous stays under Versions) or a product photo of the month.
- Every run shows "about $X" and is confirmed first. Approximate prices (to check against the first invoice): remove background $0.02 · replace background $0.10 · relight $0.10 · upscale $0.12.
- Needs: a Freepik API key (Connection → Freepik; verified with one no-credit call). Endpoints come from docs.magnific.com (the Freepik API now lives there); the base URL and credit rates are to be confirmed on the first live run. Without a key the lab runs as a labelled demo.

## 4. Notifications (`server/notify.ts`, `src/studio/Notify.tsx`, migration 0067)

- When a client approves or asks for a change on the approval page, the team gets **one e-mail per month** (grouped: sent 10 minutes after the first answer, or at once when every made post is answered) listing each answer with the post, the note and who wrote it, with links to the studio month and the client page.
- Client approval tab → **Email me when <client> answers** (per member; with nobody subscribed, every admin gets it). Board head → **Client answered · n new** badge.
- Connection → Notifications: Resend key, from address, test e-mail, "Send the unsent". Without a key the answers are kept as unsent and sent later.
- Needs: a resend.com account, the sending domain verified there (DNS records), a key. Cost: free tier (3,000 e-mails a month). WhatsApp was not built (documented path in docs/notifications.md).

## Tested

- Gate chain on the merged branch: typecheck, eslint, `vitest` 482 tests passed (19 publish, 9 delivery, 13 photo lab, 8 notify are new), build.
- Preview walk: the four status routes answer with their Not connected reasons; More menu shows Deliver and Schedule; card menu shows Publish to Instagram and its dialog composes the artwork and shows the caption; the Photo lab panel renders in demo mode in the editor; a real answer on the sample month's approval page became a pending notification (then removed).
- Not exercised live: Graph publishing, Drive writes, Freepik calls, Resend sends. All are behind credentials and tested against fakes.

## Release

`git merge connect-tools` into `main`, apply migrations 0064–0067 on the production D1 (`npx wrangler d1 migrations apply DB --remote --config wrangler.deploy.json`), deploy `studio`. Rollback = redeploy the previous version; the migrations are additive.
