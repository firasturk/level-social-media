# Google Drive: approved folders, roles and snapshots

The studio reads a client's photos from its Google Drive through the Google Cloud service account
that Vertex runs on. A folder is read once it is shared with that account as **Viewer** and
**approved** in the studio with a role.

## Folders and roles

Each approved folder (`drive_folders`) has one role:

| Role        | What it holds                       | What the studio does with it                                         |
| ----------- | ----------------------------------- | -------------------------------------------------------------------- |
| `product`   | Photos of the products              | The only photos a post is built from: "Pick for me", "Add to month". |
| `brand`     | Logos, packaging art, brand files   | Listed apart; never joins a month as a product.                      |
| `reference` | Inspiration pictures                | Pinned to a post as its reference from the post editor.              |
| `output`    | Finished pictures the team exported | Listed for the record.                                               |

While a client has **no approved folder**, the folder linked on its profile
(`client_profiles.drive`, the old "Connect" link) is read as its `product` folder. The moment one
folder is approved, only approved folders are read.

Photos keep the role of the folder they were found under (`drive_photos.role`). The listing answers
them grouped (`groups.product`, `groups.brand`, `groups.reference`, `groups.output`), and the picker
shows them in four tabs. Product photos and references are never mixed: a reference is pinned, a
product photo is imported.

## Duplicates and missing files

The listing reads `md5Checksum` and `modifiedTime` for every file. Two files of one client with the
same checksum are the same picture: every later copy carries `duplicateOf` (the first one's id) and
the picker shows "same as …"; "Add to month" adds a pair once.

A photo the studio knew that Drive no longer gives (deleted, moved out of the shared folders,
unshared, or in the bin) takes `status = 'missing'` in `drive_photos` with a `reason`, and the
listing returns it under `missing` so the picker can show "Not available in Drive". Files in the bin
are detected at listing time; files that answer 404 are detected when their bytes are asked for and
when a complete listing no longer sees them. A photo that comes back is listed again and read anew.

A photo whose checksum changed in Drive is read again by the vision cron (its name, kind and note
are refreshed).

## Snapshots: what a month used never changes

Drive is a source, not the truth of what a picture was made from. The bytes the studio copies are.

- **Import as a product** (`importDrivePhoto`): the rendition is copied into the bucket as the
  month's source, and the `sources` row records `drive_id`, `drive_version` (the file's
  `modifiedTime`) and `drive_md5`.
- **Pin as a reference** (`POST /api/studio/drive/:client/pin`): a large rendition and a thumbnail
  are copied into the bucket under the month (`<owner>/<batch>/reference/<id>…`), and the post's
  `reference` records `{ key, thumb, name, note, at, drive: { id, version, md5, name } }`.

If the file changes later in Drive (a new version, a new checksum), nothing in an older month
changes: the copied bytes and the recorded version are the source of truth. Importing or pinning the
photo again takes the new version. Removing a folder or a file from Drive does not remove what a
month already used.

## The demo listing

On a preview deployment (`PREVIEW_NO_IMAGES=1`) with **no** Google Cloud credential, the Drive
picker is served an in-memory fixture (`server/drive-mock.ts`): six drink photos (one duplicate
pair), one file in the bin, one brand logo and two references. The listing answers `demo: true`
and the UI shows "Not connected · demo listing". The fixture is never used when a credential
exists, whatever the deployment: a broken credential gives Drive's own error.

## Routes

| Route                                          | What it does                                                              |
| ---------------------------------------------- | ------------------------------------------------------------------------- |
| `GET /api/studio/drive`                        | The service-account email to share with, and whether this is the demo.    |
| `GET /api/studio/drive/:client`                | The listing: folders, photos with roles, `groups`, `missing`, `demo`.     |
| `GET /api/studio/drive/:client/folders`        | The client's folders (approved or waiting).                               |
| `POST /api/studio/drive/:client/folders`       | `{ link \| id, role, approved? }`: add a folder.                          |
| `PUT /api/studio/drive/:client/folders/:id`    | `{ role?, approved? }`: change its role or approval.                      |
| `DELETE /api/studio/drive/:client/folders/:id` | Take the folder off the client.                                           |
| `PUT /api/studio/drive/:client`                | The profile folder link (the default product folder).                     |
| `GET /api/studio/drive/photo/:id?size=`        | A rendition of one photo (404 and `missing` when Drive no longer has it). |
| `POST /api/studio/drive/:client/pin`           | `{ batch, post, photoId, note? }`: pin a photo to a post as reference.    |
| `POST /api/studio/drive/:client/pick`          | The vision model picks the best product photos.                           |

## Connecting a real Drive

1. Connect the Vertex service account in Connection (Drive is read with its token).
2. Enable the Google Drive API in that Google Cloud project.
3. Share each client folder with the service account's email as Viewer.
4. In the picker, add each folder with its role and approve it. The profile link keeps working as
   the product folder until a folder is approved.
