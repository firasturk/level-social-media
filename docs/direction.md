# Direction: models and colours

What the Direction board of the four-stage workflow gained after Firas's review of the new journey
against the classic one, and the fix to the Drive picker's tiles.

## Models

- A **Models** row sits among the supporting inputs (after the product images): the month's cast as
  chips with their portraits, a line saying what the cast does, and **Choose models / Change models /
  Add a model**.
- The button opens the classic journey's ambassadors step in a dialog ("Models for October 2026"):
  the client's roster, **+ Ambassador** to add one (name, man or woman, modest clothing, hijab, look,
  portrait by upload or generation), **In this month** on up to three, remove. The same component
  (`src/studio/Ambassadors.tsx`) and the same routes (`/api/studio/ambassadors`, the cast through
  `PUT /api/studio/posts/settings` with `ambassadors`, saved as `config.ambassadors`), so the classic
  journey and the brand kit see the same choice.
- The Plan summary has a **Models** cell (the cast with portraits, how many posts name them), and
  each post row on the Plan shows its people (`post.people`) as chips with "+ model" to cast one of
  the month's models on that post, as the Studio's plan already allowed.

## Colours

- The theme palette is no longer a source. The Colours card is an explicit choice of four:
  **Client's brand colours** (the brand kit's `client.colors`), **The followed grid's colours** (read
  from the grid picture: the hexes the grid reading wrote for plain tile backgrounds and lettering,
  then its world paragraph, each once), **Both** (brand first, then the grid's, deduplicated) and
  **Set by you** (the manual editor). Each option shows its swatches before it is chosen.
- Default: the brand colours; when the brand kit has none and a grid is followed, the grid's.
  Choosing a source saves at once (`POST /api/studio/posts/palette` with `from`), as
  `config.palette` + `config.paletteFrom` (`"brand" | "grid" | "both" | "manual"`); the prompts keep
  reading `config.palette`. A grid not read yet shows "Read the grid first" with the button; the
  choice is saved when the reading arrives.
- A month saved before this on a theme palette keeps its colours, labelled **from an older theme (no
  longer offered)**, until a source is chosen. Older `paletteFrom` markers (`brief`, `designer`)
  read as set by hand ("set by the brief" / "set by you").
- The "Also update the theme (N months follow it)" write-through is gone from the card and from the
  route: a month's colours never change a theme any more.
- Pure logic in `shared/palette-source.ts` (tests in `tests/palette-source.test.ts`).

## Drive picker tiles

- Cause of the strip tiles on Safari: each tile was a `flex-direction: column` button whose `<img>`
  relied on `width: 100%; aspect-ratio: 1` for its height. WebKit sizes a replaced flex item in a
  column from the image's intrinsic height, not the transferred aspect ratio, so before the Drive
  rendition loaded (and for a rendition that failed) the image was 0 px tall and the tile was its
  two caption lines; the placeholder `div` with `aspect-ratio: 1` collapsed the same way.
- Fix: each tile is now a three-row grid (`.drive-thumb`) with a square frame of its own
  (`.drive-thumb-pic`, `aspect-ratio: 1 / 1` on a block with a minimum height) and the image
  absolutely positioned inside it with `object-fit: cover`; the missing-photo placeholder uses the
  same frame. The kind label keeps a minimum height so it is always visible.
- Counts: the tab counts the photos Drive gives today (67); the photos it no longer gives (119) are
  in a quieter note under the grid, "67 photos in Drive · +119 no longer in Drive (deleted, in the
  bin, moved or unshared), kept for the months that used them", never in the tab.
- The grid scrolls inside the dialog (its own `overflow-y`), with the tabs above and the actions below
  in view at 1440 and 390.

## Verified

`scripts/direction-smoke.mjs` (boot mock, headless Chromium, zero calls outside the mock server):
the Direction board with the Models row and chips, the picker with the roster and its add button, the
cast saved through the settings route, the four colour sources with swatches (brand 2, grid 3, both
4), the save carrying `from: "both"` with no theme field, the manual editor without a theme
checkbox, the Drive grid with square tiles for photos and placeholders, the tab count 67 and the
"+119" note, the grid scrolling inside the dialog, and the 390 px layout without a sideways scroll.
Screenshots at 1440 and 390 in `--out`.
