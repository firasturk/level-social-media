# Notifications: the team hears when a client answers

When a client opens the approval link (`/share/<token>`) and approves a post or asks for a change,
the studio tells the team. Three things happen:

1. **The answer is recorded** (`notifications` table, status `pending`) the moment the client's
   approval page posts it. The answer itself still lands in the month's config as before; this is a
   copy for sending and counting.
2. **The board shows "Client answered · n new"** beside the month's counts. The number is the
   answers newer than the moment _you_ last looked (`notify_seen`, one mark per person and month).
   Clicking it opens the Client approval tab and marks them seen.
3. **One e-mail per month goes out**, sent by the cron (every minute) through
   [Resend](https://resend.com). A month's answers are grouped: the mail leaves once the oldest
   pending answer is **ten minutes** old (so a client clicking through twelve posts produces one
   mail, not twelve), or at once when every made post has an answer. Subject:
   `Habibah · November 2026: 2 approved, 1 change asked`. Body: each answer with the post number and
   title from the plan, approved or change asked, the client's note, who answered; then a link to
   the studio (`/?client=<id>&month=YYYY-MM`, which opens that month) and to the client page.

## Who gets the mail

On the **Client approval** tab, each team member has a switch: **Email me when `<client>`
answers**. The mail goes to everyone who switched it on for that client. When nobody did, it goes
to **every admin**. Disabled accounts are never written to.

## Setup (Firas, once)

1. Create a Resend account at [resend.com](https://resend.com) and make an API key under
   **API Keys** (sending permission is enough).
2. Under **Domains**, add the sending domain (for example `levelmena.com`) and create the DNS
   records Resend shows (SPF, DKIM, optionally DMARC). Wait until Resend marks the domain verified.
   Without this Resend refuses the mail, and the row is kept as **failed** with Resend's message.
3. In the studio: **Connection → Notifications**. Paste the key, set the **from address** on that
   domain, for example `Level Studio <studio@levelmena.com>`, and save. The tab shows **Connected**.
4. Press **Send a test e-mail**: one mail to your own address, nothing else.

The key is stored encrypted in the settings table (`resend_api_key`, the same key the admin page's
batch alerts use), the sender under `notify_from`. Nothing is in code or in the repository.

### Without a key

The feature says **Not connected**. Answers are still recorded and the badge still counts them, but
when a month comes due its rows become **unsent** instead of being mailed. They are never retried on
their own. Once a key is saved, **Send the unsent (n)** on the Notifications tab sends them, one mail
per month, so nothing the client said is lost.

If a key is saved but no from address, the mail goes out from Resend's test sender
(`onboarding@resend.dev`), which Resend delivers **only to the address that owns the Resend
account**. Set the from address for the team to receive it.

## Cost

Resend's free tier is 3,000 e-mails a month and 100 a day, with one verified domain. One mail per
client month per answering session is far below that, so the feature costs nothing at the studio's
volume. Paid plans start at about $20 a month for 50,000 e-mails should that ever change.

## What we did not build: WhatsApp

A WhatsApp message would reach the team faster, but it means the Meta WhatsApp Cloud API: a Meta
Business account with a verified business, a dedicated phone number registered to the API (it can
no longer be used in the WhatsApp app), a message **template** that Meta reviews and approves before
anything can be sent outside a 24-hour customer window (a "client answered" alert is exactly such a
template), and per-conversation pricing (a utility conversation in Jordan costs a few cents, billed
to a Meta ad account with a card attached). The e-mail path needs none of that, and the client-side
"Send on WhatsApp" link the studio already has stays as it is. If WhatsApp alerts become worth the
setup, the sender is one more function beside `sendResend` in `server/notify.ts`; the recording,
grouping, subscriptions and badge do not change.

## Tables and routes

- `notify_subscriptions(user_id, client, created)`: who hears about which client.
- `notifications(id, client, batch, kind, payload, status, sent_at, error, created)`: one row per
  answer; `status` is `pending`, `sent`, `unsent` or `failed`.
- `notify_seen(user_id, batch, seen_at)`: each member's seen mark per month.
- `GET /api/studio/notify/status`, `POST /settings` (admin), `DELETE /settings/key` (admin),
  `GET|POST /subscriptions`, `GET /unseen?batch=`, `POST /seen`, `POST /test`,
  `POST /send-unsent` (admin).
- Cron: `sendDueNotifications(env)` in `server/index.ts`'s `scheduled()`.
- Tests: `tests/notify.test.ts` (fetch is mocked; nothing reaches Resend).
