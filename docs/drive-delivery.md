# Deliver a month to the client's Google Drive

The month-level More menu has **Deliver to the client's Drive…**. It writes the final artwork of
the month's posts (the words and logo composed over the picture, exactly as the export draws them,
as 1080 px JPEGs at quality 0.9) and a `captions.txt` into a month folder inside the client's
**Outputs** folder in Google Drive. The studio writes through the same Google Cloud service account
that reads the client's photos (the one Vertex runs on); for this one job it asks Google for a
write token (`https://www.googleapis.com/auth/drive`). Every other Drive call stays read-only.

## Setup (once per client)

1. In the studio, connect Vertex in **Connection** (the service account JSON). The dialog shows the
   account's e-mail; without a credential it says so and nothing is sent.
2. In Google Drive, the client (or the team) makes the folder deliveries should land in and shares
   it with the service account e-mail as **Editor** (Viewer is enough for reading photos, not for
   writing).
3. In the studio's Drive picker (the Drive step of the month), add that folder's link with the role
   **Outputs** and approve it. Only an approved folder with the role Outputs is used; the product
   folder never stands in. Without one, the dialog says
   "Pick an Outputs folder in the Drive picker…".

The dialog checks the folder before anything is sent (`GET files/{id}?fields=capabilities(canAddChildren)`).
When the account can see the folder but not write to it, or cannot see it at all, the dialog says
"Share the folder with `<service account e-mail>` as Editor" with a Copy button for the e-mail.

## What is delivered

- **Scope**: "Approved posts only" (the default as soon as the client has answered on any post) or
  "All made posts". Only posts of the current plan that have a picture count.
- **Pictures**: one JPEG per post, named `NN Title.jpg` (`03 Mango crossing.jpg`; characters Drive
  or Windows would refuse become spaces, titles are cut at 80 characters).
- **captions.txt** (optional, on by default): one block per delivered post of the plan, with the
  number and title, the posting date when set, the caption and the hashtags, separated by `---`.
  It covers every post of the month delivered so far, not only this run's.
- **Folder**: `<Month label> · Level Social Media` (for example
  `October 2026 · Level Social Media`) directly under the Outputs folder, found by name or created.

The browser composes each picture (so brand fonts and the on-image edits are the ones the designer
saw) and sends them in chunks of 4 posts per request as base64 data URLs; the dialog shows the step
of every post (composing, uploading, in Drive with its link) and the folder link at the end.

## Delivering again

Every file written is remembered in `drive_deliveries` (migration 0065: batch, post, kind, Drive
file id, name, checksum, link). Delivering a post again **updates that file in place**
(`PATCH upload/drive/v3/files/{id}?uploadType=media`), renaming it when the title changed, so the
client's folder never fills with copies and shared links keep working. The same goes for
`captions.txt`. If a file was deleted in Drive meanwhile, it is created anew. The month folder is
looked up by name under the Outputs folder each time, so a renamed or moved month folder leads to a
fresh one.

## Routes

Mounted in `server/studio.ts` at `/api/studio/drive/delivery` (`server/drive-delivery.ts`):

| Route                             | What it does                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------- |
| `GET /:client/status`             | The Outputs folder, whether the account can write there, and the reason not. |
| `POST /:client/deliver`           | `{batch, posts: [{index, image}], captions}` → `{folder, files}`.            |
| `GET /:client/deliveries?batch=`  | What the month delivered so far, with links.                                 |

Drive's 403 and 404 answers become one readable error naming the account to share with; a 5xx or
a dropped connection is tried three times before it is reported as "Google Drive answered …".

## Costs

Free: the Google Drive API has no charge, and the pictures are composed in the browser. Only the
request bodies pass through the Worker.

## Limits

- Up to 4 posts per request; a 1080 px JPEG is a few hundred kilobytes, so a chunk stays well under
  the Worker's request limits. A month of 30 posts is 8 requests.
- Google is phasing out storage for service accounts: a service account cannot own files in a
  **My Drive** folder once its own quota is zero (Drive answers `storageQuotaExceeded`). The dialog
  then says so; the fix is a **shared drive** with the service account added as Content manager (the
  Outputs folder can be any folder inside it). Folders in a shared drive work in every case.
- Pictures are uploaded as made; Drive's `md5Checksum` is stored for the record, not compared, so an
  unchanged post is re-uploaded on a second delivery (it still updates in place).
- Carousel slides are posts of the plan like any other, so each slide is one file.
