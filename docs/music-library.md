# Music library: sources, licences and what we can promise

Research and design for the Video editor's music library, written on 23 October 2026. Every
licence below was read at the source on that day: the Wikimedia Commons API (licence, author,
SHA-1 and size of each file), incompetech.com (Kevin MacLeod's FAQ, Content ID page and track
catalogue) and the other providers' own terms pages. Nothing was bought, no key was used, and no
file was uploaded to the studio's storage. The code is `shared/music.ts` (licences, filters, BPM,
waveform, the licence form), `shared/music-catalog.ts` (the starter catalog),
`shared/music-test-audio.ts` (the generated test loops), `server/music.ts` (the routes) and
`src/video-editor/ui/MusicLibrary.tsx` (the panel).

## 1. What we can and cannot promise

**We can say:**

- Each catalog track is offered under a licence that allows commercial use in a client's video
  and allows us to keep a copy in the studio for the team (CC0 or CC BY). The licence, its version,
  the link to its text, the author, the source page and the credit line are kept with the track and
  shown before anyone uses it.
- For CC BY tracks, the credit line is the one the author asks for. Publishing it with the video
  (in the caption or the description) is what the licence requires; the panel marks it
  "Required: publish this with the video".
- For a client's own tracks, an admin filled in and confirmed the source, author, licence and
  Content ID status at import; the studio records who and when, and refuses NonCommercial,
  NoDerivatives and ShareAlike licences.
- The file we serve is the one we copied: its size and SHA-1 are recorded, and for the Commons
  originals the copy must match the checksum Commons published (otherwise nothing is stored).

**We cannot promise:**

- **That a video will never receive a copyright claim.** A licence lets us use a recording; it does
  not stop YouTube Content ID, Meta's Rights Manager or TikTok's matching from flagging a video.
  Kevin MacLeod's music is *registered* with Content ID on purpose (see §2); classical recordings
  are often matched against other performances of the same piece. What we can do is answer a claim
  quickly: the credit in the description, the source page and the licence link are the proof.
- That a track's licence will not change at the source. CC licences cannot be withdrawn for copies
  already made, so we keep the licence as it was when we copied the file (the date is in the
  catalog), but a source can remove a file or relabel it.
- That a client's own track is cleared. The studio records what the admin confirmed; it cannot
  check a purchase receipt or a commission contract.
- Anything about Instagram's or TikTok's in-app music libraries: those can only be added inside
  their apps (docs/audio-capabilities.md).

## 2. The starter catalog (verified)

Twelve recordings plus three generated test loops. "BPM (source)" is the composer's own figure from
incompetech.com's catalogue; our beat analysis agreed within 2 BPM on six of the nine Kevin MacLeod
tracks (Upbeat Forever 166, Meatball Parade 150, Exit the Premises 129, Monkeys Spinning Monkeys
144, Sneaky Snitch 86, Hidden Agenda 131) and misread the other three (Desert City's triplet feel,
Volatile Reaction's 7/4, Sovereign Quarter's free piano). The classical recordings carry no BPM: our
analysis found no steady pulse in the Aria and the Overture, and a number would mislead.

| Track | Author / performer | Licence + version | Attribution (credit line) | Content ID | Mood · genre · length · BPM | Source page |
| --- | --- | --- | --- | --- | --- | --- |
| Upbeat Forever | Kevin MacLeod | CC BY 3.0 | "Upbeat Forever" Kevin MacLeod (incompetech.com) / Licensed under Creative Commons: By Attribution 3.0 / https://creativecommons.org/licenses/by/3.0/ | Registered | upbeat, playful · Ska · 3:15 · 164 | https://commons.wikimedia.org/wiki/File:Upbeat_Forever_(ISRC_USUAN1500063).mp3 |
| Monkeys Spinning Monkeys | Kevin MacLeod | CC BY 4.0 | "Monkeys Spinning Monkeys" Kevin MacLeod (incompetech.com) / Licensed under Creative Commons: By Attribution 4.0 / https://creativecommons.org/licenses/by/4.0/ | Registered | playful, upbeat · Light orchestral · 2:05 · 144 | https://commons.wikimedia.org/wiki/File:Monkeys_Spinning_Monkeys_by_Kevin_MacLeod.ogg |
| Meatball Parade | Kevin MacLeod | CC BY 3.0 | "Meatball Parade" Kevin MacLeod (incompetech.com) / … By Attribution 3.0 / https://creativecommons.org/licenses/by/3.0/ | Registered | playful, upbeat, energy · Big band · 3:25 · 150 | https://commons.wikimedia.org/wiki/File:Meatball_Parade_(ISRC_USUAN1500014).mp3 |
| Exit the Premises | Kevin MacLeod | CC BY 3.0 | "Exit the Premises" Kevin MacLeod (incompetech.com) / … 3.0 | Registered | energy, upbeat · Electronica · 3:30 · 128 | https://commons.wikimedia.org/wiki/File:Exit_the_Premises_(ISRC_USUAN1500029).mp3 |
| Volatile Reaction | Kevin MacLeod | CC BY 3.0 | "Volatile Reaction" Kevin MacLeod (incompetech.com) / … 3.0 | Registered | energy, cinematic · Orchestral soundtrack · 2:45 · 155 | https://commons.wikimedia.org/wiki/File:Volatile_Reaction_(ISRC_USUAN1400039).mp3 |
| Desert City | Kevin MacLeod | CC BY 3.0 | "Desert City" Kevin MacLeod (incompetech.com) / … 3.0 | Registered | **Arabic-flavoured**, calm · World (Middle Eastern) · 1:29 · 86 | https://commons.wikimedia.org/wiki/File:Desert_City_(ISRC_USUAN1100564).mp3 |
| Sovereign Quarter | Kevin MacLeod | CC BY 3.0 | "Sovereign Quarter" Kevin MacLeod (incompetech.com) / … 3.0 | Registered | calm, cinematic, corporate · Piano · 4:51 · 109 | https://commons.wikimedia.org/wiki/File:Sovereign_Quarter_(ISRC_USUAN1100454).mp3 |
| Sneaky Snitch | Kevin MacLeod | CC BY 4.0 | "Sneaky Snitch" Kevin MacLeod (incompetech.com) / … 4.0 / https://creativecommons.org/licenses/by/4.0/ | Registered | playful, cinematic · Light orchestral · 2:17 · 87 | https://commons.wikimedia.org/wiki/File:Sneaky_Snitch_by_Kevin_MacLeod.ogg |
| Hidden Agenda | Kevin MacLeod | CC BY 3.0 | "Hidden Agenda" Kevin MacLeod (incompetech.com) / … 3.0 | Registered | cinematic, playful · Orchestral soundtrack · 2:15 · 132 | https://commons.wikimedia.org/wiki/File:Hidden_Agenda_(ISRC_USUAN1200102).mp3 |
| Goldberg Variations: Aria | Musopen (commissioned recording); J. S. Bach | CC0 1.0 | Not required; courtesy: "Goldberg Variations: Aria (J. S. Bach), recording by Musopen, CC0 1.0" | Unknown | calm, corporate · Classical piano · 4:47 · — | https://commons.wikimedia.org/wiki/File:Bach,_Goldberg_Variations,_Aria_(Musopen_version).ogg |
| Prelude No. 1 in C major, BWV 846 | Musopen; J. S. Bach | CC0 1.0 | Not required; courtesy credit kept | Unknown | calm, corporate · Classical piano · 4:14 · — | https://commons.wikimedia.org/wiki/File:JS_Bach_-_Well_Tempered_Clavier_-_Prelude_in_Fugue_No.1_in_C_major.ogg |
| Coriolan Overture, Op. 62 | Czech National Symphony Orchestra for Musopen; L. van Beethoven | CC0 1.0 | Not required; courtesy credit kept | Unknown | cinematic · Classical orchestral · 8:19 · — | https://commons.wikimedia.org/wiki/File:Ouvertüre_"Coriolan"_(c-moll,_op._62).ogg |
| Test beat 120 (Test audio) | Level studio (generated) | CC0 1.0 (our own work) | — | Not registered | upbeat, energy · Test audio · 0:24 · 120 | generated by `shared/music-test-audio.ts` |
| Test pads 80 (Test audio) | Level studio (generated) | CC0 1.0 | — | Not registered | calm, corporate · Test audio · 0:40 · 80 | generated |
| إيقاع مقسوم تجريبي — Maqsum test rhythm (Test audio) | Level studio (generated) | CC0 1.0 | — | Not registered | Arabic-flavoured, upbeat · Test audio · 0:12 · 100 | generated (maqsum rhythm, Hijaz scale) |

Evidence, per source:

- **Wikimedia Commons** (all twelve recordings). The API answered for each file `LicenseShortName`
  (CC BY 3.0, CC BY 4.0 or CC0), `UsageTerms`, `AttributionRequired`, `Artist`, the SHA-1 and the
  size; the catalog pins SHA-1 and size for the seven MP3 originals. For the five Ogg originals the
  studio copies Commons' own MP3 transcode (`/transcoded/…/<name>.ogg.mp3`), because MP3 decodes in every browser
  the team uses and Ogg support in Safari is recent and uneven; the original's SHA-1 is noted in the catalog. Commons states its media may be
  reused outside Wikimedia under each file's licence; its User-Agent policy asks automated clients
  to name themselves ("Scripts should use an informative User-Agent string with contact
  information"), which the copy route does.
- **Kevin MacLeod / incompetech.com.** The seven Commons MP3s are byte-identical to the files on
  incompetech.com (same SHA-1). The FAQ gives the credit format ("Title Kevin MacLeod
  (incompetech.com) / Licensed under Creative Commons: By Attribution 4.0 /
  https://creativecommons.org/licenses/by/4.0/"), says the credit must be placed "such that a person
  who wants to know where the music came from should have no difficulty in finding it", and for
  videos "in the video description or in the video itself". Incompetech offers the music under CC BY
  4.0 today; the Commons copies we use carry CC BY 3.0 or 4.0 as uploaded, and the catalog keeps the
  version of the copy we use. **Content ID: registered.** Incompetech's Content ID page says the music
  is "pre-registered" so that third parties cannot claim it, that a claim usually means the credit is
  missing or only inside the video, and to "add credits BEFORE YOU DISPUTE THE CLAIM"; the claim
  should be "released within 72 hours"
  (https://incompetech.com/music/royalty-free/youtube-contentid.html).
- **Musopen** (three classical recordings). The Commons pages carry CC0 and say the recordings come
  from Musopen (https://archive.org/details/MusopenCollectionAsFlac); the Goldberg Aria is a
  recording "commissioned by Musopen itself", the Overture is "Performed by the Czech National
  Symphony Orchestra for the Musopen Project". Neither page says anything about Content ID: unknown.

## 3. Sources checked and left out

| Source | Why it is not in the catalog |
| --- | --- |
| **Mixkit** | Its music may be used in finished projects, but Mixkit's terms say "Items cannot be resold in their original form" and the Stock Music Free License is a separate document shown only in a pop-up on mixkit.co/license; offering its tracks inside our tool would be redistributing the library. Not scraped, not mirrored. |
| **Pixabay** | Its Content License forbids selling or distributing content "on a Standalone basis", meaning "where no creative effort has been applied to the Content" — an in-app library of the files is exactly that. There is no Pixabay music API (the API covers images and videos), and none was invented. |
| **YouTube Audio Library** | Its terms limit use to "videos and other content that you create" and forbid distributing the files apart from that content; standard-licence tracks are for YouTube. Not redistributable in-app. |
| **Magnific / Freepik music** | Paid (credits) and its terms forbid registering tracks with UGC platforms and some uses (see docs/audio-capabilities.md §3); the API services terms were not readable by an automated reader. A person must read them before it is used. |
| **Freesound** (CC0 music loops) | The sounds' licences are clear (several good CC0 candidates below), but the downloadable original needs a signed-in account, Freesound's API terms restrict distributing content and ask for a negotiated agreement for commercial use, and copying the website's preview files is not addressed by any of its terms. Left out of the automatic copy; an admin can download a CC0 original and import it with the licence form. |
| **Jamendo** | Each track's CC licence varies and many are NC; Jamendo sells separate commercial licences ("Jamendo Licensing") and many artists are with collecting societies. No track was verified for this round. |
| **Free Music Archive** | Per-track CC licences ("FMA cannot license original work to you"); several Kevin MacLeod uploads came from FMA and are flagged on Commons "License review needed (audio)" (As I Figure, Off to Osaka, Radio Martini), so those were dropped. |
| **ccMixter** | Has CC BY tracks ("Free to use, even in commercial projects but you must give credit"), but remixes inherit their samples' licences and many are NC; not verified track by track this round. |
| **Commons "own work" lofi** (Chill Beat, Lofi music 001) | CC0 on Commons, but the uploader's own claim is the only provenance, and one file is 44 MB. Left out. |
| **Openverse** | Used to find candidates only: it is an index, and its records can lag the source (it lists Monkeys Spinning Monkeys as CC BY 3.0; the Commons page now says 4.0). Every licence above was read at the source. |

Freesound CC0 candidates for a manual import (licence read on each page: "CC0 1.0"):
"oud and ney" by kafokafo (https://freesound.org/people/kafokafo/sounds/128355, 20 s, Arabic-flavoured),
"Corporate company introduction video" by Bertsz (https://freesound.org/people/Bertsz/sounds/524308, 59 s),
"Good Vibe Background Music" by Seth_Makes_Sounds (https://freesound.org/people/Seth_Makes_Sounds/sounds/661782, 2:30),
"Epic Music loop" by FusionWolf3740 (https://freesound.org/people/FusionWolf3740/sounds/570463, 2:58),
"Cinematic Dramatic Buildup" by BurghRecords (https://freesound.org/people/BurghRecords/sounds/456102, 59 s),
"Upbeat loop" by mistermender (https://freesound.org/people/mistermender/sounds/512340, 58 s, tagged 125 bpm).
Content ID for each: unknown.

## 4. How the audio is stored and served

- **Nothing is in the repository and nothing was uploaded.** The catalog keeps each track's
  canonical URL. The first time anyone plays or uses a catalog track, `GET /api/studio/music/file`
  copies it into R2 (`music/catalog/<slug>.mp3`): the route refuses a track whose catalog entry does
  not allow redistribution, sends an identifying User-Agent, checks the type, the 25 MB limit and the
  pinned size and SHA-1, stores the file with its licence in the object's metadata, and records the
  copy (`music_copies`: track, key, source URL, licence, bytes, SHA-1, when, who) and a ledger row
  (`integration_ops`, provider "audio", kind `music.copy`, estimate 0). If Commons is busy (429) or
  the file changed, nothing is stored and the person is told so.
- **Test audio** is synthesised by the server on first use (a WAV of a few seconds, deterministic)
  and stored and recorded the same way.
- **Serving** is through the existing `serveObject` (server/range.ts): HEAD, `Accept-Ranges`, 206
  with `Content-Range`, 416 for a range past the end, so previews seek and Safari plays.
- **A client's tracks** live at `music/library/<client>/<id>.<ext>` with a `music_tracks` row
  (migration `0075_music_library.sql`).
- **Waveforms** are 400 peaks per track, cached in R2 at `music/peaks/<id>.json` and computed once:
  by the server for WAV files (test audio, small uploads), otherwise by the first browser that
  decodes the track (`PUT /api/studio/music/peaks`; later sends never overwrite the cache).

## 5. Importing a client's track (Drive or upload)

Admins only (`requireIntegrationAdmin(c, "audio")`, the "Video audio" switch); members browse and
preview. The import form needs, before anything is stored:

- the track's name (Arabic or English), optional artist, moods, genre and BPM;
- **source** (where it comes from, in words) and optionally the source link;
- **author or performer**;
- **licence**: CC0, Public Domain Mark, CC BY 4.0, CC BY 3.0, a paid licence, own work or
  commissioned, or another licence (named, with a link to its text); NonCommercial, NoDerivatives,
  ShareAlike, personal-use and no-redistribution wording is refused;
- **attribution text**, required when the licence asks for credit;
- **Content ID**: unknown, registered or not registered, with notes;
- the confirmation "I confirm we may use this track in client videos and keep it in the studio for
  the team, under the licence described here."

From Drive the admin pastes the file's link; the file must be shared with the studio's Google
account (the same service account as the photo folders). The row records the Drive file id, its
version (modifiedTime) and checksum. Correcting a licence later (`PATCH`) checks the whole form and
asks for the confirmation again; removing a track archives it (the file and licence record stay for
the videos that used it). Every import, edit and removal is a ledger row.

## 6. The panel and how to wire it

`src/video-editor/ui/MusicLibrary.tsx` is self-contained (its own CSS, its own API module
`src/video-editor/musicApi.ts`):

```tsx
<MusicLibrary
  client={clientId}            // the client whose own tracks show; null = catalog only
  clientName="Habibah"         // optional, for the tab
  selectedId={currentTrackId}  // optional: highlights the track in use
  onPick={(pick) => …}         // pick: MusicPick
/>
```

`MusicPick` is `{ track, fileUrl, credit, pickedAt }`: `track` is the `MusicTrack` (shared/music.ts)
with `licence {id, name, version, url, attribution, attributionRequired}`, `contentId {status,
note, url}` and `source {name, page, author}`; `fileUrl` streams the audio from our storage; `credit`
is the line to publish with the video. The panel never changes the project.

### Wired into the editor's Music tab (video editor phase 3, 23 Oct 2026)

- The Music tab opens with the library (`src/video-editor/ui/MusicSourcePanel.tsx`): the catalog
  and, on a post, the client's own tracks (the editor now receives the client from the month:
  `VideoEditor`'s `client` prop, passed by `PlanView`). Browsing and previewing are open to
  everyone; **picking a track for the cut is an edit, so admins only** (members see the button as
  "Admins only" and nothing happens). Importing a client's track stays inside the library, admins
  only, with the licence form, as before. The tab's own "Pick a track" (a file from this
  computer, kept with the post as a licensed track) and the post's tracks still work.
- A pick is fetched from `pick.fileUrl` (our Range route), decoded, its beats found, and stored in
  the project as a new `MusicSource` (shared/video-project.ts):
  `{ kind: "catalog", trackId: "cat:<slug>", name, rights }` or
  `{ kind: "library", trackId: "lib:<uuid>", client, name, rights }`, where `rights` is
  `{ licence {id, name, version, url}, attributionRequired, credit, author, sourcePage,
  contentId {status, note, url}, test? }` (`musicSourceFromTrack`). `validateProject` checks the
  ids, that the licence is one of the allowed ids (no NC/ND/SA can get in), that a licence asking
  for credit has its credit line, and the Content ID status. The older kinds (`audioKey`, `upload`)
  are unchanged.
- **Reopening** a draft reads the track again from `/api/studio/music/file?id=<trackId>`
  (`musicFileUrl`), so it sounds the same and renders with it.
- Under the track, the **rights block**: licence and link, author, source page; for CC BY tracks
  "Required: put this credit in the post's caption (and the description wherever the video is
  published)" with the credit line and a **Copy the credit** button; for CC0 the courtesy line;
  Content ID "registered" (Kevin MacLeod: a claim can still appear, the credit in the description
  is the answer) or "unknown" with the source's note; generated test audio is marked "never for a
  client's video". A template's music hint (moods and BPM) shows above the library.
- Nothing is scraped and no API is invented: the library's own routes are the only source (no
  Mixkit, no Pixabay). Verified: `tests/video-looks.test.ts` (sources and validation),
  `tests/video-looks-server.test.ts` (a catalog source saved and given back exactly),
  `scripts/video-looks-check.mjs` (the catalog's test loop read through the file route and mixed
  into a render: Opus track, mean −19 dB), `scripts/video-looks-smoke.mjs` (the real UI: list,
  pick, rights block, saved as `catalog` with its rights, read back after a reload).
- Not done: the credit is **not** added to the post's caption automatically (decision 1 below);
  the editor shows it and copies it.

## 7. Decisions for Firas

1. **Where the credit goes.** CC BY tracks need the credit wherever the video is published. The
   suggestion is the post's caption (Instagram) or description (YouTube), added automatically when a
   CC BY track is used; Kevin MacLeod's own Content ID process reads the description, not the video.
   Confirm the placement before the editor adds it.
2. **Kevin MacLeod and Content ID.** His tracks are registered on purpose: a YouTube video using
   them can get a claim that the credit plus a dispute releases. Keep them (good, varied, free) or
   prefer the CC0 tracks for clients who post on YouTube.
3. **A paid library for client work.** For tracks with a written, per-client commercial licence and
   a Content ID whitelist (e.g. Epidemic Sound, Artlist, Musicbed, Envato Elements), a subscription
   would sit under "Paid licence" in the import form. Not researched for price here; nothing bought.
4. **Freesound.** If a free Freesound account is acceptable, an admin can download the CC0 originals
   listed in §3 and import them (the Arabic-flavoured "oud and ney" among them).
