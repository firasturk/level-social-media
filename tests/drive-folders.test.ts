import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch, type Reached } from "./support/paid-guard";
import { postConfig } from "../shared/config";
import type { User } from "../shared/types";
import type { DriveListing } from "../shared/drive";
import type { Config } from "../shared/config";
import type { PostReference } from "../shared/posts";

/**
 * The Drive integration without a credential: on a preview the demo fixture stands in for Drive,
 * so folders, roles, duplicates, missing files and the snapshots a month keeps can be exercised
 * with no network at all. A fetch guard fails the test the moment anything is called.
 */
type FakeEnv = ReturnType<typeof fakeEnv>;
type App = Awaited<ReturnType<typeof app>>;

async function app() {
  const { StudioError } = await import("../server/errors");
  const { driveRoutes } = await import("../server/drive");
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", { id: "u1", email: "u@test", name: "U", role: "admin" } as User);
    await next();
  });
  a.route("/api/studio/drive", driveRoutes);
  a.onError((e, c) =>
    e instanceof StudioError
      ? c.json({ error: e.message, ...(e.data ?? {}) }, e.status as 400)
      : c.json({ error: String(e) }, 500),
  );
  return a;
}

async function seed(overrides: Record<string, string> = {}) {
  const env = fakeEnv({ PREVIEW_NO_IMAGES: "1", ...overrides } as never);
  const t = Date.now();
  await env.DB.prepare(
    "INSERT INTO users (id, email, name, password_hash, created) VALUES ('u1', 'u@test', 'U', 'x', ?)",
  )
    .bind(t)
    .run();
  await env.DB.prepare(
    "INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Sample', 'sample', 'active', ?, ?)",
  )
    .bind(t, t)
    .run();
  await env.DB.prepare(
    "INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c2', 'Other', 'other', 'active', ?, ?)",
  )
    .bind(t, t)
    .run();
  const config = postConfig("c1", "2026-10", {
    model: "nano-banana-pro",
    plan: [
      {
        index: 1,
        type: "product",
        title: "Mango crossing",
        brief: "The mango cup in the crossing sign.",
        caption: "",
        hashtags: "",
        product: "mango",
      } as never,
      {
        index: 2,
        type: "tip",
        title: "Tip",
        brief: "A tip card.",
        caption: "",
        hashtags: "",
      } as never,
    ],
  });
  await env.DB.prepare(
    "INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'Test month', ?, 'idle', ?, ?, 'c1', '2026-10')",
  )
    .bind(JSON.stringify(config), t, t)
    .run();
  return env;
}

const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
const JSON_HEADERS = { "content-type": "application/json" };
const listing = async (a: App, env: FakeEnv, client = "c1", fresh = true) =>
  (await json(
    await a.request(`/api/studio/drive/${client}${fresh ? "?fresh=1" : ""}`, {}, env),
  )) as unknown as DriveListing & { ok: boolean };

let reached: Reached[];

beforeEach(async () => {
  reached = guardFetch().reached;
  (await import("../server/drive-mock")).driveMock.reset();
});
afterEach(() => {
  expect(reached.map((r) => r.url)).toEqual([]);
});

describe("the Drive folders of a client", () => {
  it("adds, approves, re-roles and removes folders; the profile link stands in while none is approved", async () => {
    const env = await seed();
    const a = await app();
    // Nothing set: the demo folders stand in on a preview.
    let f = (await json(await a.request("/api/studio/drive/c1/folders", {}, env))) as {
      folders: { id: string; role: string; default?: boolean; demo?: boolean }[];
      demo: boolean;
    };
    expect(f.demo).toBe(true);
    expect(f.folders.map((x) => x.role)).toEqual(["product", "brand", "reference"]);
    expect(f.folders.every((x) => x.default && x.demo)).toBe(true);

    // The profile link is the default product folder.
    await env.DB.prepare(
      "INSERT INTO client_profiles (client, drive, updated) VALUES ('c1', 'https://drive.google.com/drive/folders/demo-drinks', 1)",
    ).run();
    f = (await json(await a.request("/api/studio/drive/c1/folders", {}, env))) as typeof f;
    expect(f.folders).toHaveLength(1);
    expect(f.folders[0]).toMatchObject({ id: "demo-drinks", role: "product", default: true });

    // A folder added from its link, waiting for approval.
    let r = await a.request(
      "/api/studio/drive/c1/folders",
      {
        method: "POST",
        body: JSON.stringify({
          link: "https://drive.google.com/drive/folders/demo-references",
          role: "reference",
        }),
        headers: JSON_HEADERS,
      },
      env,
    );
    expect(r.status).toBe(200);
    const added = (
      (await json(r)) as { folder: { id: string; name: string; role: string; approved: boolean } }
    ).folder;
    expect(added).toMatchObject({
      id: "demo-references",
      name: "Demo references",
      role: "reference",
      approved: false,
    });
    // Waiting: the profile folder still stands in.
    f = (await json(await a.request("/api/studio/drive/c1/folders", {}, env))) as typeof f;
    expect(f.folders.map((x) => x.id)).toEqual(["demo-references", "demo-drinks"]);

    // Approved: it is read, and the profile folder steps back.
    r = await a.request(
      "/api/studio/drive/c1/folders/demo-references",
      { method: "PUT", body: JSON.stringify({ approved: true }), headers: JSON_HEADERS },
      env,
    );
    expect(((await json(r)) as { folder: { approved: boolean } }).folder.approved).toBe(true);
    f = (await json(await a.request("/api/studio/drive/c1/folders", {}, env))) as typeof f;
    expect(f.folders.map((x) => x.id)).toEqual(["demo-references"]);
    const l = await listing(a, env);
    expect(l.groups.reference.map((p) => p.id).sort()).toEqual([
      "demo-ref-marble",
      "demo-ref-sign",
    ]);
    expect(l.groups.product).toEqual([]);

    // A bad role is refused; a new role is taken.
    expect(
      (
        await a.request(
          "/api/studio/drive/c1/folders/demo-references",
          { method: "PUT", body: JSON.stringify({ role: "misc" }), headers: JSON_HEADERS },
          env,
        )
      ).status,
    ).toBe(400);
    r = await a.request(
      "/api/studio/drive/c1/folders/demo-references",
      { method: "PUT", body: JSON.stringify({ role: "output" }), headers: JSON_HEADERS },
      env,
    );
    expect(((await json(r)) as { folder: { role: string } }).folder.role).toBe("output");
    expect((await listing(a, env)).groups.output).toHaveLength(2);

    // One folder belongs to one client.
    r = await a.request(
      "/api/studio/drive/c2/folders",
      {
        method: "POST",
        body: JSON.stringify({ id: "demo-references", role: "reference" }),
        headers: JSON_HEADERS,
      },
      env,
    );
    expect(r.status).toBe(409);
    // Not a folder link.
    expect(
      (
        await a.request(
          "/api/studio/drive/c1/folders",
          {
            method: "POST",
            body: JSON.stringify({ link: "habibah.com", role: "brand" }),
            headers: JSON_HEADERS,
          },
          env,
        )
      ).status,
    ).toBe(400);

    // Removed: the profile folder stands in again.
    expect(
      (await a.request("/api/studio/drive/c1/folders/demo-references", { method: "DELETE" }, env))
        .status,
    ).toBe(200);
    expect(
      (await a.request("/api/studio/drive/c1/folders/demo-references", { method: "DELETE" }, env))
        .status,
    ).toBe(404);
    f = (await json(await a.request("/api/studio/drive/c1/folders", {}, env))) as typeof f;
    expect(f.folders.map((x) => x.id)).toEqual(["demo-drinks"]);
  });
});

describe("the demo listing", () => {
  it("serves the fixture by role, flagged demo, with no network", async () => {
    const env = await seed();
    const a = await app();
    const l = await listing(a, env);
    expect(l.ok).toBe(true);
    expect(l.demo).toBe(true);
    expect(l.folder).toBe("Demo drinks (product photos)");
    expect(l.groups.product).toHaveLength(6);
    expect(l.groups.brand.map((p) => p.file)).toEqual(["Demo logo.png"]);
    expect(l.groups.reference).toHaveLength(2);
    expect(l.groups.output).toEqual([]);
    expect(l.photos.every((p) => p.role && p.md5 && p.modified)).toBe(true);
    // Product identification travels with each photo: a camera-named file keeps its code until vision names it.
    const unread = l.groups.product.find((p) => p.id === "demo-cold-brew");
    expect(unread?.name).toBe("DSC01838");
    expect(unread?.kind).toBeUndefined();
    await env.DB.prepare(
      "UPDATE drive_photos SET status = 'read', name = 'Cold brew bottle', kind = 'drink', note = 'a dark bottle' WHERE id = 'demo-cold-brew'",
    ).run();
    const read = (await listing(a, env, "c1", false)).groups.product.find(
      (p) => p.id === "demo-cold-brew",
    );
    expect(read).toMatchObject({
      name: "Cold brew bottle",
      kind: "drink",
      note: "a dark bottle",
      role: "product",
    });
    const info = (await json(await a.request("/api/studio/drive", {}, env))) as {
      email: string | null;
      demo: boolean;
    };
    expect(info).toMatchObject({ email: null, demo: true });
    // The photo rendition is served from the fixture.
    const img = await a.request("/api/studio/drive/photo/demo-mango?size=320", {}, env);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/svg+xml");
    expect(await img.text()).toContain("Mango sunrise cup");
  });

  it("is never used when a credential exists", async () => {
    const env = await seed();
    const { setSetting, VERTEX_SETTING } = await import("../server/settings");
    await setSetting(
      env,
      VERTEX_SETTING,
      JSON.stringify({
        clientEmail: "studio@project.iam.gserviceaccount.com",
        privateKey: "not-a-key",
        projectId: "p",
        location: "us-central1",
      }),
    );
    await env.DB.prepare(
      "INSERT INTO client_profiles (client, drive, updated) VALUES ('c1', 'https://drive.google.com/drive/folders/demo-drinks', 1)",
    ).run();
    const a = await app();
    const l = await listing(a, env);
    expect(l.demo).toBe(false);
    expect(l.email).toBe("studio@project.iam.gserviceaccount.com");
    expect(l.photos).toEqual([]);
    expect(l.error).toBeTruthy();
    const f = (await json(await a.request("/api/studio/drive/c1/folders", {}, env))) as {
      folders: unknown[];
      demo: boolean;
    };
    expect(f.demo).toBe(false);
    // The profile folder stands in; none of the demo folders does.
    expect(f.folders).toHaveLength(1);
    expect(f.folders[0]).toMatchObject({ id: "demo-drinks", default: true });
    expect((f.folders[0] as { demo?: boolean }).demo).toBeUndefined();
    reached.length = 0; // a signing attempt may or may not reach the network; nothing it did was a vendor call
  });
});

describe("duplicates and missing files", () => {
  it("marks the later copy of a photo as a duplicate of the first", async () => {
    const env = await seed();
    const a = await app();
    const l = await listing(a, env);
    const copy = l.groups.product.find((p) => p.id === "demo-pistachio-copy");
    const head = l.groups.product.find((p) => p.id === "demo-pistachio");
    expect(copy?.duplicateOf).toBe("demo-pistachio");
    expect(head?.duplicateOf).toBeUndefined();
    expect(l.groups.product.filter((p) => p.duplicateOf)).toHaveLength(1);
    const rows = await env.DB.prepare(
      "SELECT id, md5, role FROM drive_photos WHERE client = 'c1' AND md5 = ?",
    )
      .bind(copy!.md5)
      .all<{ id: string; role: string }>();
    expect(rows.results.map((r) => r.id).sort()).toEqual(["demo-pistachio", "demo-pistachio-copy"]);
    expect(rows.results.every((r) => r.role === "product")).toBe(true);
  });

  it("lists a file in the bin as missing with its reason and refuses its bytes", async () => {
    const env = await seed();
    const a = await app();
    const l = await listing(a, env);
    expect(l.groups.product.some((p) => p.id === "demo-berry-missing")).toBe(false);
    expect(l.missing).toHaveLength(1);
    expect(l.missing[0]).toMatchObject({
      id: "demo-berry-missing",
      role: "product",
      missing: true,
    });
    expect(l.missing[0].reason).toMatch(/Not available in Drive/);
    const row = (await env.DB.prepare(
      "SELECT status, reason FROM drive_photos WHERE id = 'demo-berry-missing'",
    ).first<{ status: string; reason: string }>())!;
    expect(row.status).toBe("missing");
    expect(row.reason).toMatch(/bin/);
    const img = await a.request("/api/studio/drive/photo/demo-berry-missing", {}, env);
    expect(img.status).toBe(404);
    expect(((await json(img)) as { error: string }).error).toMatch(/Not available in Drive/);
  });

  it("marks a photo missing when a complete listing no longer sees it, and lists it again when it is back", async () => {
    const env = await seed();
    const a = await app();
    await listing(a, env);
    const { driveMock } = await import("../server/drive-mock");
    const lemon = driveMock.files.get("demo-lemon-mint")!;
    driveMock.files.delete("demo-lemon-mint");
    let l = await listing(a, env);
    expect(l.groups.product.some((p) => p.id === "demo-lemon-mint")).toBe(false);
    const gone = l.missing.find((p) => p.id === "demo-lemon-mint");
    expect(gone?.reason).toMatch(/deleted, moved out of the shared folders or unshared/);
    expect(gone?.name).toBe("Lemon mint cooler");
    // The bytes of a file Drive answers 404 for are refused.
    expect((await a.request("/api/studio/drive/photo/demo-lemon-mint", {}, env)).status).toBe(404);
    driveMock.files.set("demo-lemon-mint", lemon);
    l = await listing(a, env);
    expect(l.groups.product.some((p) => p.id === "demo-lemon-mint")).toBe(true);
    expect(l.missing.some((p) => p.id === "demo-lemon-mint")).toBe(false);
    const row = (await env.DB.prepare(
      "SELECT status FROM drive_photos WHERE id = 'demo-lemon-mint'",
    ).first<{ status: string }>())!;
    expect(row.status).toBe("new");
  });
});

describe("snapshots: what a month used never changes", () => {
  it("records the Drive file, version and checksum on an imported product photo", async () => {
    const env = await seed();
    const { importDrivePhoto } = await import("../server/drive");
    const row = await importDrivePhoto(
      env,
      "u1",
      "b1",
      "demo-mango",
      "Mango sunrise cup",
      new Set(),
    );
    expect(row.name).toBe("Mango sunrise cup.svg");
    const src = (await env.DB.prepare(
      "SELECT drive_id, drive_version, drive_md5, kind, role, key FROM sources WHERE id = ?",
    )
      .bind(row.id)
      .first<Record<string, string>>())!;
    expect(src).toMatchObject({
      drive_id: "demo-mango",
      drive_version: "2026-09-02T09:00:00.000Z",
      drive_md5: "d1a0f0c0e0b0a0900000000000000001",
      kind: "product",
      role: "lead",
    });
    const stored = await env.BUCKET.get(src.key);
    expect(await stored!.text()).toContain("#f2a21b");

    // The file changes in Drive: a later listing sees the new version, the source keeps its snapshot.
    const { driveMock } = await import("../server/drive-mock");
    const f = driveMock.files.get("demo-mango")!;
    f.modifiedTime = "2026-10-20T12:00:00.000Z";
    f.md5Checksum = "d1a0f0c0e0b0a09000000000000000ff";
    f.color = "#ff0000";
    const a = await app();
    const l = await listing(a, env);
    expect(l.groups.product.find((p) => p.id === "demo-mango")).toMatchObject({
      modified: "2026-10-20T12:00:00.000Z",
      md5: "d1a0f0c0e0b0a09000000000000000ff",
    });
    const again = (await env.DB.prepare(
      "SELECT drive_version, drive_md5, key FROM sources WHERE id = ?",
    )
      .bind(row.id)
      .first<Record<string, string>>())!;
    expect(again).toMatchObject({
      drive_version: "2026-09-02T09:00:00.000Z",
      drive_md5: "d1a0f0c0e0b0a0900000000000000001",
    });
    expect(await (await env.BUCKET.get(again.key))!.text()).toContain("#f2a21b");
    // The changed photo is queued to be read again.
    const dp = (await env.DB.prepare(
      "SELECT status FROM drive_photos WHERE id = 'demo-mango'",
    ).first<{ status: string }>())!;
    expect(dp.status).toBe("new");
    // A missing photo cannot be imported.
    await expect(
      importDrivePhoto(env, "u1", "b1", "demo-berry-missing", "Berry", new Set()),
    ).rejects.toThrow(/Not available in Drive/);
  });

  it("pins a reference to a post with its Drive identity, and a later Drive change leaves the post alone", async () => {
    const env = await seed();
    const a = await app();
    let r = await a.request(
      "/api/studio/drive/c1/pin",
      {
        method: "POST",
        body: JSON.stringify({
          batch: "b1",
          post: 1,
          photoId: "demo-ref-sign",
          note: "the mood of the sign",
        }),
        headers: JSON_HEADERS,
      },
      env,
    );
    expect(r.status).toBe(200);
    const ref = ((await json(r)) as { reference: PostReference }).reference;
    expect(ref.drive).toEqual({
      id: "demo-ref-sign",
      version: "2026-08-12T09:00:00.000Z",
      md5: "d1a0f0c0e0b0a0900000000000000020",
      name: "Street sign mood.jpg",
    });
    expect(ref.note).toBe("the mood of the sign");
    expect(ref.name).toBe("Street sign mood");
    expect(ref.key).toMatch(/^u1\/b1\/reference\//);
    expect(ref.thumb).toMatch(/^u1\/b1\/reference\/.*-thumb\./);
    const big = await env.BUCKET.get(ref.key);
    const thumb = await env.BUCKET.get(ref.thumb);
    expect(await big!.text()).toContain("#1565c0");
    expect(await thumb!.text()).toContain('width="360"');
    const cfg = JSON.parse(
      (await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{
        config: string;
      }>())!.config,
    ) as Config;
    expect(cfg.plan?.find((p) => p.index === 1)?.reference).toEqual(ref);
    expect(cfg.plan?.find((p) => p.index === 2)?.reference).toBeUndefined();

    // Drive moves on; the post keeps the picture it pinned.
    const { driveMock } = await import("../server/drive-mock");
    const f = driveMock.files.get("demo-ref-sign")!;
    f.modifiedTime = "2026-11-01T08:00:00.000Z";
    f.color = "#000000";
    const l = await listing(a, env);
    expect(l.groups.reference.find((p) => p.id === "demo-ref-sign")?.modified).toBe(
      "2026-11-01T08:00:00.000Z",
    );
    const after = JSON.parse(
      (await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{
        config: string;
      }>())!.config,
    ) as Config;
    expect(after.plan?.find((p) => p.index === 1)?.reference).toEqual(ref);
    expect(await (await env.BUCKET.get(ref.key))!.text()).toContain("#1565c0");

    // Pinning again takes the new version and replaces the copy.
    r = await a.request(
      "/api/studio/drive/c1/pin",
      {
        method: "POST",
        body: JSON.stringify({ batch: "b1", post: 1, photoId: "demo-ref-sign" }),
        headers: JSON_HEADERS,
      },
      env,
    );
    const ref2 = ((await json(r)) as { reference: PostReference }).reference;
    expect(ref2.drive?.version).toBe("2026-11-01T08:00:00.000Z");
    expect(ref2.key).not.toBe(ref.key);
    expect(await env.BUCKET.get(ref.key)).toBeNull();
    expect(await (await env.BUCKET.get(ref2.key))!.text()).toContain("#000000");

    // The wrong client, a post not in the month, a missing photo.
    expect(
      (
        await a.request(
          "/api/studio/drive/c2/pin",
          {
            method: "POST",
            body: JSON.stringify({ batch: "b1", post: 1, photoId: "demo-ref-sign" }),
            headers: JSON_HEADERS,
          },
          env,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await a.request(
          "/api/studio/drive/c1/pin",
          {
            method: "POST",
            body: JSON.stringify({ batch: "b1", post: 9, photoId: "demo-ref-sign" }),
            headers: JSON_HEADERS,
          },
          env,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await a.request(
          "/api/studio/drive/c1/pin",
          {
            method: "POST",
            body: JSON.stringify({ batch: "b1", post: 1, photoId: "demo-berry-missing" }),
            headers: JSON_HEADERS,
          },
          env,
        )
      ).status,
    ).toBe(404);
  });
});

describe("the shared helpers", () => {
  it("groups by role and points copies at their first", async () => {
    const { groupByRole, markDuplicates } = await import("../shared/drive");
    const base = { file: "", name: "", folder: "", w: 0, h: 0 };
    const photos = [
      { ...base, id: "b", modified: "2026-02-01", md5: "x", role: "product" as const },
      { ...base, id: "a", modified: "2026-01-01", md5: "x", role: "product" as const },
      {
        ...base,
        id: "c",
        modified: "2026-03-01",
        md5: "x",
        role: "product" as const,
        missing: true,
      },
      { ...base, id: "d", modified: "2026-01-01", md5: "", role: "brand" as const },
      { ...base, id: "e", modified: "2026-01-01", md5: "y" },
    ];
    const marked = markDuplicates(photos);
    expect(marked.map((p) => p.duplicateOf)).toEqual([
      "a",
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
    const g = groupByRole(marked);
    expect(g.product.map((p) => p.id)).toEqual(["b", "a", "c", "e"]);
    expect(g.brand.map((p) => p.id)).toEqual(["d"]);
    expect(g.reference).toEqual([]);
  });
});
