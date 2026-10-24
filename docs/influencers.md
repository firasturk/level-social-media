# AI influencers (24 Oct 2026)

A client's own AI person, designed in the studio and made once as a Higgsfield character sheet, then
put into trend videos. Admins only, on the Higgsfield subscription credits. Where: the brand panel's
"Brand ambassadors" section and the workflow's Models dialog, under the ambassadors.

1. **Design and price** (free): name, traits (gender, age, origin, skin, build, hair, facial hair,
   style; anything left on "Any" is Higgsfield's choice), a hijab for a woman when asked, a few words.
   The studio adds the brief: a real-looking person from Amman, modestly dressed. `ai_influencer_prepare`
   returns the exact params and the price; the draft keeps them. Nothing is made.
2. **Make** (paid): the confirm shows the quote; `ai_influencer_generate` gets the prepared params
   unchanged and the quote as `max_credits`. One claim, a ledger row `influencer.sheet`, no retry.
   The sheet is collected into R2 (`influencers/<client>/<id>.png`) when the list is read.
3. **Add to ambassadors**: the finished influencer joins the client's ambassadors (its sheet is the
   portrait, modest dress on), so campaigns can cast it.
4. **Make a trend** (paid): the Genjutsu galleries (Trending, New, By Higgsfield) opened with the
   character (`initial_inputs.character_sheet = [{id: <sheet job>, type: "image_job"}]`); the chosen
   preset's price and readiness come from its detail with the same character; after the confirm,
   `execute_preset {source: "genjutsu", preset_id, inputs: {character_sheet: [...]}}` once (the input
   name is read from the preset's schema when it differs). The video is collected into R2 and can be
   downloaded. Ledger row `influencer.trend`.

Tables: `influencers`, `influencer_trends` (migration 0079). Server: `server/influencers.ts`; studio:
`src/studio/Influencers.tsx`; traits and brief: `shared/influencers.ts`.

Verified against a mocked Higgsfield (tests/influencers.test.ts). Live: the prepare, the trait list
and the trend gallery's shape were read on 24 Oct; no sheet or trend has been made yet (paid).
