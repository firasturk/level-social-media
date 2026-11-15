import { beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import type { Config } from "../shared/config";
import { writeMonth } from "../server/month-save";

const post = (index: number, extra: Record<string, unknown> = {}) => ({ index, type: "product", title: `Post ${index}`, brief: `idea ${index}`, caption: "", hashtags: "", ...extra });

async function seed(config: object) {
  const env = await fakeEnv();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, created, role) VALUES ('u1', 'a@example.test', 'A', 'x', 1, 'admin')").run();
  await env.DB.prepare("INSERT INTO batches (id, owner, name, config, state, created, updated) VALUES ('b1', 'u1', 'Month', ?, 'idle', 1, 1)").bind(JSON.stringify(config)).run();
  return env;
}
const read = async (env: Awaited<ReturnType<typeof fakeEnv>>) => JSON.parse((await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{ config: string }>())!.config) as Config & { plan: ReturnType<typeof post>[] };
const row = async (env: Awaited<ReturnType<typeof fakeEnv>>) => (await env.DB.prepare("SELECT id, config FROM batches WHERE id = 'b1'").first<{ id: string; config: string }>())!;

describe("saving a month", () => {
  let env: Awaited<ReturnType<typeof fakeEnv>>;
  beforeEach(async () => {
    env = await seed({ size: "2K", plan: [post(1), post(2)], approvals: {} });
  });

  it("a long pass that saves its old copy keeps the edit and the client's answer saved meanwhile", async () => {
    // The engine pass reads the month…
    const slow = await row(env);
    const slowConfig = JSON.parse(slow.config) as Config & { plan: ReturnType<typeof post>[] };
    // …meanwhile the designer writes a caption on post 1 and the client approves it…
    const quick = await row(env);
    const quickConfig = JSON.parse(quick.config) as Config & { plan: ReturnType<typeof post>[]; approvals: Record<string, unknown> };
    quickConfig.plan[0].caption = "hand-written";
    (quickConfig as unknown as { approvals: Record<string, unknown> }).approvals = { "1": { status: "approved" } };
    await writeMonth(env, quick, quickConfig);
    // …then the pass writes a new idea for post 2 from its old copy.
    slowConfig.plan[1].brief = "a better idea";
    await writeMonth(env, slow, slowConfig);
    const now_ = await read(env);
    expect(now_.plan[0].caption).toBe("hand-written");
    expect(now_.plan[1].brief).toBe("a better idea");
    expect((now_ as unknown as { approvals: Record<string, unknown> }).approvals).toEqual({ "1": { status: "approved" } });
    // The writer's own copy now holds what was written.
    expect(slowConfig.plan[0].caption).toBe("hand-written");
  });

  it("two saves from the same copy in one request: the second builds on the first", async () => {
    const b = await row(env);
    const config = JSON.parse(b.config) as Config & { plan: ReturnType<typeof post>[]; note?: string };
    config.note = "on";
    await writeMonth(env, b, config);
    delete config.note;
    config.plan[0].caption = "second";
    await writeMonth(env, b, config);
    const now_ = (await read(env)) as unknown as { note?: string; plan: ReturnType<typeof post>[] };
    expect(now_.note).toBeUndefined();
    expect(now_.plan[0].caption).toBe("second");
  });

  it("writes nothing for a month that does not exist any more", async () => {
    await env.DB.prepare("DELETE FROM batches WHERE id = 'b1'").run();
    await expect(writeMonth(env, { id: "b1", config: "{}" }, { plan: [] } as unknown as Config)).resolves.toBeUndefined();
  });
});
