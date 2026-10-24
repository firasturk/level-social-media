# Trends with a character (24 Oct 2026)

A character for a trend is one of three: an ambassador with a portrait (uploaded in the brand kit),
an AI influencer made for the client (docs/influencers.md; its sheet job is the native Genjutsu
reference), or one of the Soul characters already made on the Higgsfield account (Elegant Enigma,
Chill Heart Cheer, Ethereal Lace Whisper on 24 Oct; read with `show_characters`, Soul 2 first, one per
name). Pictures are imported as `media_input`; an influencer goes as `image_job`.

Where: under the ambassadors (brand panel, and the workflow's Models dialog). Admins only.

1. Pick a character. Its picture is imported to Higgsfield (`media_import_url`, free).
2. The Genjutsu gallery (Trending, New, By Higgsfield) opens with the character as the reference
   (`initial_inputs.character_sheet = [{id: <media id>, type: "media_input"}]`). Browsing only.
3. Use this: the preset's detail with the same character gives the price and readiness; the confirm
   shows the price; then `execute_preset {source: "genjutsu", preset_id, inputs: {character_sheet}}`
   once. One claim, a ledger row `trend.video`, no retry.
4. The video is collected into R2 (`trends/<client>/<id>.mp4`) when the list is read; Download.

Table `ambassador_trends` (migration 0080, which dropped the first influencer tables; 0081 brings `influencers` back).
Server `server/ambassador-trends.ts`, studio `src/studio/AmbassadorTrends.tsx`. Tested against a mocked
Higgsfield; no trend has been made live yet (paid).
