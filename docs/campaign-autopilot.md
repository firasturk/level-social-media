# Campaign Autopilot

Quick Campaign, extended for admins: ask for a whole campaign (for example 3 image posts and 4
multishot Reels), review the plan, its products, references, storyboards and production cost, then
approve it and let the studio produce it. Admin-only while it is tested.

Everything reuses what exists: the month's plan and Studio cards, the image engine and its spend
ledger (`generateRun`, `server/spend.ts`), the AI tools jobs (`photo_tool_jobs`), the video clips
(`videos`, Higgsfield Cloud or subscription credits), the video editor's projects and render jobs
(`video_projects`, `video_renders`), the music library and the brand kit.

## The parts

| Part | Where | What |
| --- | --- | --- |
| The plan, counts, costs, approval | `shared/campaign-plan.ts` | Types, normalising, the steps a plan needs, counts, cost lines per provider and unit, the cap with its retry allowance, the approval signature and what an edit changes. Pure, tested. |
| The assembled Reel | `shared/campaign-assemble.ts` | A finished video's shots (clips and stills), words, logo, look, music and transitions become an ordinary editable `VideoProject`. Pure, tested. |
| Server | `server/campaign.ts`, migration `0078_campaign_autopilot.sql` | Plans (`campaign_plans`) and their production steps (`campaign_steps`); routes; the runner. |
| Browser render | `src/video-editor/headless-render.ts` | Renders a saved project revision with the editor's own engine and stores it on the card, from the campaign page. |
| Screen | `src/studio/campaign/` | Setup, plan review and editing, costs and approval, production progress. Opened from Quick Campaign (admins). |

## Costs, honestly

- Units are never added together: dollars (the image engines' list prices, `shared/pricing.ts`),
  Higgsfield credits (the subscription, asked with `get_cost`, free) or Higgsfield Cloud dollars
  (catalog, the admin's price setting, or the provider's estimate endpoint), Magnific credits
  (`simulate_cost`, free).
- A step whose cost cannot be established is flagged before approval; the plan cannot be approved
  with an unknown step selected unless the admin accepts that step explicitly.
- The cap per unit is the estimate times (1 + retries per step); the retry allowance is shown.
- Outside the cap, listed: the planning text calls (billed by the text provider), reference reads,
  music (licensed library, free), the render (in the browser, free), Drive copies (free).

## Approval

Approval is tied to the plan revision, the selected items, their products, references, engines
and the caps (`approvalSignature`). Approval creates the steps and approves each unit's cap into
the campaign's ledger scopes (`campaign:<id>:<unit>`); every paid step reserves its estimate there
before its request (one conditional update, so nothing is spent twice), and a step that does not
fit pauses the campaign ("the approved allowance is not enough"). A material edit after approval
(product, reference, engine, idea, shot, duration) pauses the affected item's unfinished steps
until the item is approved again; a words-only edit (headline, caption, on-screen text) is applied
without a new approval. Engines and quality are never switched silently.

## Production

Steps, each idempotent (unique per plan, item, shot and kind; a step moves `ready → running` with
one conditional update):

1. `post`: the item's card in the month (an image post, or the Reel's card) with its idea, words
   and product.
2. `image`: an image post's picture, or a Reel's key frame (the card picture), through the image
   engine (`generateRun`).
3. `frame`: another shot's starting image, made from the key frame with Magnific "Change camera"
   (the same scene from another angle) so the product and the scene carry over.
4. `review`: the admin looks at the Reel's starting pictures, in shot order, and approves them
   ("Approve shots & make the videos"); no clip of that Reel is made before. "Make again" re-makes
   one picture (a new key frame re-makes its other angles too; another angle may be picked), each
   confirmed at its estimate first.
5. `clip`: one shot's video from its starting image (Higgsfield).
6. `assemble`: the Reel's editable project from its finished shots.
7. `render`: the project rendered in the browser (the campaign page renders while it is open) and
   stored on the Reel's card as a new version.

The assembled Reel (`assembleReel`) is an ordinary editor project: each shot a version of the
Reel's post trimmed to its planned seconds (a generated clip from 0.2 s in, the client's clip from
its middle, a shorter clip used whole), the joins asked for, the frame's output size, the look at
80 %, the shot's words, the hook over the first shot, the call to action and the logo on the end
card (the last shot), the music library track with the clips muted and, when its BPM is known,
every cut moved to the nearest beat (the grid counted from the track's start), and an `edit`
summary. A photo shot is a gap of its length until the render: `renderProjectToCard` with
`stills` (from `stillShots`) draws each photo as a clip at the Reel's size in the browser
(`stillToClip`, as "Combine into one video" does), stores it as a version of the post, puts it in
the gap, saves the project and renders that revision.

Existing media (a Drive clip or photo) is used as it is. A failed step keeps everything that
succeeded and is retried alone, within its attempts. Completion means ready for review: nothing is
approved for the client, shared or published by the autopilot.

## Preview

The preview (pictures switched off) runs production in a simulated mode: no provider is called;
each step takes the month's existing demo pictures and clips, labelled "simulated", so the whole
flow (approval, steps, assembly, the browser render, the card) can be walked without spending.

## Implementation checklist (October 2026)

What is built, and how far each part has been proven. "Mocked" means the provider was replaced
at the studio's own tool function in a test; "simulated" means the preview's no-provider mode;
"live" means a real provider answered. Nothing here has been run against a paid provider.

| Requirement | Built | Tested with fixtures / mocks | Needs a live test |
| --- | --- | --- | --- |
| Setup: objective, audience, offer, message, counts, platforms, formats, length, period, language, products (month + Drive, manual or suggested), direction, references | yes (`src/studio/campaign/`, `normalizeSetup`) | preview walk; `tests/campaign-autopilot.test.ts` | the planner with a real text key (Google or OpenAI) |
| Plan: summary, per post (idea, objective, real product thumbnail, visual, labelled reference, words, engine, cost), per Reel (concept, hook, product, length, frame, ordered storyboard with seconds, action, framing, camera, source, reference, on-screen text, voiceover, music, transitions, engines, cost per step) | yes | 3 posts + 4 Reels: 16 shots, clips, starting images and key frames counted (`tests/campaign-plan.test.ts`, autopilot tests); preview walk | quality of a real planner's ideas |
| Labels: reference vs client asset vs generated preview; no inspiration shown as the result | yes (`PlanRef.kind`, badges) | preview walk | — |
| Nothing paid before approval; billable planning said apart | yes | paid guard: no network call before approval; no tasks, clips or ledger rows | — |
| Editable plan: idea, product, reference, shot (add, delete, reorder, length, source, asset), engine; regenerate one item or one shot | yes (`PUT /plan`, `/regenerate`) | edit tests (words vs material, stale page refused) | regenerate with a real text key |
| Totals and costs: posts, videos, shots, starting images, other assets; per provider and unit, never added together; caps with retry allowance; outside the cap listed; unknown costs flagged and accepted only at a stated amount | yes (`planCosts`, `budgetCaps`, `proposalFor`) | unit tests; preview walk (dollars and Magnific credits apart) | Higgsfield `get_cost` and Magnific `simulate_cost` answers (free questions) once signed in |
| Approval: all or selected, tied to revision, items, products, references, engines and caps; duplicate presses do nothing; material edit pauses that item until approved again; words-only edits apply at once | yes (`approvalSignature`, `stepSignature`) | stale and duplicate approvals, material edit re-making only the changed shot | — |
| Budget: reserve before each request in the campaign's scope per unit; retries capped; pause when the allowance is short; reported costs settle the reservation | yes (`campaign:<id>:<unit>` scopes) | budget stop and resume; reservations made before every mocked call; Magnific reported credits settle | real balances moving as reported |
| No silent switch of engine, billing or quality | yes | month engine changed → pauses; Higgsfield billing changed → pauses | — |
| Production: cards, post pictures and key frames (image engine), other angles (Magnific Change camera), clips from each shot's own starting picture (Higgsfield), client media used as is, assembly (shots, words, logo, look, licensed music, beat-snapped cuts, transitions), browser render onto the card | yes | `tests/campaign-live-path.test.ts` (tools mocked: 7 pictures, 12 angles, 16 clips, each clip's start picture checked); preview: whole campaign simulated and 4 Reels rendered in the browser onto cards | one real run of each provider step (a small campaign: 1 post + 1 Reel of 2 shots) |
| Failure recovery: a failed step retried alone, finished work kept | yes | retry test (others' outputs and attempts unchanged); extra attempt needs explicit approval | a real provider failure |
| Editable afterwards: cards open in the existing editors; Reels keep an editable project (timeline, shots, text, music, colour); renders add versions, earlier ones recoverable; done = ready for review, nothing sent or published | yes | projects validated; render step stores a version on the card | — |
| Admin-only | yes (routes and entry) | member refused | — |

### Connections needed for a live run

- A text key (Google or OpenAI) under Connection: the planner and "Regenerate".
- The image engine of the month (already connected on production).
- Higgsfield: either the subscription sign-in (credits; `get_cost` estimates) or the Cloud API key
  with a price per clip set under Connection → Higgsfield (the docs publish none), matching the
  billing chosen there.
- Magnific sign-in (Change camera for the other angles; `simulate_cost` estimates).
- The client's Drive folders (products, photos and clips used as they are), already read through the
  service account.
- A music library track (catalog or the client's own, rights confirmed) for the Reels' music.

## Photographic direction (24 Oct)

Each Reel is directed as one filmed commercial before anything is paid:

- **The Reel's direction** (`VideoPlanItem.direction`): look, light (source, direction, softness, contrast, colour temperature), colour (a film-inspired grade with natural skin and exact product colours), lenses, wardrobe and props, place and continuity. The planner writes it as a commercial cinematographer; the admin edits it on the plan.
- **Each shot's camera setup**: shot size, angle (camera height), lens look with distance and depth of field, composition (placement, foreground and background), movement, and speed (real time unless slow motion serves the idea).
- **References by role**: a colour reference lends only its palette and light, a composition reference only its framing and perspective; neither ever replaces the product, which always comes from its own photo.
- **Where it goes**: the key frame's brief, each shot's own picture (with the key frame, the product photo, the cast's portraits, a real photo for realism and the labelled references), and each clip's prompt. Higgsfield gets the approved picture as its start frame and, where the engine's catalog lists `image_references` (Seedance 2.5 does), the product photo and the portraits as references. Lens, angle, movement and grade are said in the prompt: the engines in use expose no lens setting through the connection, and the plan says so instead of claiming one.
- **Before any clip**: the automatic check compares each shot's picture with the product photo, the portraits and the key frame (continuity of light, grade, wardrobe, place) and flags a generated look; the admin approves the shots.

## Ideas first, real places, the angle library (24 Oct)

Seen live on Abu Saleh: every winter picture sat on a teal or brown studio backdrop, at eye level, centred. The brand's stored style (written from its summer feed) described a studio, the planner copied it into the Reel's place, and every shot was repainted from that studio key frame.

- **Ideas first.** The planner decides, before any look, a different idea per post and per Reel: a real moment from the audience's life in a real place (`setting` on image posts, `direction.place` on Reels), a **hook move** for a Reel's first second (the action, apart from the hook words) and a **format**: `tv-spot` (a polished commercial on location) or `ugc` (phone-shot creator footage). Two or more Reels use both formats.
- **The brand style lends palette, energy and finish only** (`STYLE_SCOPE_RULE`): its studio backgrounds never become a place unless the setup's direction asks for a studio by name. A post set on location (`Post.onLocation`) gets the client style labelled that way in its picture prompt.
- **Angle library** (`shared/angle-library.ts`): sixteen composition plates (a plain unbranded white cup in real places), stored in R2 under `library/angles/<id>.jpg` and `<id>-bw.jpg`. The planner names one per image post and per shot (`angleId`). The shot picture gets the black-and-white plate as a composition reference (camera height, angle, distance and framing only); an image post or a Reel's key frame gets it as the card's reference picture, copied into the month and labelled "composition only". The plan screen shows the plate and a picker (`GET /api/studio/campaigns/angles/:id`).
- **Variety rules**, said as planning notes when broken (`varietyNotes`): no two pieces in the same place, no studio unless asked, no repeated camera position in a Reel, at least two distances in a Reel of three shots or more, at most one plain eye-level shot, and not every Reel in the same format.
- **Continuity without a backdrop.** A shot keeps the key frame's people, wardrobe, light, time of day and grade; its place is its own spot in the same world. The automatic check no longer flags another spot of the same street or car, and now flags a studio look, other businesses' signs and car badges.
- **Register.** `ugc` Reels ask for phone footage (handheld, deep focus, available light or a phone flash, phone grain) in the picture and the clip, with a slight micro-shake on the movement; `tv-spot` asks for motivated practical light and composed frames on location. The hook move goes to the first shot's clip.

## Reels from Higgsfield templates (24 Oct)

Not every Reel is lifestyle. Next to `tv-spot` and `ugc`, a Reel's format can be `template`: one of nine Higgsfield Marketing Studio templates Firas chose (`shared/creative-templates.ts`), each described from its preview so the planner can match its mechanic to an idea: TV Spot, three Wild Cards (giant jelly kick, delivery skit, giant wave chase), Reboxing, Giant Figure, Chili Burst, Candy Color Swap and Pixel Block Yard.

- **Planning.** The planner gets the list (what happens, best for, people, length, what to adapt for this audience) and, with two or more Reels, uses at least two formats. A template Reel carries `template: { id, brief }`: the brief tells the template what to make for this brand (the product exactly as its note says, a place in the brand's city, the cast or no one, the ingredients and colours). It has one shot of the template's length; an unknown template id falls back to a filmed Reel, and the plan says so.
- **Steps.** Card, one clip, assembly, render: no key frame, no shot pictures, no picture review. The clip runs `marketing_studio_v2_video` with the template's type and preset id on the Higgsfield subscription credits, the product's photo as its input (`input_images`) and the brief with the brand's rules (`templatePrompt`). The card shows the product's photo until the Reel is rendered; the editor adds the words, logo and music as for any Reel.
- **Price.** From the library (Higgsfield's own figure per template, asked on 24 Oct: 70 to 84 credits); a template without a recorded price is an unknown cost the admin accepts at an amount. Pricing never calls Higgsfield for a template.
- **Plan screen.** Format → "Higgsfield template" shows the template's preview video, a picker and the brief.

Also fixed: a clip's price key ends with its frame (`9:16`), and the price book read the frame's first number as the clip's length (a 5-second clip was priced as 9 seconds). The key is now read from the end.
