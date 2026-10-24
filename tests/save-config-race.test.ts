/** The month is saved as one block: an older copy never drops the cards added after it was read (24 Oct, live). */
import { describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { saveConfig, type BatchRow } from "../server/posts";
import { postConfig, type Config } from "../shared/config";
import type { Post } from "../shared/posts";

const card = (index: number, ideaAt: number) => ({ index, type: "product", title: `Card ${index}`, brief: "b", caption: "", hashtags: "", ideaAt }) as Post;

async function seed() {
  const env = fakeEnv();
  const config = postConfig("c1", "2026-10", { postCount: 1, plan: [card(1, 500)] });
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, created) VALUES ('u1', 'a@t', 'A', 'x', 'admin', 1)").run();
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'Oct', ?, 'idle', 1, 1000, 'c1', '2026-10')").bind(JSON.stringify(config)).run();
  return env;
}
const read = async (env: ReturnType<typeof fakeEnv>) => (await env.DB.prepare("SELECT * FROM batches WHERE id = 'b1'").first<BatchRow>())!;
const plan = async (env: ReturnType<typeof fakeEnv>) => (JSON.parse((await read(env)).config) as Config).plan!.map((p) => p.index);

describe("saveConfig and a stale copy", () => {
  it("keeps a card added after the copy was read; a writer that read it can still remove it", async () => {
    const env = await seed();
    const stale = await read(env); // read at updated = 1000, plan [1]
    // Another writer adds card 2 (the campaign's card).
    const fresh = await read(env);
    const c2 = JSON.parse(fresh.config) as Config;
    c2.plan = [...c2.plan!, card(2, 2000)];
    await saveConfig(env as never, fresh, c2);
    // The engine's older copy is written: card 2 stays.
    const c1 = JSON.parse(stale.config) as Config;
    c1.plan![0].caption = "edited by the engine";
    await saveConfig(env as never, stale, c1);
    expect(await plan(env)).toEqual([1, 2]);
    // A writer that read card 2 removes it on purpose: it goes.
    const now = await read(env);
    const c3 = JSON.parse(now.config) as Config;
    c3.plan = c3.plan!.filter((p) => p.index !== 2);
    await saveConfig(env as never, now, c3);
    expect(await plan(env)).toEqual([1]);
  });
});
