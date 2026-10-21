# Releasing the four-stage workflow (branches phase-0-safety and phase-1-workflow)

Nothing in this file runs by itself. Each step is done by a person, in this order, on a quiet day.

## 0. What is being released

- `phase-0-safety` (12 commits): the spend ledger, bounded retries, the paid paths covered, mocked engine tests.
- `phase-1-workflow` (contains phase-0-safety, 24 commits ahead of main): lineage, the plan preview, the four-stage
  workflow, Quick Campaign, the post editor, the compact cards, dictation, takes, the reading before paying, the
  Plan's tools, Autopilot on the plan, the test harness.
- `git merge-tree` of main and phase-1-workflow shows no conflicts (checked 21 October).
- Merging to main deploys nothing: `.github/workflows/ci.yml` runs typecheck, lint, tests and build only.

## 1. Before merging

1. The final hands-on review on the preview is done and its findings are fixed on the branch.
2. The real-picture test (section 4) is done and its pictures were judged as good as before.
3. `npm run typecheck && npx eslint . && npx vitest run && npm run build` are clean on the branch head.

## 2. Merge

```
git checkout main && git pull
git merge --no-ff phase-1-workflow      # brings phase-0-safety with it
git push origin main
```

## 3. Production (manual, by hand, in this order)

1. Migrations, additive only (new tables and nullable columns; the old code reads missing values as before):
   `0053_spend_ledger`, `0054_task_lineage`, `0055_spend_reconciliation`, `0056_grid_reads`, `0057_post_takes`,
   `0058_plan_preflights`.
   `npx wrangler d1 migrations apply DB --remote` (production config `wrangler.jsonc`).
2. Deploy: `pnpm run deploy` (vite build, embed assets, `wrangler deploy --config wrangler.deploy.json`).
3. Flags, in Admin, after the deploy:
   - "Four-stage workflow": OFF at first. Everyone keeps the journey; the new server code (ledger, lineage,
     takes, preview) is live underneath and changes nothing visible.
   - Turn it ON for the team when the admins have used it on one real month.
   - "Autopilot reviews before paying": ON recommended.
   - "Ask before spending more than ($)": keep the current value.
4. Budget: the first Generate on each existing month approves its budget; months in flight keep running.

## 4. The real-picture test (before the merge, a separately approved budget)

The preview worker never makes pictures (`PREVIEW_NO_IMAGES=1`). For the test, a copy of the preview config without
that variable is deployed to the same preview worker, a Google (or OpenAI) key is pasted in Connection by an admin
(never copied from production), and one small month is made with each of the four ways. Budget to approve: about
$2 (six pictures at about $0.13 plus retakes). What to judge: the pictures look as good as the current production
ones, the prompts in "Prompt used" read the same as before, the review flags behave, Previous picture and the
takes list fill. Afterwards the variable is put back and the key removed.

## 5. Rollback

- Flag off: the journey is back for everyone; the data stays valid for both paths.
- Code: redeploy the previous build (`git checkout <previous main> && pnpm run deploy`). The new tables are left
  in place and ignored.

## 6. Left for separate changes (not in this release)

- Retiring the classic journey (kept behind "Classic journey" until sign-off).
- Pricing and budget details admin-only (not decided).
- Security findings from the audit: members can edit every client, theme, ambassador, Drive link, lessons and
  library styles; share links never expire; no per-client isolation for members. The narrow fix for engine keys
  and lesson deletion is in phase 0 already.
