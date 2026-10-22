#!/usr/bin/env node
/**
 * `npm run eval`            the deterministic suite (eval/promptfooconfig.yaml): no network, no key.
 * `npm run eval:update`     the same, rewriting eval/snapshots/*.txt (an intended prompt change).
 * `npm run eval:paid`       the opt-in paid suite (eval/promptfooconfig.paid.yaml): needs a key.
 *
 * Telemetry, update checks, sharing and the local results database are off, so the deterministic
 * run stays offline and leaves nothing behind but eval/results.json (git-ignored).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = new Set(process.argv.slice(2));
const paid = args.has("--paid");
const update = args.has("--update-snapshots");

if (paid && !process.env.OPENAI_API_KEY) {
  console.error("eval:paid needs OPENAI_API_KEY (or another provider key; see eval/promptfooconfig.paid.yaml). Nothing was sent.");
  process.exit(2);
}

const require = createRequire(import.meta.url);
// promptfoo's main export is dist/src/index.js; the CLI lives next to it.
const entrypoint = join(dirname(require.resolve("promptfoo")), "entrypoint.js");
const config = join(here, paid ? "promptfooconfig.paid.yaml" : "promptfooconfig.yaml");

const results = join(here, "results.json");
const r = spawnSync(
  process.execPath,
  [entrypoint, "eval", "-c", config, "--no-cache", "--no-write", "--no-share", "--no-progress-bar", "--no-table", "--output", results, ...(args.has("--verbose") ? ["--verbose"] : [])],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      PROMPTFOO_DISABLE_TELEMETRY: "1",
      PROMPTFOO_DISABLE_UPDATE: "1",
      PROMPTFOO_DISABLE_SHARING: "1",
      PROMPTFOO_DISABLE_ERROR_LOG: "1",
      ...(update ? { UPDATE_SNAPSHOTS: "1" } : {}),
    },
  },
);

// One line per case, with the reason of every failed assertion: the table is too wide to read.
try {
  const rows = JSON.parse(readFileSync(results, "utf8")).results?.results ?? [];
  for (const x of rows) {
    const reasons = (x.gradingResult?.componentResults ?? []).filter((c) => !c.pass).map((c) => c.reason);
    console.log(`${x.success ? "  ok " : " FAIL"}  ${x.testCase?.description ?? "?"}${reasons.length ? `\n        ${reasons.join("\n        ")}` : x.error ? `\n        ${x.error}` : ""}`);
  }
  console.log(`\n${rows.filter((x) => x.success).length}/${rows.length} cases passed`);
} catch (e) {
  console.error("could not read", results, e instanceof Error ? e.message : String(e));
}
process.exit(r.status ?? 1);
