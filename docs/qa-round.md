# QA round: hands-on test of Level Studio (23 Oct 2026)

Done as a new team member would do real client work: first on the live site
(https://studio.levelmena.com, with a temporary admin account and one test month on Habibah, both
deleted afterwards), then on the preview (https://studio-preview.max-fashion-studio.workers.dev,
branch `qa-round`) with the test client "Sample drinks brand (fictional)". Real campaigns were not
changed and nothing was sent to a client. The preview blocks image and video generation at the
server; nothing mocked is reported as verified live.

Status: **Passed** (done by hand, the result checked where it should appear) · **Failed** (what
happened; fixed items say so) · **Blocked** (why) · **Not tested**.

Browsers: Google Chrome 156 for Linux (H.264 encode and decode, no built-in AAC encoder),
desktop 1440×1000 and phone 390×844 (touch). Safari and iPhone were not available here.

Finding numbers (F1…F31) refer to "Issues found and fixed" below.

## Coverage checklist

### Sign-in, navigation, settings
| Flow | Status | Notes |
| - | - | - |
| Sign in (admin, live + preview) | Passed | |
| Sign in as a member (preview, temporary account) | Passed | Account deleted afterwards. |
| Menu from the workflow stages | Failed → fixed | F1: no way out but "Skip to the Studio". Menu button added. |
| Workflow top bar at 1440 / 1024 / 800 px | Failed → fixed | F16, F30: button clipped, avatar squeezed, pickers collapsed at 1024. |
| Member limits (admin-only tools) | Passed | Freepik, "Edit like this video", clip uploads answer "Admins only" with a plain message; a member sees only their own months. |
| Settings / Admin pages, Connection | Not tested | Out of the time spent on the video project. |

### Create content: the four ways
| Flow | Status | Notes |
| - | - | - |
| Empty month | Failed → fixed | F2: classic "Generate ideas" empty state. Now "Create content". |
| Quick Campaign: brief → draft → apply → Direction → Plan | Passed (fixtures) | Planner answers are the preview's demo fixture (1 post for a 3-post brief): the real planner was not run (billed text call). Stopped at "Save the plan, make nothing" ($0.15 shown). F28, F29. |
| Follow a grid: picker, select, what changes | Passed (fixtures) | Two sample grids; apply not run. |
| Edit images: Drive (live, Habibah, 811 files) | Failed → fixed | F4: 369 clips listed before any picture. Now pictures only. |
| Edit images: big Drive photos (30 MP) on cards | Failed → fixed | F5, F15: "Worker exceeded memory". |
| Edit images: upload, several files, straight to cards | Passed | Live and preview. |
| Create or edit video: upload, Drive, cards | Passed | Six clips → six cards, then combined. |
| Phone clip shape | Failed → fixed | F17: vertical phone clip labelled Landscape. |
| Regenerate ideas keeps the client's own cards | Failed → fixed | F11: they were dropped. |

### Studio cards and editors
| Flow | Status | Notes |
| - | - | - |
| Photo studio: open, Adjust → crop 4:5 → Apply, card updates | Passed (live) | |
| Off-frame pictures on cards | Failed → fixed | F8: silent crop, logo huge over a face. Now shown whole with a Crop chip. |
| Text studio: add text, type, save, refresh | Failed → fixed | F14: new text not typeable. Saved design survives refresh (live). |
| Text studio: client logo as a layer | Failed → fixed | F12. Corner badge still not a layer. |
| Text studio: Escape / "Saved" label | Failed, not fixed | F13 (minor). |
| Card status pill over a top-centre logo | Failed → fixed | F9. |
| "Words & layout" naming | Open | F10: opens the form, not the Text studio. Decision. |
| SVG asset split into layers | Passed (by the svg-layers work, demo asset) | Not re-run on a real Freepik vector. |
| Freepik live search | Not tested | |
| Versions tab, compare | Not tested | |

### Video: generation, audio, versions
| Flow | Status | Notes |
| - | - | - |
| Generate / Enhance (Higgsfield, Magnific) | Blocked | Paid; not approved for this round. |
| Voice-over | Not tested | |
| Music library (catalog track, licence, credit) | Passed | |

### Video editor: one real project end to end (preview, Chrome)
| Step | Status | Notes |
| - | - | - |
| 1 Import footage (6 clips, one phone-vertical) | Passed | |
| 2 Trim, split, reorder, remove a section | Passed | |
| 3 Aspect 4:5, Fit and reframe zoom 1.4× | Passed | Checked in the rendered frames. |
| 4 Text, logo, asset | Failed → fixed | F20: no way to add a library asset. Now "From the asset library". |
| 5 Music, volume, beat sync | Failed → fixed | F21: wrong beat grid (0.36 s on a 128 BPM track). F21b: Align moved nothing on whole clips. Both fixed; 4 of 5 cuts on the beat. |
| 6 Auto edit and a template | Failed → fixed | F22 (weak cut, replaced by the edit-quality planner), F24 (used its own render as footage). Template "Offer / promotion": 9:16, bilingual words, end card. |
| 6b "Edit like this video" | Upload: Passed. Pinterest: Failed (live) | F26: Pinterest fetch found no video on a deleted pin and on a live story pin. |
| 7 Colour preset + reference match | Passed, with a limit | F23: the match turns a white title card grey. |
| 8 Save, close, refresh, reopen | Passed | Several times; cuts, layers, music, colour all came back. |
| 9 Render | Passed | 11 min in this container (software encoder), F27. |
| 10 Same card shows the new version | Passed | "Video · 35.1s · Portrait 4:5 · the client sees this". |
| 11 Client link plays it | Passed | Phone, signed out, autoplay muted; same file (SHA-256 identical). |

Rendered file (`Video 7`, post 7 of Sample drinks · February 2027):
- 1080×1350, H.264 High, 30 fps, 35.07 s; AAC-LC 48 kHz stereo; 6.8 Mbit/s; faststart MP4.
- Cuts at 5.50, 8.93, 15.50, 21.20, 29.10 s: each the first frame at or after the saved cut
  (5.5, 8.92, 15.477, 21.18, 29.08).
- Clip order V1 (speech) · V2 · V5 · V3 · V4 · V6, as on the timeline.
- Text 1–5 s, logo 0–36 s top right, library asset 5–12 s bottom left: seen in the frames.
- Colour Warm Film + reference match at 50 %.
- Sound: the speech clip lines up with its source at 0 ms (correlation 0.994); the music sits at
  0.59× (volume 60 %), 12 ms off its source (under one frame), and fades out over the last second.
- The Studio card, the editor's saved project and the client link all serve this same file.

### Client review link
| Flow | Status | Notes |
| - | - | - |
| Link opens signed out (phone) | Passed | Pictures (live, after F15) and the rendered video (preview). |
| Approve / ask for a change | Not tested | Would send an answer to the team. |

### Autoplay
| Surface | Status | Notes |
| - | - | - |
| Studio cards | Failed → fixed | F25: every card stayed paused after the Video studio closed. |
| Cap of 6, partly visible cards paused | Passed (by design) | |
| Start card for video | Failed → fixed | F3: fake Play button. |
| Client link | Passed | |

### Phone layout (390 px)
| Screen | Status | Notes |
| - | - | - |
| Studio cards | Passed | No sideways scroll. |
| Video studio top bar | Failed → fixed | F30b: buttons overlapped the title, Save squeezed to 14 px. |
| Video studio body | Passed, cramped | The preview is small on a phone. |
| Client link | Passed | |

## Issues found and fixed

| # | What | Fix |
| - | - | - |
| F1 | No menu from the workflow stages | Menu button in the top bar |
| F2 | Empty month showed the classic empty state | "Create content" |
| F3 | Fake Play on the video Start card | Drifting still, no button |
| F4 | Edit images listed 369 Drive clips first (live) | Pictures only, with a note |
| F5, F15 | 30 MP Drive photos broke cards and the client link (live) | Size read before decoding; Drive's own copy used |
| F6 | Captions sent full-size originals | 1080 copy |
| F8 | Off-frame picture cropped silently, logo over a face (live) | Whole picture + Crop chip |
| F9 | Status pill over a top-centre logo | Moved |
| F11 | Regenerate ideas dropped the client's own cards | Kept, ideas numbered after |
| F12 | Template logo not a layer in the Text studio | Logo layer in place |
| F14 | New text not typeable | Opens for typing |
| F16, F30 | Workflow top bar clipped or collapsed | Shrinks, then wraps below 1200 px |
| F17 | Phone clip stored as landscape | Display matrix read |
| F20 | No library asset in the video editor | "From the asset library" |
| F21 | Beat grid wrong on a real track | Tempo by autocorrelation or the library BPM |
| F21b | Align cuts to beats moved nothing on whole clips | Trims back to the beat before |
| F22 | Weak auto edit | New planner (edit-quality work) |
| F24 | Auto edit used its own render as footage | Renders left out |
| F25 | Card previews stayed paused after the studio closed | Re-checked while covered |
| F30b | Video studio top bar overlapped on a phone | Phone rules, short "Render" |
| F31 | Delete forever left version rows behind (live) | Working rows purged; money and delivery records kept |

Regression tests added: thumbs-large, ideas-keep-media, text-logo-layer, mp4-rotation (real
fixtures), beat grid with off-beat hits, align on whole clips, footage without renders,
purge-month. Full suite: 1088 tests.

## Not fixed (decisions or follow-ups)
- F7 "Made" pill on the client's own pictures.
- F10 "Words & layout" opens the form, not the Text studio.
- F13 Text studio: Escape closes without asking; "Saved" label wrong after reopening.
- F18, F19 Editor clip names and colour jargon.
- F21c Projects saved before the beat fix keep their old grid (Remove the track, add it again).
- F23 Reference match on flat graphic clips.
- F26 Pinterest fetch: needs Pinterest's official API (an app and a token) to work reliably.
- F27 Render speed on real hardware unmeasured.
- F28 "Campaign size 12" shown beside a 1-post draft.
- F29 With no product photo, a theme reference is recreated as the picture, while Direction says
  theme references never give their objects.

## Remaining limitations and risks
- Real planner, image and video generation were not run (paid, not approved for this round).
- Safari and iPhone rendering untested here (Firas to test).
- This Chrome has no AAC encoder: the editor's own AAC encoder (WebAssembly) made the sample's
  sound. A browser with built-in AAC takes the other path.
- Auto edit is rules on motion, sharpness, light and beat, not a judgement of the content.
- Nothing on this branch is on the live site yet.
