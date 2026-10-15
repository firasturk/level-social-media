# Level Social Media: product specification

## Purpose

An internal studio for Level MENA. The team uploads a client's products or pastes a script, picks
the client's theme and the post format, and receives publish-ready social-media images in the
client's visual identity, reviewed and exported per client.

## Concepts

### Client

A brand Level works for. Has a name, slug, logo, status (active, archived), display order and a
brand kit. Everything else (themes, references, rules, batches, results) belongs to a client.
Client cards replace the approach cards on the left; the selected client persists across reloads
(same as the selected skill today).

### Brand kit

- **Logos**: primary, white, dark (PNG/SVG). Used by the overlay layer only; never sent to the
  engine as something to redraw.
- **Colours**: ordered list of hex values with names (Primary, Secondary, Background, Accent).
  Sent to the brief writer as the palette; used by the overlay for text and shapes.
- **Fonts**: headline and body (Google Fonts name or uploaded .ttf/.woff2). Overlay only.
- **Tone of voice**: short text (e.g. "warm, family, Arabic first, no slang"). Caption writer.
- **Do / don't**: free lines. Added to every brief for this client.
- **Identity references**: photos of the client's past posts and campaigns. Stored in `refs`
  with scope `client:<id>:identity`. "Analyse identity" reads up to 12 of them and writes the
  client's **style text** (photography, light, palette, composition, people, props) with the
  same instruction as `skillBuilderInstruction`, saved on the client. The text is editable.
- **Grid references**: screenshots of the client's feed (3×3 or longer). Scope
  `client:<id>:grid`. Read once for rhythm (how close/wide/graphic posts alternate) and saved
  as the client's **grid rhythm** text.

### Theme

A visual direction inside a client (Ramadan 2027, Summer sale, Minimal white, New arrivals).
Same shape as a skill today: title, caption, description, **direction text** (goal), **library**
(derived scene/pose/light text), reference photos (scope `client:<id>:theme:<themeId>`), example
posts, hidden, favourite, order. "Analyse theme" writes the library from the references. A
client always has a default theme "Brand standard" generated from the identity references.

### Rules

Two Fixed-rules lists, both editable with the existing switch/edit/add/delete/restore editor:

- **House rules** (Level): anatomy, full frame, product fidelity, catalogue-safe wording, no
  readable text drawn by the engine, no competitor logos, one person unless the brief says more.
- **Brand rules** per client: stored in setting `client_rules:<id>`, start empty plus the
  client's do/don't lines.
  Rules are composed into every prompt in the order house → client → theme.

### Post type (replaces "approach" inside a client)

| Post type    | Input                                      | Output                                                                                                                      |
| ------------ | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Product post | product photos (sets per product as today) | one image per product per format, product reproduced exactly, scene from the theme                                          |
| Script post  | script text                                | one image per post the script yields; the visual follows the post's brief, product photos optional as supporting references |
| Grid set     | products and/or script                     | 3, 6, 9 or 12 images planned together as one feed block                                                                     |
| Story        | products or script                         | 9:16 images, headline zone kept clear at the top third                                                                      |
| Carousel     | products or script                         | N slides 4:5 or 1:1, slide 1 is the hook, last slide is the CTA                                                             |

### Script

Pasted text or uploaded .txt/.md/.docx. The text model (Gemini via API key or Vertex, OpenAI
stand-in) splits it into posts. Each post has: title, visual brief (scene, subject, mood, what the
product does in it), caption (in the script's language, in the client's tone, with hashtags
section separate), format suggestion, and which uploaded products it uses (by stem) if any.
The user can edit, delete, reorder and add posts before generating. The plan is saved on the
batch (`config.plan`) and each task stores its post index.

### Format

`1:1` 1080×1080, `4:5` 1080×1350, `9:16` 1080×1920, `16:9` 1920×1080, `2:3` kept for fashion
clients. Engine aspect ratios map 1:1 (Nano Banana supports 1:1, 4:5, 9:16, 16:9, 2:3). Size
1K/2K/4K as today; export fits under 1.9 MB.

### Grid set

A planned block of N images that reads as one feed. The planner (text model) is given the
client's grid rhythm, the theme, the products or posts and N, and returns an ordered list of
slots: `{slot, kind: hero|detail|lifestyle|graphic|quote, product?, brief}` with shared palette
and light notes. Each slot becomes one task. Results show a 3-column grid in posting order
(slot 1 is the latest post, so top-left of the preview is the last to be published; show both
orders with a toggle). Dragging reorders slots; a replaced image keeps its slot.

### Overlay

Optional, rendered in the browser on export and in the preview: headline, sub-line, CTA pill,
logo corner, safe margins per format, Arabic right-to-left aware, brand fonts and colours.
Templates: "Clean" (text bottom-left), "Centered", "Story top", "Price tag". The engine image is
kept untouched underneath; export offers "with overlay" and "image only".

### Captions

One per task, written by the text model from the post brief, in the client's tone and language.
Shown in the review dialog, editable, exported in `captions.csv` (client, theme, post, format,
file, caption, hashtags).

## Screens

1. **Studio** (default): clients column, brand panel, input tab (Products / Script), results.
2. **Brand kit dialog**: logos, colours, fonts, tone, do/don't, identity references with
   "Analyse identity" and the resulting style text, grid references with grid rhythm text.
3. **Theme dialog**: create/edit theme from references (today's SkillDialog).
4. **Rules**: house rules (admin only) and brand rules (per client).
5. **Review dialog**: as today plus caption and overlay preview, revision presets
   ("Blend with scene", "More brand colour", "Cleaner background", "Leave headline space").
6. **Batches**: history filtered by client, spend per client.
7. **Connection**, **Admin**: unchanged.

## Guarantees shown to the user

- Product exactly as uploaded; real faces preserved.
- Every image in the client's palette, light and composition language.
- No text, logos or prices drawn by the engine; all text comes from the overlay.
- Grid sets alternate rhythm and share one palette.
- Random references without repeats inside a batch.
- Export per client, fitted JPGs, ZIP parts under 1.4 GB, captions CSV.
