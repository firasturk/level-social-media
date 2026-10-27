# Claude as the text model (27 Oct 2026)

Connection → Claude takes an Anthropic API key (console.anthropic.com → Get API key). Once it is
saved, every text call the studio makes tries Claude first, then Google, then OpenAI as before:
the plans and ideas, "Do client comments", the captions and headlines, the picture reviews after
each take, the product matches, the Help assistant, the Prompt Box's reading of a sentence, the
editorial prompt builder, exact product mode and the skill builder. Claude never blocks the work:
when it cannot answer (no key, the month's cap, a picture it cannot take, an error), the next
provider answers and the reason is in the Worker log.

## Which Claude

`tierFor(schema)` in `server/anthropic.ts` reads the JSON schema the caller asks for, the same
signal the demo fixture reads:

| Job | Model | Effort |
|---|---|---|
| Plans, ideas, the client's comments, creative direction, the grid read | `claude-opus-5-5` | medium |
| Captions, picture reviews, product matches, palettes, prompts, everything else | `claude-sonnet-5-5` | low |
| The Help assistant, the Prompt Box's reading of a sentence | `claude-haiku-5-5` | low |

Pictures go as base64 blocks before the instruction (JPEG, PNG, GIF, WebP up to 5 MB each; a
larger or other picture goes to the next provider). The system line asks for the JSON alone and
names the schema.

## Spend and the cap

Every answer's tokens are priced (`priceOf`) and added to `anthropic_spend:<YYYY-MM>` in the
settings table (US$, calls, tokens). `GET /api/studio/engine/anthropic` returns the key's source,
the month's spend and the cap; `POST /api/studio/engine/anthropic-cap {usd}` sets the cap
(`anthropic_cap_usd`, US$200 when unset; 0 stops Claude without removing the key). At the cap the
studio stops asking Claude until the month turns.

## Routes

- `POST /api/studio/engine/anthropic-key {key}`: verified against the free models list, then saved
  (`anthropic_api_key`). The `ANTHROPIC_API_KEY` Worker secret wins over the saved key and makes
  this route answer 409.
- `DELETE /api/studio/engine/anthropic-key`.
- Writes are admin-only (the `/engine/*` guard); the status is open to the team.

Tests: `tests/anthropic.test.ts` (the fake API; the guard fails any real call).
