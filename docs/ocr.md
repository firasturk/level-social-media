# OCR check of a post's picture (Google Vision)

What is written on a picture, read by Google Cloud Vision and compared with what the post should
say. Two checks share one normalisation of Arabic and numerals:

- **Raw picture** – the engine's output as stored in R2. Nothing may be written on it except the
  product's own packaging print and the brand's name: everything else is unintended writing (the
  engines try to write and produce glyph salad).
- **Final artwork** – the post as it will be published, with the headline, sub-line and price drawn
  by the browser. Every approved word must be there and read as approved; nothing else may appear.

A reading below the confidence floor (0.6) is never acted on by itself: it is handed to a person
("Needs a human look").

No Google credential exists tonight, so the adapter, a deterministic demo provider, the checks,
the storage, the routes, the UI and the tests are built; the live call is the only thing not
exercised. See "Connect tomorrow" at the end.

## Where the text on a picture comes from (investigation)

The question: in the browser test, text was visible on a picture while "Text on image" was enabled.
Does that text come from the image engine or from the overlay?

**Finding: it comes from the overlay, drawn in the browser, by design.** The engine never writes
the headline; the stored picture is text-free (or should be), and the words are painted over it on
a canvas every time a card, the editor, the export or the share link shows the post.

Evidence:

- "Text on image" is the per-post `overlay` flag. The checkbox writes `overlay: undefined` (on) or
  `overlay: false` (off): `src/studio/PlanView.tsx:1218-1222`.
- When it is on (`p.overlay !== false`), the month's cards render `OverlayPreview` instead of the
  plain `<img>`: `src/studio/PlanView.tsx:745-746` and `src/studio/PlanView.tsx:930-934`.
  `OverlayPreview` calls `renderOverlay` (`src/studio/OverlayPreview.tsx:46`), which draws the image
  on a canvas and then `drawOverlay` paints logo, scrim, headline and sub-line over it
  (`src/lib/overlay.ts:846-864`, `src/lib/overlay.ts:105`). The export and the words check do the
  same (`src/studio/Workspace.tsx:1017-1019`, `:1077-1080`, `:1452`).
- The overlay module states the contract: "The engine never draws text; this does."
  (`shared/overlay.ts:4`).
- The engine's prompts forbid writing: the TEXT rule (`shared/posts.ts:303`: "the image contains no
  letters, numbers, words, logos … Headlines, prices and logos are added later outside the image"),
  the AVOID list (`shared/posts.ts:529`), and the planner's framing "no text inside the image;
  headlines are added later as an overlay" (`shared/posts.ts:1046`).
- The server stores only the engine's bytes, never a composite:
  `server/engine.ts:531` (`env.BUCKET.put(key, result.bytes, …)`). The Review dialog's "AI result"
  view shows that stored file through `Zoomable` (`src/studio/ReviewDialog.tsx:622-626`), without
  the overlay, so a text-free picture there with words on the card confirms the overlay origin.
- If the engine does write, the automatic review flags it as kind `text` (`shared/qa.ts:292`,
  "Writing in the picture: …") and the engine makes the post again once (`server/engine.ts:21`,
  `SELF_FIX` includes "text"). The OCR raw check is a second, independent reading of the same file.
- "Your words here" is the Text studio's default layer text (`src/studio/text/TextStudio.tsx:309`
  and `:986`): it appears only when a designer adds a layer there, and like every layer it is drawn
  by the browser, never by the engine.

How to tell in practice, with this feature: run **Check the raw picture** (reads the R2 file) and
**Check the final artwork** (reads the composed PNG). Headline found on the artwork but not on the
raw picture means the words are the overlay, as intended. Words found on the raw picture are the
engine's and are flagged.

## Files

| File | What |
| --- | --- |
| `shared/ocr-check.ts` | Pure: `normaliseText`, `comparable`, `levenshtein`, `similarity`, `compareArtwork`, `checkRawImage`, `looksGarbled`, `ocrFlags`, `isOcrFlag`, types `OcrBlock`, `OcrResult`, `ExpectedText`, `Finding`. |
| `server/ocr.ts` | `OcrProvider`, `GoogleVisionOcr`, `MockOcr` (+ `DEMO_OCR_FIXTURES`, `shortHash`), `resolveOcr(env)`, `mapVisionResponse`, `imageSize`, `storeCheck`, `listChecks`, `ocrReviewFlags` (the engine's extra). |
| `server/ocr-routes.ts` | `ocrRoutes`: `GET /status`, `POST /check`, `GET /checks`. |
| `migrations/0062_ocr_checks.sql` | Table `ocr_checks` with index `(batch, post, created)`. |
| `src/studio/OcrPanel.tsx`, `src/studio/ocr.css` | The panel for the editor's Image group. |
| `tests/ocr.test.ts` | 19 tests, all under the fetch guard. |
| `server/engine.ts` | Three small edits (below). `server/posts.ts`: `ownedPlan` is now exported. |

## Shapes

```ts
interface OcrBlock { text: string; confidence: number; box: [x0, y0, x1, y1] /* 0..1 */ }
interface OcrResult { blocks: OcrBlock[]; language?: string; provider: "google-vision" | "demo" | string }
interface OcrProvider { name: string; detect(image: { bytes: ArrayBuffer; mime: string }): Promise<OcrResult> }

interface ExpectedText { headline?; subline?; price?; numbers?: string[]; allowed?: string[] }
interface Finding {
  kind: "match" | "missing" | "mismatch" | "extra" | "low-confidence";
  field: "headline" | "subline" | "price" | "number" | "text";
  expected?: string; detected?: string; box?: [x0, y0, x1, y1];
  confidence: number; severity: "ok" | "review" | "warn"; note: string;
}
```

`match` (severity `ok`) is one kind more than asked for: the panel's expected-vs-detected table
needs the rows that passed as well as the ones that did not.

Normalisation: Arabic-Indic `٠-٩` and Eastern `۰-۹` → ASCII digits; `٪`→`%`, `٫`→`.`, `٬`/`،`→`,`;
tashkeel U+064B–U+0655 and U+0670 and tatweel U+0640 stripped; `أإآٱ`→`ا`; `ى`→`ي`; `ة`→`ه` with
`{ taMarbuta: true }` (the checks compare with it on); zero-width marks stripped; whitespace
collapsed; Latin lower-cased. A match is a normalised Levenshtein ratio ≥ 0.85, or the expected
words contained in the read run. Headlines that wrapped are found as runs of up to three
consecutive blocks.

## Routes (mount at `/api/studio/ocr`)

- `GET /status` → `{ connected: boolean; provider: string; reason: string }`.
- `POST /check` – JSON or multipart. Fields `batch`, `post` (index), `task?`, `kind: "raw" | "artwork"`,
  `expected?` (JSON `ExpectedText`; in multipart a JSON string). `raw` reads the task's `tasks.output`
  from R2 (the post's latest picture when `task` is omitted). `artwork` takes the composed PNG as
  the `file` field (or a base64 `image` data URL in JSON) because the words are drawn client-side;
  `expected` defaults to the plan's headline, sub-line and offer price. The allowed words are the
  post's product names and the client's name. Answer:
  `{ check, findings, connected, provider, reason }` where `check` is the stored row (parsed).
- `GET /checks?batch&post` → `{ checks: OcrCheck[] }`, newest first, 50 at most.

Authorisation: `ownedPlan` from `server/posts.ts` (a member's own months; an admin opens every one).

With no credential every answer carries `connected: false, provider: "demo"`; the panel then says
"Not connected · demo result".

### Mount

In `server/studio.ts`, next to the other routers:

```ts
import { ocrRoutes } from "./ocr-routes";
studioRoutes.route("/ocr", ocrRoutes);
```

### The panel

```tsx
import OcrPanel from "./OcrPanel";

<OcrPanel
  batchId={batch.id}
  post={editorPost.index}
  task={t?.id}
  imageUrl={outputUrl(t)}
  expected={{ headline: editorPost.headline, subline: editorPost.subline, price: editorPost.offer?.price }}
  composeArtwork={async () => {
    const canvas = await renderOverlay(outputUrl(t), overlaySpec, { headline: editorPost.headline, subline: editorPost.subline }, editorPost.overlay === false ? null : logoSrc, 1080, { patch: editorPost.ov, faces: facesOf(t.qa) });
    // A PNG keeps the letters crisp for OCR (canvasBlob in src/lib/overlay.ts makes a JPEG).
    return new Promise<Blob>((ok, no) => canvas.toBlob((b) => (b ? ok(b) : no(new Error("The artwork could not be drawn."))), "image/png"));
  }}
/>
```

## The engine's extra

`server/engine.ts`:

- lines 21–29: `selfFixable(qa)` (exported) filters the automated review's flags to `SELF_FIX` kinds
  **and excludes OCR flags** (`isOcrFlag`); imports of `ocrReviewFlags`, `isOcrFlag`, `PostFlag`.
- line 596: `const fixable = selfFixable(qa);` (was the inline filter).
- line 615: `qa = await ocrReviewFlags(env, batch, task, qa, result, [product names]);` placed after
  both retake decisions (idea drift, self-fix) and before the final status update, so an OCR flag
  can never queue a take; a retaken picture is not read at all.

`ocrReviewFlags` does nothing when OCR is not connected (no demo flags in production data), never
throws, stores an `ocr_checks` row of kind `raw`, and adds at most two `text` flags:
`Writing in the picture (OCR): "…"` for clear readings and
`Check the writing (low OCR confidence): "…" may be writing; a human should look.` for faint ones.
The flags are not fed to the lessons (the vision review's are): packaging print read as "extra"
would otherwise become a rule.

## Limitations

- The live Vision call has not run: the request shape and the response mapping are tested against
  a stub; the first real response may need a tweak (e.g. `confidence` missing on paragraphs is
  averaged from words, else 0.8).
- The raw check cannot know what is printed on the packaging; it allows the product names and the
  client's name, so a packaging line like "Since 1951" reads as extra writing (a review note, not a
  retake). `expected.allowed` on the artwork route is the place to add packaging words.
- Low confidence is the provider's own figure; the `textAnnotations` fallback carries none.
- The panel keeps the last raw check on reopen; an artwork check is shown only in the session that
  uploaded it (its bytes are not stored).
- `MockOcr` answers only from `DEMO_OCR_FIXTURES`; in demo mode the UI will mostly say "No writing
  was read" unless a fixture is registered for the picture's `shortHash`.
- Vision is billed per image (first 1,000 units a month free, then about $1.50 per 1,000 for
  DOCUMENT_TEXT_DETECTION). The engine's extra runs once per stored picture when connected.

## Connect tomorrow

1. Google Cloud console → the project of the Vertex service account (or the AI Studio key's project)
   → APIs & Services → enable **Cloud Vision API**.
2. Credential: either the saved Google key (`google_api_key` setting / `GEMINI_API_KEY`) – an AI
   Studio key works for Vision only if its project has Vision enabled and the key is unrestricted
   or allows the Vision API – or the saved Vertex service account (`vertex_service_account`), which
   needs the role **Cloud Vision API User** (or `serviceusage.services.use` + Vision access). The
   adapter sends `x-goog-user-project: <projectId>` with the service-account token.
3. Billing must be on for the project; keep an eye on the Vision quota page after the first month.
4. Then: `GET /api/studio/ocr/status` should answer `connected: true`; run "Check the raw picture" on
   a post with a known word in the frame and compare the boxes with the picture.
