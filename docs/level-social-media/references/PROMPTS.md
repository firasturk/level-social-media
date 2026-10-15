# Prompts and rules

All prompt text lives in `shared/` so tests can assert it. Keep the fashion studio's rule
constants; add the social ones beside them. Every prompt is English, catalogue-safe
(`SAFE_WORDING_RULE`), and ends with an AVOID block.

## Composition order of a post prompt (`buildPostPrompt`)

1. Opening line: what the attached images are and which is the source of truth.
   - Product post: "Image 1 is the product. Reproduce it exactly. Image 2 is a style reference:
     take only its place, light, camera and mood."
   - Script post without products: "No product is attached. Create the scene described below."
2. POST BRIEF: the post's visual brief (from the plan) in 3–6 sentences.
3. CLIENT STYLE: the client's style text (photography, palette with hex names, composition,
   people, props) and the theme direction.
4. FORMAT: aspect, where the subject sits, which zone stays clear for the overlay
   ("keep the top third calm and low-detail for a headline" for stories, "keep the lower left
   quarter uncluttered" for the Clean template, nothing when overlay is none).
5. FIXED RULES: composed house → client → theme rules (`composeFixedRules`), each as its own
   paragraph, plus the engine rules already in `shared/prompts.ts` that apply
   (`ANATOMY_RULE`, `FULL_FRAME_RULE`, `SHADOW_RULE`, `RELIGHT_RULE`, `EYES_RULE`, `GRAIN_RULE` when
   the client's rules enable it).
6. AVOID: text, letters, numbers, logos, watermarks, price tags, UI elements, speech bubbles,
   extra limbs, duplicated products, changed product colour or shape, borders or bars, collage.

## New rule constants (`shared/prompts.ts`)

- `NO_TEXT_RULE`: "TEXT: the image contains no letters, numbers, words, logos, labels, stickers,
  price tags, watermarks or user-interface elements, in any language or script. Headlines are
  added later outside the image."
- `HEADLINE_SPACE_RULE(zone)`: keeps a named zone calm and low-contrast.
- `PALETTE_RULE(colours)`: "PALETTE: the scene, props and light sit inside this palette:
  <name hex, …>. The product keeps its own exact colours."
- `ONE_PRODUCT_RULE`: the product appears once, whole, undistorted, label readable only if it is
  readable in the product photo.
- `SOCIAL_FRAME_RULE(format)`: safe margins, subject not touching the edges, no bars.
- `GRID_COHESION_RULE`: shared light, palette and lens feel across a set; alternate distance.

## Fixed rules defaults

**House rules** (setting `house_rules`): product fidelity, identity (real faces), anatomy,
full frame, no text, no logos, catalogue-safe wording, one person unless the brief says more,
palette, integration (shadows, re-light), detail.
**Client rules** (`client_rules:<id>`): start empty; the brand-kit do/don't lines are appended
as rules named `Brand do` / `Brand don't` so they are switchable.

## Script splitting instruction (text model, JSON schema)

Input: script text, client style, tone, language, list of uploaded product stems with short
vision descriptions, requested post count (0 = let the model decide), format.
Output JSON: `{ posts: [{ title, brief, kind, products, caption, hashtags, format }] }`.
Rules in the instruction: one idea per post; the brief describes a photograph (place, subject,
action, light, mood, where the product is and what it does), never a slogan; captions in the
client's language and tone, hook first, CTA last, hashtags separate; no emojis unless the tone
says so; respect posts that the script already numbers.

## Grid planning instruction

Input: client grid rhythm, theme direction, products or posts, N.
Output: `{ slots: [{ slot, kind, product?, brief, light, palette }] }`.
Rules: alternate hero / detail / lifestyle / graphic, never two of the same kind adjacent in a
3-column grid (check neighbours left/right/above), one light family for the whole set, every
product appears at least once before any repeats, slot briefs reference each other's palette.

## Caption instruction

Input: post brief, final image description (vision read of the result), client tone, language.
Output: `{ text, hashtags }`. Arabic captions use Modern Standard Arabic unless the tone says
dialect; English captions sentence case; no claims about price or availability unless the
script states them.

## Revision presets (Review dialog)

- Blend with scene (existing).
- More brand colour: push props, surfaces and light toward the palette; product unchanged.
- Cleaner background: remove clutter and competing objects; keep place and light.
- Leave headline space: re-compose with the named zone calm; subject and product unchanged.
- Swap reference: re-run with the next least-used theme reference.
