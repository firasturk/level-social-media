import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEnv } from "./support/fakes";
import { postConfig } from "../shared/config";
import type { User } from "../shared/types";

/**
 * Delivery of a month's final posts into the client's Drive, with Google mocked: the token
 * endpoint answers a fake token and a small in-memory Drive answers the files calls. Nothing here
 * reaches Google; a call to any other host fails the test.
 */
type FakeEnv = ReturnType<typeof fakeEnv>;
type App = Awaited<ReturnType<typeof app>>;

const SA_EMAIL = "studio@project.iam.gserviceaccount.com";
const OUTPUTS = "outputs-folder-1";
const JPEG = `data:image/jpeg;base64,${btoa("\xff\xd8\xff\xe0 a tiny fake jpeg body for the test")}`;

async function makeKeyPem(): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  const b64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

async function app() {
  const { StudioError } = await import("../server/errors");
  const { studioRoutes } = await import("../server/studio");
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", { id: "u1", email: "u@test", name: "U", role: "admin" } as User);
    await next();
  });
  a.route("/api/studio", studioRoutes);
  a.onError((e, c) =>
    e instanceof StudioError
      ? c.json({ error: e.message }, e.status as 400)
      : c.json({ error: String(e) }, 500),
  );
  return a;
}

async function seed(opts: { credential?: boolean; outputs?: boolean } = {}) {
  const env = fakeEnv();
  const t = Date.now();
  await env.DB.prepare(
    "INSERT INTO users (id, email, name, password_hash, created) VALUES ('u1', 'u@test', 'U', 'x', ?)",
  )
    .bind(t)
    .run();
  await env.DB.prepare(
    "INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Sample Drinks', 'sample', 'active', ?, ?)",
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
        brief: "b",
        caption: "Fresh mango, every morning.",
        hashtags: "#mango #fresh",
        date: "2026-10-03",
      } as never,
      {
        index: 2,
        type: "tip",
        title: "Tip: Iced?",
        brief: "b",
        caption: "Ask for it iced.",
        hashtags: "",
        date: "2026-10-10",
      } as never,
      {
        index: 3,
        type: "product",
        title: "Berry",
        brief: "b",
        caption: "Berries.",
        hashtags: "#berry",
      } as never,
    ],
    approvals: { "1": { status: "approved", at: t }, "2": { status: "changes", at: t } },
  });
  await env.DB.prepare(
    "INSERT INTO batches (id, owner, name, config, state, created, updated, client, month) VALUES ('b1', 'u1', 'October', ?, 'idle', ?, ?, 'c1', '2026-10')",
  )
    .bind(JSON.stringify(config), t, t)
    .run();
  if (opts.credential !== false) {
    const { setSetting, VERTEX_SETTING } = await import("../server/settings");
    await setSetting(
      env,
      VERTEX_SETTING,
      JSON.stringify({
        clientEmail: SA_EMAIL,
        privateKey: await makeKeyPem(),
        projectId: "p",
        location: "global",
      }),
    );
  }
  if (opts.outputs !== false) {
    await env.DB.prepare(
      "INSERT INTO drive_folders (id, client, name, role, approved, added_by, created, updated) VALUES (?, 'c1', 'Deliveries', 'output', 1, 'u1', ?, ?)",
    )
      .bind(OUTPUTS, t, t)
      .run();
    // An approved product folder never stands in for the Outputs folder.
    await env.DB.prepare(
      "INSERT INTO drive_folders (id, client, name, role, approved, added_by, created, updated) VALUES ('products-1', 'c1', 'Products', 'product', 1, 'u1', ?, ?)",
    )
      .bind(t, t)
      .run();
  }
  return env;
}

/* ───────────── A small Drive ───────────── */

interface Stored {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  body: string;
  version: number;
}

interface FakeDriveOptions {
  /** What files.get on the Outputs folder answers. */
  canAddChildren?: boolean;
  /** Every write (search, create, upload) is refused with this status. */
  refuseWrites?: number;
}

function fakeDrive(opts: FakeDriveOptions = {}) {
  const files = new Map<string, Stored>();
  const calls: { method: string; url: string }[] = [];
  let n = 0;
  const json = (o: unknown, status = 200) =>
    new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  const view = (f: Stored) => ({
    id: f.id,
    name: f.name,
    mimeType: f.mimeType,
    webViewLink: `https://drive.google.com/file/d/${f.id}/view`,
    md5Checksum: `md5-${f.id}-${f.version}`,
  });
  const refused = () =>
    json(
      {
        error: {
          code: opts.refuseWrites,
          message: "The user does not have sufficient permissions for this file.",
          errors: [{ reason: "insufficientFilePermissions" }],
        },
      },
      opts.refuseWrites,
    );

  const stub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url });
    const u = new URL(url);
    if (u.hostname === "oauth2.googleapis.com") {
      const body = String(init?.body ?? "");
      expect(body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
      return json({ access_token: "tok-write", expires_in: 3600 });
    }
    if (u.hostname !== "www.googleapis.com")
      throw new Error(`A network call was made without the test asking for it: ${url}`);
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer tok-write");

    // files.get on the Outputs folder: capabilities.
    if (method === "GET" && u.pathname === `/drive/v3/files/${OUTPUTS}`) {
      expect(u.searchParams.get("supportsAllDrives")).toBe("true");
      if (opts.canAddChildren === undefined)
        return json(
          { error: { code: 404, message: "File not found", errors: [{ reason: "notFound" }] } },
          404,
        );
      return json({
        name: "Deliveries (Drive)",
        capabilities: { canAddChildren: opts.canAddChildren },
      });
    }
    if (opts.refuseWrites) return refused();

    // files.list: the subfolder search by name and parent.
    if (method === "GET" && u.pathname === "/drive/v3/files") {
      const q = u.searchParams.get("q") ?? "";
      const name = /name = '((?:[^'\\]|\\.)*)'/.exec(q)?.[1]?.replace(/\\(.)/g, "$1");
      const parent = /'([^']+)' in parents/.exec(q)?.[1];
      const hits = [...files.values()].filter(
        (f) =>
          f.name === name &&
          f.parents.includes(parent ?? "") &&
          f.mimeType === "application/vnd.google-apps.folder",
      );
      return json({ files: hits.map(view) });
    }
    // files.create of a folder.
    if (method === "POST" && u.pathname === "/drive/v3/files") {
      const meta = JSON.parse(String(init?.body)) as {
        name: string;
        mimeType: string;
        parents: string[];
      };
      const f: Stored = {
        id: `f${++n}`,
        name: meta.name,
        mimeType: meta.mimeType,
        parents: meta.parents,
        body: "",
        version: 1,
      };
      files.set(f.id, f);
      return json(view(f));
    }
    // Multipart upload of a new file.
    if (method === "POST" && u.pathname === "/upload/drive/v3/files") {
      expect(u.searchParams.get("uploadType")).toBe("multipart");
      expect(u.searchParams.get("supportsAllDrives")).toBe("true");
      const ct = (init?.headers as Record<string, string>)["Content-Type"];
      const boundary = /boundary=(.+)$/.exec(ct)![1];
      const text = new TextDecoder().decode(init!.body as Uint8Array);
      const parts = text.split(`--${boundary}`).filter((p) => p.trim() && p.trim() !== "--");
      const meta = JSON.parse(parts[0].split("\r\n\r\n")[1].trim()) as {
        name: string;
        parents: string[];
      };
      const mime = /Content-Type: (.+)\r\n/.exec(parts[1])![1];
      const body = parts[1].split("\r\n\r\n")[1].replace(/\r\n$/, "");
      const f: Stored = {
        id: `f${++n}`,
        name: meta.name,
        mimeType: mime,
        parents: meta.parents,
        body,
        version: 1,
      };
      files.set(f.id, f);
      return json(view(f));
    }
    // Media update of an existing file.
    const up = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (method === "PATCH" && up) {
      expect(u.searchParams.get("uploadType")).toBe("media");
      const f = files.get(decodeURIComponent(up[1]));
      if (!f) return json({ error: { code: 404, message: "File not found" } }, 404);
      f.body = new TextDecoder().decode(init!.body as Uint8Array);
      f.version++;
      return json(view(f));
    }
    // Metadata update (a rename).
    const meta = /^\/drive\/v3\/files\/([^/]+)$/.exec(u.pathname);
    if (method === "PATCH" && meta) {
      const f = files.get(decodeURIComponent(meta[1]));
      if (!f) return json({ error: { code: 404, message: "File not found" } }, 404);
      f.name = (JSON.parse(String(init?.body)) as { name: string }).name;
      return json(view(f));
    }
    throw new Error(`The fake Drive has no answer for ${method} ${url}`);
  });
  vi.stubGlobal("fetch", stub);
  return { files, calls, stub };
}

const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
const HEADERS = { "content-type": "application/json" };
const deliver = (a: App, env: FakeEnv, body: unknown) =>
  a.request(
    "/api/studio/drive/delivery/c1/deliver",
    { method: "POST", body: JSON.stringify(body), headers: HEADERS },
    env,
  );

beforeEach(async () => {
  // Each test signs its own key: forget the token the previous one cached.
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("delivery status", () => {
  it("says the folder is writable when the account can add children", async () => {
    const env = await seed();
    fakeDrive({ canAddChildren: true });
    const a = await app();
    const s = await json(await a.request("/api/studio/drive/delivery/c1/status", {}, env));
    expect(s).toMatchObject({
      ok: true,
      email: SA_EMAIL,
      writable: true,
      reason: null,
      folder: {
        id: OUTPUTS,
        name: "Deliveries (Drive)",
        link: `https://drive.google.com/drive/folders/${OUTPUTS}`,
      },
    });
  });

  it("asks to share the folder as Editor when the account can only read it, or cannot see it", async () => {
    const env = await seed();
    fakeDrive({ canAddChildren: false });
    const a = await app();
    let s = await json(await a.request("/api/studio/drive/delivery/c1/status", {}, env));
    expect(s.writable).toBe(false);
    expect(s.reason).toContain(`Share the folder with ${SA_EMAIL} as Editor`);

    vi.unstubAllGlobals();
    fakeDrive(); // the folder answers 404: not shared at all
    s = await json(await a.request("/api/studio/drive/delivery/c1/status", {}, env));
    expect(s.writable).toBe(false);
    expect(s.reason).toMatch(/can't open the Outputs folder/);
    expect(s.reason).toContain(`Share the folder with ${SA_EMAIL} as Editor`);
  });

  it("says to pick an Outputs folder when none is approved; the product folder never stands in", async () => {
    const env = await seed({ outputs: false });
    const t = Date.now();
    await env.DB.prepare(
      "INSERT INTO drive_folders (id, client, name, role, approved, added_by, created, updated) VALUES ('products-1', 'c1', 'Products', 'product', 1, 'u1', ?, ?)",
    )
      .bind(t, t)
      .run();
    // A waiting (unapproved) Outputs folder does not count either.
    await env.DB.prepare(
      "INSERT INTO drive_folders (id, client, name, role, approved, added_by, created, updated) VALUES ('waiting-out', 'c1', 'Out', 'output', 0, 'u1', ?, ?)",
    )
      .bind(t, t)
      .run();
    const { calls } = fakeDrive({ canAddChildren: true });
    const a = await app();
    const s = await json(await a.request("/api/studio/drive/delivery/c1/status", {}, env));
    expect(s).toMatchObject({ ok: true, email: SA_EMAIL, folder: null, writable: false });
    expect(s.reason).toMatch(/Pick an Outputs folder in the Drive picker/);
    expect(calls).toEqual([]);

    const d = await deliver(a, env, {
      batch: "b1",
      posts: [{ index: 1, image: JPEG }],
      captions: true,
    });
    expect(d.status).toBe(428);
    expect((await json(d)).error).toMatch(/Pick an Outputs folder/);
  });

  it("says what is missing when no credential is connected", async () => {
    const env = await seed({ credential: false });
    const { calls } = fakeDrive({ canAddChildren: true });
    const a = await app();
    const s = await json(await a.request("/api/studio/drive/delivery/c1/status", {}, env));
    expect(s).toMatchObject({ email: null, writable: false });
    expect(s.reason).toMatch(/connect Vertex in Connection first/);
    expect(calls).toEqual([]);
  });
});

describe("delivering a month", () => {
  it("creates the month folder, the pictures and captions.txt, then updates them on a second delivery", async () => {
    const env = await seed();
    const drive = fakeDrive({ canAddChildren: true });
    const a = await app();

    // First chunk: two posts, no captions yet.
    let r = await deliver(a, env, {
      batch: "b1",
      posts: [
        { index: 1, image: JPEG },
        { index: 2, image: JPEG },
      ],
      captions: false,
    });
    expect(r.status).toBe(200);
    let d = (await json(r)) as {
      folder: { id: string; name: string; webViewLink: string; created: boolean };
      files: {
        post: number | null;
        kind: string;
        name: string;
        webViewLink: string;
        updated: boolean;
      }[];
    };
    expect(d.folder).toMatchObject({ name: "October 2026 · Level Social Media", created: true });
    expect(d.folder.webViewLink).toContain(d.folder.id);
    expect(d.files).toEqual([
      {
        post: 1,
        kind: "picture",
        name: "01 Mango crossing.jpg",
        webViewLink: expect.stringContaining("/view"),
        updated: false,
      },
      {
        post: 2,
        kind: "picture",
        name: "02 Tip Iced.jpg",
        webViewLink: expect.stringContaining("/view"),
        updated: false,
      },
    ]);
    const sub = drive.files.get(d.folder.id)!;
    expect(sub.parents).toEqual([OUTPUTS]);
    const stored = [...drive.files.values()].filter((f) => f.mimeType === "image/jpeg");
    expect(stored.map((f) => f.name)).toEqual(["01 Mango crossing.jpg", "02 Tip Iced.jpg"]);
    expect(stored.every((f) => f.parents[0] === sub.id)).toBe(true);
    expect(stored[0].body).toContain("a tiny fake jpeg body");

    // Last chunk: the third post with captions.txt; the folder is found, not created again.
    r = await deliver(a, env, { batch: "b1", posts: [{ index: 3, image: JPEG }], captions: true });
    expect(r.status).toBe(200);
    d = (await json(r)) as typeof d;
    expect(d.folder).toMatchObject({ id: sub.id, created: false });
    expect(d.files.map((f) => [f.kind, f.name, f.updated])).toEqual([
      ["picture", "03 Berry.jpg", false],
      ["captions", "captions.txt", false],
    ]);
    const captions = [...drive.files.values()].find((f) => f.name === "captions.txt")!;
    expect(captions.mimeType).toMatch(/^text\/plain/);
    expect(captions.body).toContain("October 2026 · Sample Drinks");
    expect(captions.body).toContain(
      "01 · Mango crossing\nDate: 2026-10-03\n\nFresh mango, every morning.\n\n#mango #fresh",
    );
    expect(captions.body).toContain("02 · Tip: Iced?\nDate: 2026-10-10\n\nAsk for it iced.");
    expect(captions.body).toContain("03 · Berry\n\nBerries.\n\n#berry");
    expect(
      [...drive.files.values()].filter((f) => f.mimeType === "application/vnd.google-apps.folder"),
    ).toHaveLength(1);

    // The rows remember every file with its link.
    const list = (await json(
      await a.request("/api/studio/drive/delivery/c1/deliveries?batch=b1", {}, env),
    )) as {
      folder: { id: string };
      files: { post: number | null; kind: string; name: string; webViewLink: string }[];
    };
    expect(list.folder.id).toBe(sub.id);
    expect(list.files.map((f) => [f.post, f.kind, f.name])).toEqual([
      [1, "picture", "01 Mango crossing.jpg"],
      [2, "picture", "02 Tip Iced.jpg"],
      [3, "picture", "03 Berry.jpg"],
      [null, "captions", "captions.txt"],
    ]);
    expect(list.files.every((f) => f.webViewLink.includes("/view"))).toBe(true);

    // Second delivery of post 1 (title changed meanwhile) and captions: the files are updated, not duplicated.
    const cfg = JSON.parse(
      (await env.DB.prepare("SELECT config FROM batches WHERE id = 'b1'").first<{
        config: string;
      }>())!.config,
    );
    cfg.plan[0].title = "Mango at the crossing";
    await env.DB.prepare("UPDATE batches SET config = ? WHERE id = 'b1'")
      .bind(JSON.stringify(cfg))
      .run();
    const before = drive.files.size;
    const callsBefore = drive.calls.length;
    r = await deliver(a, env, { batch: "b1", posts: [{ index: 1, image: JPEG }], captions: true });
    expect(r.status).toBe(200);
    d = (await json(r)) as typeof d;
    expect(d.files.map((f) => [f.kind, f.name, f.updated])).toEqual([
      ["picture", "01 Mango at the crossing.jpg", true],
      ["captions", "captions.txt", true],
    ]);
    expect(drive.files.size).toBe(before);
    const first = [...drive.files.values()].find((f) => f.name === "01 Mango at the crossing.jpg")!;
    expect(first.version).toBe(2);
    expect(captions.version).toBe(2);
    expect(captions.body).toContain("01 · Mango at the crossing");
    const writes = drive.calls.slice(callsBefore).filter((c) => c.method !== "GET");
    expect(writes.map((c) => c.method)).toEqual(["PATCH", "PATCH", "PATCH"]); // media, rename, captions media
    expect(writes.every((c) => c.url.includes("supportsAllDrives=true"))).toBe(true);
    expect(writes[0].url).toContain(`/upload/drive/v3/files/${first.id}?uploadType=media`);
    const rows = await env.DB.prepare(
      "SELECT post, kind, name, md5 FROM drive_deliveries WHERE batch = 'b1' ORDER BY post",
    ).all<{
      post: number | null;
      kind: string;
      name: string;
      md5: string;
    }>();
    expect(rows.results).toHaveLength(4);
    expect(rows.results.find((x) => x.post === 1)).toMatchObject({
      name: "01 Mango at the crossing.jpg",
      md5: `md5-${first.id}-2`,
    });
  });

  it("recreates a file Drive no longer has instead of failing", async () => {
    const env = await seed();
    const drive = fakeDrive({ canAddChildren: true });
    const a = await app();
    let r = await deliver(a, env, {
      batch: "b1",
      posts: [{ index: 1, image: JPEG }],
      captions: false,
    });
    expect(r.status).toBe(200);
    const id = ((await json(r)) as { files: { webViewLink: string }[] }).files[0].webViewLink
      .split("/d/")[1]
      .split("/")[0];
    drive.files.delete(id); // someone deleted it in Drive
    r = await deliver(a, env, { batch: "b1", posts: [{ index: 1, image: JPEG }], captions: false });
    expect(r.status).toBe(200);
    const d = (await json(r)) as {
      files: { name: string; updated: boolean; webViewLink: string }[];
    };
    expect(d.files[0]).toMatchObject({ name: "01 Mango crossing.jpg", updated: false });
    expect(d.files[0].webViewLink).not.toContain(id);
    expect(
      [...drive.files.values()].filter((f) => f.name === "01 Mango crossing.jpg"),
    ).toHaveLength(1);
  });

  it("turns a 403 from Drive into a readable error naming the account to share with", async () => {
    const env = await seed();
    fakeDrive({ canAddChildren: true, refuseWrites: 403 });
    const a = await app();
    const r = await deliver(a, env, {
      batch: "b1",
      posts: [{ index: 1, image: JPEG }],
      captions: false,
    });
    expect(r.status).toBe(403);
    const e = (await json(r)).error as string;
    expect(e).toMatch(/The studio can't open the Outputs folder: Drive refused \(403\)/);
    expect(e).toContain(`Share the folder with ${SA_EMAIL} as Editor`);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM drive_deliveries").first<{ n: number }>(),
    ).toEqual({ n: 0 });
  });

  it("refuses a post that is not in the plan, a bad picture and too many posts at once", async () => {
    const env = await seed();
    const { calls } = fakeDrive({ canAddChildren: true });
    const a = await app();
    let r = await deliver(a, env, {
      batch: "b1",
      posts: [{ index: 9, image: JPEG }],
      captions: false,
    });
    expect(r.status).toBe(409);
    expect((await json(r)).error).toMatch(/Post 9 is not in this month's plan/);
    r = await deliver(a, env, {
      batch: "b1",
      posts: [{ index: 1, image: "https://example.com/not-a-data-url-but-long-enough" }],
      captions: false,
    });
    expect(r.status).toBe(400);
    expect((await json(r)).error).toMatch(/base64 image data URL/);
    r = await deliver(a, env, {
      batch: "b1",
      posts: [1, 2, 3, 1, 2].map((index) => ({ index, image: JPEG })),
      captions: false,
    });
    expect(r.status).toBe(400);
    expect((await json(r)).error).toMatch(/up to 4 composed pictures/);
    r = await deliver(a, env, {
      batch: "nope",
      posts: [{ index: 1, image: JPEG }],
      captions: false,
    });
    expect(r.status).toBe(404);
    // Nothing was written: the bad data URL failed after the folder was found, nothing else reached Drive.
    expect(calls.filter((c) => c.url.includes("/upload/"))).toEqual([]);
  });
});

describe("names and captions", () => {
  it("names pictures and the month folder, and writes captions blocks", async () => {
    const { pictureName, deliveryFolderName, captionsText } =
      await import("../server/drive-delivery");
    expect(pictureName({ index: 3, title: "Mango crossing" })).toBe("03 Mango crossing.jpg");
    expect(pictureName({ index: 12, title: ' A/B: "test" <x>?  ' })).toBe("12 A B test x.jpg");
    expect(pictureName({ index: 1, title: "" })).toBe("01 Post 01.jpg");
    expect(deliveryFolderName("2026-10")).toBe("October 2026 · Level Social Media");
    const text = captionsText("October 2026 · Sample", [
      { index: 1, title: "A", date: "2026-10-01", caption: "Hello", hashtags: "#a" },
      { index: 2, title: "", caption: "", hashtags: "" },
    ]);
    expect(text).toBe(
      "October 2026 · Sample\n=====================\n\n01 · A\nDate: 2026-10-01\n\nHello\n\n#a\n\n---\n\n02 · Untitled\n\n(no caption)\n",
    );
  });
});
