/**
 * The client's Instagram account for a designed style's mockup (server/clients.ts instagramAccount):
 * the handle the team typed, else the one Meta read, else a slug of the name; the logo as the
 * profile picture at the URL the cards use; plausible, fixed mockup figures. No network call.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { cleanHandle, instagramAccount, mockupFigures } from "../server/clients";

type FakeEnv = ReturnType<typeof fakeEnv>;

async function seed(client: { id: string; name: string; logo?: string }): Promise<FakeEnv> {
  const env = fakeEnv();
  await env.DB.prepare(
    "INSERT INTO clients (id, name, slug, status, created, updated, logo_key) VALUES (?, ?, ?, 'active', 1, 77, ?)",
  )
    .bind(client.id, client.name, `slug-${client.id}`, client.logo ?? null)
    .run();
  return env;
}

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
});
afterEach(() => {
  expect(reached.map((r) => r.url)).toEqual([]);
});

describe("the client's Instagram account", () => {
  it("takes the handle the team typed, without its at sign or URL, and the logo as the profile picture", async () => {
    const env = await seed({ id: "c1", name: "Habibah Sweets", logo: "clients/c1/logo-x" });
    await env.DB.prepare(
      "INSERT INTO client_profiles (client, instagram, sources, updated) VALUES ('c1', 'https://www.instagram.com/habibah.sweets/', ?, 1)",
    )
      .bind(
        JSON.stringify({
          instagram: {
            username: "habibahsweets_official",
            followers: 412_000,
            posts: 900,
            read: 24,
            picture: "https://cdn/x.jpg",
          },
          refs: [],
          grids: 0,
        }),
      )
      .run();
    const a = await instagramAccount(env, "c1");
    expect(a.handle).toBe("habibah.sweets");
    expect(a.name).toBe("Habibah Sweets");
    expect(a.avatarSrc).toBe("/api/studio/clients/c1/logo?v=77");
    expect(a.followers).toBe(412_000);
    // About 3.5% of the followers like, 2% of those comment: natural-looking figures.
    expect(a.likes).toBeGreaterThan(11_000);
    expect(a.likes).toBeLessThan(17_500);
    expect(a.comments).toBeGreaterThan(150);
    expect(a.comments).toBeLessThan(450);
    expect(await instagramAccount(env, "c1")).toEqual(a);
  });

  it("falls back to the handle Meta read, then to a slug of the client's name, and to fixed figures without followers", async () => {
    const env = await seed({ id: "c2", name: "Abu Saleh Sweets" });
    await env.DB.prepare(
      "INSERT INTO client_profiles (client, instagram, sources, updated) VALUES ('c2', '', ?, 1)",
    )
      .bind(
        JSON.stringify({
          instagram: { username: "abusaleh.jo", followers: 0, posts: 0, read: 0, picture: null },
          refs: [],
          grids: 0,
        }),
      )
      .run();
    const read = await instagramAccount(env, "c2");
    expect(read.handle).toBe("abusaleh.jo");
    expect(read.avatarSrc).toBeNull();
    expect(read.followers).toBeNull();
    expect(read.likes).toBeGreaterThanOrEqual(2400);
    expect(read.likes).toBeLessThanOrEqual(48_000);
    expect(read.comments).toBeGreaterThanOrEqual(3);
    const none = await seed({ id: "c3", name: "Zain Café" });
    const bare = await instagramAccount(none, "c3");
    expect(bare.handle).toBe("zain_cafe");
    expect(bare.followers).toBeNull();
    await expect(instagramAccount(none, "nope")).rejects.toThrow("Client not found.");
  });

  it("keeps the figures the same for one client and in range for any", () => {
    for (const id of ["a", "b", "c", "client-1234", "x".repeat(36)]) {
      const f = mockupFigures(id, null);
      expect(f).toEqual(mockupFigures(id, null));
      expect(f.likes).toBeGreaterThanOrEqual(2400);
      expect(f.likes).toBeLessThanOrEqual(48_000);
      expect(f.comments).toBeLessThan(f.likes);
    }
    expect(mockupFigures("a", 1_000_000).likes).toBeGreaterThan(29_000);
    expect(mockupFigures("a", 1_000_000).likes % 100).toBe(0);
    expect(cleanHandle("@Level.MENA ")).toBe("Level.MENA");
    expect(cleanHandle("instagram.com/level_mena?igsh=1")).toBe("level_mena");
    expect(cleanHandle("https://instagram.com/level mena")).toBe("level");
  });
});
