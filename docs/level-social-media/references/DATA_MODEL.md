# Data model and API additions

Everything below is additive. Existing tables stay; `refs`, `skills`, `looks`, `settings` are
reused with scope keys. Migrations continue the numbering (`0016_…`).

## New tables

```sql
-- 0016_clients.sql
CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,         -- used in export names, lowercase, a-z0-9-
  name TEXT NOT NULL,
  logo_key TEXT,                     -- R2 key of the primary logo (brand_assets holds the rest)
  colors TEXT NOT NULL DEFAULT '[]', -- JSON [{name, hex}]
  fonts TEXT NOT NULL DEFAULT '{}',  -- JSON {headline, body, files: {headline?: key, body?: key}}
  tone TEXT NOT NULL DEFAULT '',
  dos TEXT NOT NULL DEFAULT '',      -- one line per rule
  donts TEXT NOT NULL DEFAULT '',
  style TEXT NOT NULL DEFAULT '',    -- "Analyse identity" result, editable
  grid_rhythm TEXT NOT NULL DEFAULT '',
  language TEXT NOT NULL DEFAULT 'ar', -- caption language: ar | en | both
  status TEXT NOT NULL DEFAULT 'active', -- active | archived
  position INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS brand_assets (
  id TEXT PRIMARY KEY,
  client TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                -- logo | logo_white | logo_dark | font | example
  key TEXT NOT NULL,
  name TEXT,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS brand_assets_client ON brand_assets(client, kind);

-- 0017_themes.sql  (skills table gains a client column instead of a new table)
ALTER TABLE skills ADD COLUMN client TEXT;          -- null = legacy/global
ALTER TABLE skills ADD COLUMN favourite INTEGER NOT NULL DEFAULT 0;
ALTER TABLE skills ADD COLUMN position INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS skills_client ON skills(client, position);

-- 0018_scripts_posts.sql
ALTER TABLE sources ADD COLUMN kind TEXT NOT NULL DEFAULT 'image'; -- image | script
ALTER TABLE sources ADD COLUMN text TEXT;                          -- script body
ALTER TABLE tasks ADD COLUMN post INTEGER;                         -- index into config.plan
ALTER TABLE tasks ADD COLUMN slot INTEGER;                         -- grid/carousel position
ALTER TABLE tasks ADD COLUMN caption TEXT;                         -- JSON {text, hashtags}
ALTER TABLE tasks ADD COLUMN overlay TEXT;                         -- JSON overlay spec or null
ALTER TABLE batches ADD COLUMN client TEXT;                        -- denormalised from config
CREATE INDEX IF NOT EXISTS batches_client ON batches(client, created);
```

## Reused scope keys

| Store         | Key                                               | Holds                                          |
| ------------- | ------------------------------------------------- | ---------------------------------------------- |
| `refs.skill`  | `client:<id>:identity`                            | identity reference photos                      |
| `refs.skill`  | `client:<id>:grid`                                | feed screenshots                               |
| `refs.skill`  | `client:<id>:theme:<themeId>`                     | theme references                               |
| `refs.skill`  | `client:<id>:products`                            | optional product library reused across batches |
| `settings`    | `house_rules`                                     | house Fixed rules (replaces `direction_rules`) |
| `settings`    | `client_rules:<id>`                               | brand Fixed rules                              |
| `settings`    | `selected_client` (per user, localStorage mirror) | last client                                    |
| `looks.skill` | `<themeId>`                                       | saved post prompts per theme                   |

`parseDirectionRules` / `storeDirectionRules` take the setting key as a parameter; defaults for
`house_rules` are the current `DEFAULT_DIRECTION_RULES` minus outfit/framing fashion-only items
plus `text` (no engine text) and `logos` (no logos drawn). Client defaults are empty.

## Config additions (`shared/config.ts`)

```ts
export const POST_TYPES = ["product", "script", "grid", "story", "carousel"] as const;
export const FORMATS = ["1:1", "4:5", "9:16", "16:9", "2:3"] as const;
export interface Config {
  // existing fields stay (mode kept for compatibility, always "post")
  client: string;
  theme: string; // skills.id
  postType: PostType;
  format: Format; // replaces ratio for new batches; ratio derived
  gridCount?: 3 | 6 | 9 | 12;
  slides?: number; // carousel
  plan?: Post[]; // script / grid plan, edited by the user before Generate
  overlay?: OverlaySpec | null;
  captions: boolean;
}
export interface Post {
  index: number;
  title: string;
  brief: string; // visual brief
  kind?: "hero" | "detail" | "lifestyle" | "graphic" | "quote";
  products: string[]; // source stems used
  caption?: string;
  hashtags?: string;
  format?: Format;
}
export interface OverlaySpec {
  template: "clean" | "centered" | "story-top" | "price-tag" | "none";
  headline?: string;
  subline?: string;
  cta?: string;
  price?: string;
  logo: "primary" | "white" | "dark" | "none";
  corner: "tl" | "tr" | "bl" | "br";
}
```

## API routes (all under `/api/studio`, same auth as today)

| Method         | Route                               | Does                                                                                                       |
| -------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| GET            | `/clients`                          | list with brand kit summary, themes count, spend                                                           |
| POST           | `/clients`                          | create (name, slug)                                                                                        |
| PUT            | `/clients/:id`                      | update brand kit fields (colours, fonts, tone, dos, donts, style, grid_rhythm, language, position, status) |
| DELETE         | `/clients/:id`                      | archive (hard delete only when no batches)                                                                 |
| POST           | `/clients/:id/assets`               | upload logo/font/example (multipart)                                                                       |
| DELETE         | `/clients/:id/assets/:assetId`      | remove                                                                                                     |
| GET            | `/clients/:id/assets/:assetId/file` | serve                                                                                                      |
| POST           | `/clients/:id/analyze-identity`     | vision read of `client:<id>:identity` refs → `style`                                                       |
| POST           | `/clients/:id/analyze-grid`         | read `client:<id>:grid` refs → `grid_rhythm`                                                               |
| GET/PUT/DELETE | `/clients/:id/rules`                | brand Fixed rules (same payload as `/direction-rules`)                                                     |
| GET/PUT/DELETE | `/house-rules`                      | house Fixed rules (admin)                                                                                  |
| GET            | `/clients/:id/themes`               | themes (skills where client = id)                                                                          |
| POST           | `/clients/:id/themes`               | create from references (today's `/skills` body + client)                                                   |
| PUT            | `/themes/:id`                       | edit, hide, favourite, position                                                                            |
| POST           | `/themes/:id/analyze`               | rebuild library from references                                                                            |
| DELETE         | `/themes/:id`                       | delete (restore for built-in "Brand standard")                                                             |
| POST           | `/batch/script`                     | store script text as a `sources` row with kind `script`                                                    |
| POST           | `/batch/plan`                       | text model splits script / plans grid → `config.plan`                                                      |
| PUT            | `/batch/plan`                       | user edits of the plan                                                                                     |
| PUT            | `/tasks/:id/caption`                | edit caption                                                                                               |
| PUT            | `/tasks/:id/overlay`                | edit overlay spec                                                                                          |
| GET            | `/batch/captions.csv`               | export                                                                                                     |

References keep `/references?skill=<scope>` with the new scope keys. `/state` adds `clients`,
`selectedClient`, `themes` (for the selected client), `houseRules`, `clientRules`.

## Engine changes (`server/engine.ts`)

- `planTasks(batch)`: product post → one task per product set per format; script → one task
  per plan post; grid → one task per slot; carousel → one task per slide; story → per product/post.
- Each task's `brief` holds the post or slot brief plus the client style, theme direction and
  composed rules; `prompt` holds the final text sent (as today).
- Reference choice: theme refs via `pickLeastUsed` (no repeats in a batch), identity refs only
  as style context, never as content.
- Image order sent to the engine: product photo(s) first, then one theme reference, then nothing
  else. Logos are never sent.
- Captions are written by the text model after the image is accepted (`ready`/`approved`), one
  call per task, cached on the task.

## Export naming (`shared/naming.ts`)

`<client-slug>_<theme-slug>_<post##>_<format>[_overlay].jpg`, e.g.
`maxfashion_ramadan-2027_post03_4x5.jpg`. Grid sets add `_slot##`; carousels add `_slide##`.
ZIP: `<client-slug>_<theme-slug>_<date>.zip`, parts `-partNofM` as today, `captions.csv` at root.
