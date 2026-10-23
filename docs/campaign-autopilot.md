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
4. `clip`: one shot's video from its starting image (Higgsfield).
5. `assemble`: the Reel's editable project from its finished shots.
6. `render`: the project rendered in the browser (the campaign page renders while it is open) and
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
