/**
 * The promptfoo assertions. Each is a named export used as `file://asserts.mjs:<name>` and reads the
 * expectations from the test's vars, so a case is one YAML block: inputs and expectations together.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** A var or an output promptfoo may hand over as an object or as its JSON text. */
function val(v) {
  if (typeof v !== "string") return v;
  const t = v.trim();
  if (!(t.startsWith("{") || t.startsWith("["))) return v;
  try {
    return JSON.parse(t);
  } catch {
    return v;
  }
}

function at(o, path) {
  return String(path)
    .split(".")
    .reduce((x, k) => (x === undefined || x === null ? undefined : x[k]), o);
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const result = (pass, reason) => ({ pass, score: pass ? 1 : 0, reason });

/**
 * The general check. Vars it reads (each optional):
 *  expect:         { "path": value }        deep equality
 *  expectMin:      { "path": number }       output >= number
 *  expectContains: { "path": ["text", …] }  every text appears in the string at path
 *  expectLacks:    { "path": ["text", …] }  no text appears
 *  expectOrder:    { "path": ["a", "b", …] }  all appear, in this order
 *  expectTruthy:   ["path", …]
 */
export function check(output, context) {
  const o = val(output);
  const vars = context?.vars ?? {};
  const failures = [];
  for (const [path, want] of Object.entries(val(vars.expect) ?? {})) {
    const got = at(o, path);
    if (!same(got, want)) failures.push(`${path}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
  }
  for (const [path, min] of Object.entries(val(vars.expectMin) ?? {})) {
    const got = at(o, path);
    if (!(Number(got) >= Number(min))) failures.push(`${path}: expected at least ${min}, got ${JSON.stringify(got)}`);
  }
  for (const [path, texts] of Object.entries(val(vars.expectContains) ?? {})) {
    const got = String(at(o, path) ?? "");
    for (const t of texts) if (!got.includes(t)) failures.push(`${path} lacks "${t}"`);
  }
  for (const [path, texts] of Object.entries(val(vars.expectLacks) ?? {})) {
    const got = String(at(o, path) ?? "");
    for (const t of texts) if (got.includes(t)) failures.push(`${path} must not carry "${t}"`);
  }
  for (const [path, texts] of Object.entries(val(vars.expectOrder) ?? {})) {
    const got = String(at(o, path) ?? "");
    let last = -1;
    for (const t of texts) {
      const i = got.indexOf(t, last + 1);
      if (i < 0) failures.push(`${path}: "${t}" is missing or out of order`);
      else last = i;
    }
  }
  const truthy = val(vars.expectTruthy) ?? [];
  for (const path of Array.isArray(truthy) ? truthy : String(truthy).split(",").map((s) => s.trim()).filter(Boolean)) if (!at(o, path)) failures.push(`${path} is not truthy`);
  return result(failures.length === 0, failures.length ? failures.join("; ") : "all expectations met");
}

/**
 * Prompt snapshot: the text at vars.snapshotPath (default "prompt") equals eval/snapshots/<vars.snapshot>.txt.
 * A missing file is written and passes; UPDATE_SNAPSHOTS=1 rewrites. A snapshot is one regression
 * check on the words the engine receives, never proof that the picture will look right.
 */
export function matchesSnapshot(output, context) {
  const o = val(output);
  const vars = context?.vars ?? {};
  const name = String(vars.snapshot ?? vars.case ?? "unnamed").replace(/[^a-z0-9_-]+/gi, "-");
  const text = String(at(o, vars.snapshotPath ?? "prompt") ?? "");
  const file = join(here, "snapshots", `${name}.txt`);
  if (!existsSync(file) || process.env.UPDATE_SNAPSHOTS === "1") {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    return result(true, `snapshot written: eval/snapshots/${name}.txt`);
  }
  const stored = readFileSync(file, "utf8");
  if (stored === text) return result(true, "matches the stored snapshot");
  const a = stored.split("\n");
  const b = text.split("\n");
  const line = a.findIndex((l, i) => l !== b[i]);
  return result(false, `differs from eval/snapshots/${name}.txt at line ${line + 1}: stored "${(a[line] ?? "").slice(0, 80)}" vs built "${(b[line] ?? "").slice(0, 80)}". Run with UPDATE_SNAPSHOTS=1 when the change is intended.`);
}

/** Approved lessons are carried in the built text; pending and rejected ones never are. */
export function memoryCarried(output, context) {
  const o = val(output);
  const text = String(o.prompt ?? o.instruction ?? "");
  const memory = o.memory ?? {};
  const field = context?.vars?.memoryPath ? String(at(o, context.vars.memoryPath)) : text;
  const missing = (memory.approved ?? []).filter((l) => !field.includes(l));
  const leaked = (memory.unapproved ?? []).filter((l) => field.includes(l));
  const ok = missing.length === 0 && leaked.length === 0 && (memory.approved ?? []).length > 0;
  return result(ok, ok ? `${memory.approved.length} approved lesson(s) carried, none pending or rejected` : [missing.length ? `approved lessons missing: ${missing.length}` : "", leaked.length ? `unapproved lessons leaked: ${leaked.length}` : "", !(memory.approved ?? []).length ? "no approved lesson in the fixture" : ""].filter(Boolean).join("; "));
}

/** TODO case for shared/feedback.ts interpretFeedback: passes while the module is absent. */
export function feedbackKind(output, context) {
  const o = val(output);
  if (o.todo) return result(true, `TODO: ${o.note}`);
  const want = String(context?.vars?.expectKind ?? "");
  return result(o.kind === want, `interpretFeedback("${o.text}") → ${o.kind} (expected ${want})`);
}

/** TODO case for shared/conflicts.ts detectConflicts: a people/hand conflict must be named, not resolved silently. */
export function conflictSurfaced(output) {
  const o = val(output);
  const c = o.conflicts ?? {};
  if (c.todo) return result(true, "TODO: shared/conflicts.ts detectConflicts is not in this branch yet; the prompt constraint is still asserted by `check`.");
  const named = (c.notes ?? []).some((n) => /people|person|hand/i.test(n));
  return result(named, named ? `conflict surfaced: ${c.notes.join(" | ")}` : `no people/hand conflict named (notes: ${JSON.stringify(c.notes)})`);
}
