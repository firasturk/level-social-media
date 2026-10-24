# AI influencers (24 Oct 2026)

A client's own AI person, designed in the studio and made once as a Higgsfield character sheet.
Admins only. Where: under the ambassadors (brand panel, and the workflow's Models dialog).

Price: about **1.1 credits** a sheet (Higgsfield's button reads "Generate ✦ 1.125"; first misread as
1,125, so the feature was taken out for an hour and brought back). The account also has free
influencer generations ("Free gens 2 left" on 24 Oct).

1. **Design and price** (free): name, traits (gender, age, origin, skin, build, hair, facial hair,
   style; "Any" leaves it to the description), a hijab for a woman when asked, a few words. The studio
   adds the brief: a real-looking person from Amman, modestly dressed, natural hair colour.
   `ai_influencer_prepare` (randomize false: only the chosen traits) returns the exact params, the
   price and the free generations left; the draft keeps them. Nothing is made.
2. **Make**: either "Make free · N left" (`use_free_gens: true`, `max_credits: 0`, only when
   Higgsfield said some are left, never falling back to credits) or "Make · 1.125 credits" (the
   prepared params unchanged, the quote as `max_credits`). Both ask for the confirm. One claim, a
   ledger row `influencer.sheet`, no retry. The sheet is collected into R2 when the list is read.
3. **Add to ambassadors**: the finished influencer joins the client's ambassadors (its sheet is the
   portrait, modest dress on), so campaigns can cast it.
4. **Trends**: a finished influencer is one of the characters under "Trends with a character"
   (docs/ambassador-trends.md), with its sheet job as the Genjutsu reference (`image_job`).

Table `influencers` (migration 0081). Server `server/influencers.ts`, studio `src/studio/Influencers.tsx`,
traits and brief `shared/influencers.ts`. Tested against a mocked Higgsfield; the prepare answer was
read live (free). No sheet has been made yet.
