/**
 * "Delete forever" removes a month's working rows with it, and keeps the records of money and of
 * what reached people. Found in the QA round: a purged month left its version rows (post_takes)
 * behind, pointing at files that were already deleted.
 */
import { describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { MONTH_TABLES, purgeBatch } from "../server/batchfiles";

type Env = ReturnType<typeof fakeEnv>;

/** One row in `table` for the month, every required column filled with a placeholder. */
function insert(env: Env, table: string, values: Record<string, unknown>) {
  const cols = env.DB.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; notnull: number; dflt_value: unknown; pk: number; type: string }[];
  const row: Record<string, unknown> = {};
  for (const c of cols) {
    if (c.name in values) row[c.name] = values[c.name];
    else if ((c.notnull || c.pk) && c.dflt_value === null) row[c.name] = /INT/i.test(c.type) ? (c.pk && !c.notnull ? null : 1) : `${table}-${c.name}-${String(values.batch ?? values.id ?? "")}`;
  }
  const keys = Object.keys(row).filter((k) => row[k] !== null);
  try {
    env.DB.db.prepare(`INSERT INTO ${table} (${keys.join(", ")}) VALUES (${keys.map(() => "?").join(", ")})`).run(...(keys.map((k) => row[k]) as never[]));
  } catch (e) {
    throw new Error(`${table}: ${(e as Error).message}`);
  }
}
const count = (env: Env, table: string, where: string) => (env.DB.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get() as { n: number }).n;

describe("deleting a month for good", () => {
  it("removes its working rows and keeps spend and publications", async () => {
    const env = fakeEnv();
    insert(env, "users", { id: "u1", email: "u@test" });
    insert(env, "batches", { id: "b1", owner: "u1", config: "{}" });
    insert(env, "batches", { id: "b2", owner: "u1", config: "{}" });
    // A task belongs to a source row: those go first.
    const order = ["sources", ...MONTH_TABLES.filter((t) => t !== "sources")];
    for (const t of order) {
      for (const b of ["b1", "b2"]) insert(env, t, { batch: b, ...(t === "sources" ? { id: `src-${b}` } : {}), ...(t === "tasks" ? { source: `src-${b}` } : {}) });
    }
    insert(env, "spend", { scope: "batch:b1" });
    insert(env, "publications", { batch: "b1" });

    await purgeBatch(env, { id: "b1", owner: "u1" });

    for (const t of MONTH_TABLES) {
      expect(count(env, t, "batch = 'b1'"), t).toBe(0);
      expect(count(env, t, "batch = 'b2'"), `${t} of another month`).toBe(1);
    }
    expect(count(env, "batches", "id = 'b1'")).toBe(0);
    expect(count(env, "spend", "scope = 'batch:b1'")).toBe(1);
    expect(count(env, "publications", "batch = 'b1'")).toBe(1);
  });
});
