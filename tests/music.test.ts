/**
 * The music library (docs/music-library.md): the catalog's data and filters, the licence form, the
 * test audio and its tempo, and the routes — who may import (admins), what an import keeps, how a
 * catalog track is copied on first use (and refused when its file changed at the source), Range
 * requests, and the waveform computed once and cached. No network call leaves the test: each one is
 * answered by a stub or fails the test.
 */
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeEnv } from "./support/fakes";
import { guardFetch } from "./support/paid-guard";
import type { User } from "../shared/types";
import { StudioError } from "../server/errors";
import { listIntegrationOps, setIntegrationSwitch } from "../server/integrations";
import { CATALOG, catalogEntry } from "../shared/music-catalog";
import { readWav, synthTestSamples, synthTestWav, wavBytes } from "../shared/music-test-audio";
import { REFUSED_LICENCE, driveFileId, estimateBpm, filterFromQuery, filterTracks, foldText, peaksFrom, tempoFromEnvelope, validPeaks, validateLicenceForm, type MusicTrack } from "../shared/music";
import { catalogTrack } from "../server/music";

const drive = vi.hoisted(() => ({ driveAudioFile: vi.fn() }));
vi.mock("../server/drive", async (orig) => ({ ...(await orig<typeof import("../server/drive")>()), driveAudioFile: drive.driveAudioFile }));

const { studioRoutes } = await import("../server/studio");

type FakeEnv = ReturnType<typeof fakeEnv>;

function app(role: User["role"]) {
  const a = new Hono<{ Bindings: FakeEnv; Variables: { user: User } }>();
  a.use("*", async (c, next) => {
    c.set("user", { id: role === "admin" ? "u1" : "u2", email: "x@y", name: "X", role } as User);
    await next();
  });
  a.route("/api/studio", studioRoutes);
  a.onError((e, c) => (e instanceof StudioError ? c.json({ error: e.message, ...(e.data ?? {}) }, e.status as 400) : c.json({ error: String(e) }, 500)));
  return a;
}
type App = ReturnType<typeof app>;

async function seed() {
  const env = fakeEnv();
  const t = Date.now();
  await env.DB.prepare("INSERT INTO clients (id, name, slug, status, created, updated) VALUES ('c1', 'Music test client', 'music-test-client', 'active', ?, ?)").bind(t, t).run();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, disabled, created) VALUES ('u1', 'admin@test', 'Firas', 'x', 'admin', 0, ?)").bind(t).run();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, role, disabled, created) VALUES ('u2', 'member@test', 'Nour', 'x', 'member', 0, ?)").bind(t).run();
  return env;
}

const json = (r: Response) => r.json() as Promise<Record<string, unknown>>;
const send = (a: App, env: FakeEnv, method: string, path: string, body?: unknown) => a.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }, env);

const LICENCE = {
  title: "Souq morning",
  artist: "Oud trio",
  moods: "arabic,calm",
  genre: "World",
  source: "Commissioned for Habibah, contract 2026-04",
  sourceUrl: "https://example.test/contract",
  author: "Oud trio",
  licence: "own",
  contentId: "not_registered",
  contentIdNote: "Never registered (our commission).",
  confirmed: "true",
};

async function upload(a: App, env: FakeEnv, fields: Record<string, string> = LICENCE, file = new File([synthTestWav({ ...catalogEntry("test-maqsum-100")!.synth!, seconds: 2 })], "souq.wav", { type: "audio/wav" })) {
  const form = new FormData();
  form.set("client", "c1");
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  form.set("file", file);
  return a.request("/api/studio/music/library/upload", { method: "POST", body: form }, env);
}

let guard: ReturnType<typeof guardFetch>;
beforeEach(() => {
  guard = guardFetch();
  drive.driveAudioFile.mockReset();
});

/* ───────────── Data ───────────── */

describe("the starter catalog", () => {
  it("has 8 to 15 tracks across the moods, every one with its licence, source and Content ID", () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(8);
    expect(CATALOG.length).toBeLessThanOrEqual(15);
    expect(new Set(CATALOG.map((e) => e.slug)).size).toBe(CATALOG.length);
    for (const mood of ["upbeat", "calm", "cinematic", "corporate", "energy", "arabic"] as const) expect(CATALOG.filter((e) => !e.test && e.moods.includes(mood)).length, mood).toBeGreaterThan(0);
    for (const e of CATALOG) {
      expect(e.redistribution, e.slug).toBe(true);
      expect(e.licence.url, e.slug).toMatch(/^https:\/\/creativecommons\.org\/(publicdomain\/zero|licenses\/by)\/\d\.\d\/$/);
      expect(REFUSED_LICENCE.test(`${e.licence.name} ${e.licence.url}`), e.slug).toBe(false);
      expect(e.source.author, e.slug).not.toBe("");
      expect(e.source.verified).toBe("2026-10-23");
      if (e.licence.attributionRequired) expect(e.licence.attribution, e.slug).toContain(e.title);
      if (e.test) {
        expect(e.title).toContain("(Test audio)");
        expect(e.synth).toBeDefined();
        expect(e.contentId.status).toBe("not_registered");
      } else {
        expect(e.file?.url, e.slug).toMatch(/^https:\/\/upload\.wikimedia\.org\/wikipedia\/commons\//);
        expect(e.source.page, e.slug).toMatch(/^https:\/\/commons\.wikimedia\.org\/wiki\/File:/);
        if (e.file?.sha1) expect(e.file.sha1).toMatch(/^[0-9a-f]{40}$/);
      }
      if (e.artist === "Kevin MacLeod") {
        expect(e.contentId.status).toBe("registered");
        expect(e.licence.attribution).toMatch(/^"[^"]+" Kevin MacLeod \(incompetech\.com\)\nLicensed under Creative Commons: By Attribution [34]\.0\nhttps:/);
      }
    }
  });

  const tracks = CATALOG.map((e) => catalogTrack(e));

  it("filters by mood, genre, duration band, BPM band and words", () => {
    expect(filterTracks(tracks, { mood: "arabic" }).map((t) => t.id)).toEqual(["cat:desert-city", "cat:test-maqsum-100"]);
    expect(filterTracks(tracks, { genre: "classical piano" }).map((t) => t.id)).toEqual(["cat:goldberg-aria", "cat:wtc-prelude-1"]);
    expect(filterTracks(tracks, { maxDuration: 30 }).map((t) => t.id)).toEqual(["cat:test-beat-120", "cat:test-maqsum-100"]);
    expect(filterTracks(tracks, { minDuration: 60, maxDuration: 180 }).every((t) => t.duration >= 60 && t.duration < 180)).toBe(true);
    // A BPM bound leaves out the tracks with no tempo (the classical recordings).
    const fast = filterTracks(tracks, { minBpm: 120 });
    expect(fast.every((t) => t.bpm !== null && t.bpm >= 120)).toBe(true);
    expect(fast.some((t) => t.id === "cat:goldberg-aria")).toBe(false);
    expect(filterTracks(tracks, { minBpm: 80, maxBpm: 90 }).map((t) => t.id).sort()).toEqual(["cat:desert-city", "cat:sneaky-snitch", "cat:test-pads-80"]);
    expect(filterTracks(tracks, { q: "kevin desert" }).map((t) => t.id)).toEqual(["cat:desert-city"]);
    expect(filterTracks(tracks, { q: "sport" }).every((t) => t.moods.includes("energy"))).toBe(true);
    expect(filterTracks(tracks, { includeTest: false }).some((t) => t.test)).toBe(false);
  });

  it("finds Arabic names whatever the hamza or diacritics", () => {
    expect(foldText("إيقاع")).toBe(foldText("ايقاع"));
    expect(filterTracks(tracks, { q: "ايقاع" }).map((t) => t.id)).toEqual(["cat:test-maqsum-100"]);
    expect(filterTracks(tracks, { q: "مقسوم" }).map((t) => t.id)).toEqual(["cat:test-maqsum-100"]);
  });

  it("reads filters from a query string and drops what it cannot use", () => {
    expect(filterFromQuery({ mood: "arabic", minBpm: "90", maxDuration: "x", test: "0", genre: "" })).toEqual({ q: undefined, mood: "arabic", genre: undefined, minDuration: undefined, maxDuration: undefined, minBpm: 90, maxBpm: undefined, includeTest: false });
    expect(filterFromQuery({ mood: "sad" }).mood).toBeUndefined();
  });
});

describe("test audio", () => {
  it("synthesises the same WAV every time, of the length the catalog says", () => {
    for (const e of CATALOG.filter((x) => x.synth)) {
      const a = synthTestWav(e.synth!);
      const b = synthTestWav(e.synth!);
      expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
      const wav = readWav(a)!;
      expect(wav.rate).toBe(22050);
      expect(wav.channels[0].length / wav.rate).toBeCloseTo(e.duration, 1);
    }
  });

  it("is measured at the tempo it was made at (the same analysis the panel runs on imported tracks)", () => {
    for (const e of CATALOG.filter((x) => x.synth)) {
      const s = synthTestSamples(e.synth!);
      const hop = 0.02;
      const step = Math.round(hop * 22050);
      const env = new Float32Array(Math.ceil(s.length / step));
      for (let i = 0; i < env.length; i++) {
        let sum = 0;
        for (let j = i * step; j < Math.min(s.length, (i + 1) * step); j++) sum += s[j] * s[j];
        env[i] = Math.sqrt(sum / step);
      }
      const { bpm } = tempoFromEnvelope(env, hop);
      expect(Math.abs((bpm ?? 0) - e.bpm!), e.slug).toBeLessThanOrEqual(2);
    }
  });

  it("gives no tempo for a sound with no pulse, and folds a beat grid to the counted tempo", () => {
    // A held pad: steady energy with a little noise, no pulse.
    let seed = 7;
    const noise = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648) * 0.01;
    const env = new Float32Array(1000).map(() => 0.3 + noise());
    expect(tempoFromEnvelope(env, 0.02).bpm).toBeNull();
    expect(estimateBpm(Array.from({ length: 20 }, (_, i) => i * 1.0))).toBe(120); // 60 → doubled
    expect(estimateBpm([0, 1])).toBeNull();
  });

  it("draws peaks scaled to the loudest bucket and accepts only sane peak lists", () => {
    const p = peaksFrom([new Float32Array([0, 0.5, -1, 0.25])], 4);
    expect(p).toEqual([0, 0.5, 1, 0.25]);
    expect(validPeaks(new Array(16).fill(0.5))).toHaveLength(16);
    expect(validPeaks([0.1, 2])).toBeNull();
    expect(validPeaks(new Array(16).fill(-1))).toBeNull();
  });
});

describe("the licence form", () => {
  const ok = { title: "Track", source: "Bought on Example Music, order 12", author: "A. Musician", licence: "paid", contentId: "unknown", confirmed: true };

  it("needs a name, source, author, licence, Content ID status and the confirmation", () => {
    expect(validateLicenceForm(ok).ok).toBe(true);
    for (const [k, reason] of [
      ["title", /name/],
      ["source", /source/],
      ["author", /author/],
      ["licence", /licence/],
      ["contentId", /Content ID/],
      ["confirmed", /Confirm/],
    ] as const) {
      const r = validateLicenceForm({ ...ok, [k]: undefined });
      expect(r.ok, k).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(reason);
    }
  });

  it("needs the attribution text for CC BY, a name and link for another licence, and refuses NC, ND and SA", () => {
    const by = validateLicenceForm({ ...ok, licence: "cc-by-4.0" });
    expect(by.ok).toBe(false);
    if (!by.ok) expect(by.reason).toMatch(/needs credit/);
    const withCredit = validateLicenceForm({ ...ok, licence: "cc-by-4.0", attribution: '"Track" by A. Musician, CC BY 4.0' });
    expect(withCredit.ok && withCredit.form.licenceUrl).toBe("https://creativecommons.org/licenses/by/4.0/");
    expect(validateLicenceForm({ ...ok, licence: "other" }).ok).toBe(false);
    for (const bad of ["https://creativecommons.org/licenses/by-nc/4.0/", "https://creativecommons.org/licenses/by-nd/4.0/", "https://creativecommons.org/licenses/by-sa/4.0/"]) {
      const r = validateLicenceForm({ ...ok, licence: "other", licenceName: "Some CC", licenceUrl: bad });
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/cannot be used/);
    }
    expect(validateLicenceForm({ ...ok, licenceName: "Personal use only" }).ok).toBe(false);
  });

  it("reads Drive file links", () => {
    expect(driveFileId("https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWx/view?usp=sharing")).toBe("1AbCdEfGhIjKlMnOpQrStUvWx");
    expect(driveFileId("https://drive.google.com/open?id=1AbCdEfGhIjKlMnOpQrStUvWx")).toBe("1AbCdEfGhIjKlMnOpQrStUvWx");
    expect(driveFileId("not a link")).toBeNull();
  });
});

/* ───────────── Routes ───────────── */

describe("browsing (everyone)", () => {
  it("lists and filters the catalog for a member, with what they may do", async () => {
    const env = await seed();
    const r = await app("member").request("/api/studio/music/catalog?mood=calm&test=0", {}, env);
    expect(r.status).toBe(200);
    const body = await json(r);
    const tracks = body.tracks as MusicTrack[];
    expect(tracks.length).toBeGreaterThan(2);
    expect(tracks.every((t) => t.moods.includes("calm") && !t.test)).toBe(true);
    expect(tracks[0].url).toMatch(/^\/api\/studio\/music\/file\?id=cat%3A/);
    expect((body.access as { admin: boolean }).admin).toBe(false);
    expect(guard.stub).not.toHaveBeenCalled();
  });

  it("serves test audio: synthesised and stored on first use, recorded, then served with Range", async () => {
    const env = await seed();
    const member = app("member");
    const r = await member.request("/api/studio/music/file?id=cat:test-beat-120", {}, env);
    expect(r.status).toBe(200);
    expect(r.headers.get("Accept-Ranges")).toBe("bytes");
    expect(r.headers.get("Content-Type")).toBe("audio/wav");
    const size = Number(r.headers.get("Content-Length"));
    expect(size).toBe(44 + 24 * 22050 * 2);
    const copies = await env.DB.prepare("SELECT * FROM music_copies").all<{ track: string; copied_by: string; licence: string; source_url: string }>();
    expect(copies.results).toHaveLength(1);
    expect(copies.results[0]).toMatchObject({ track: "test-beat-120", copied_by: "u2" });
    expect(copies.results[0].licence).toContain("CC0 1.0");

    const part = await member.request("/api/studio/music/file?id=cat:test-beat-120", { headers: { Range: "bytes=100-199" } }, env);
    expect(part.status).toBe(206);
    expect(part.headers.get("Content-Range")).toBe(`bytes 100-199/${size}`);
    expect((await part.arrayBuffer()).byteLength).toBe(100);
    const tail = await member.request("/api/studio/music/file?id=cat:test-beat-120", { headers: { Range: "bytes=-10" } }, env);
    expect(tail.headers.get("Content-Range")).toBe(`bytes ${size - 10}-${size - 1}/${size}`);
    const bad = await member.request("/api/studio/music/file?id=cat:test-beat-120", { headers: { Range: `bytes=${size + 5}-` } }, env);
    expect(bad.status).toBe(416);
    const head = await member.request("/api/studio/music/file?id=cat:test-beat-120", { method: "HEAD" }, env);
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe(String(size));
    // Copied once.
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM music_copies").first<{ n: number }>())!.n).toBe(1);
    expect((await listIntegrationOps(env, { provider: "audio" })).filter((o) => o.kind === "music.copy")).toHaveLength(1);
    const listed = (await json(await member.request("/api/studio/music/catalog", {}, env))).tracks as MusicTrack[];
    expect(listed.find((t) => t.id === "cat:test-beat-120")!.stored).toBe(true);
    expect(guard.stub).not.toHaveBeenCalled();
  });

  it("copies a Commons track once, naming itself to Wikimedia, and refuses a file that changed at the source", async () => {
    const env = await seed();
    const mp3 = new Uint8Array(4096).fill(7).buffer;
    const seen: { url: string; ua: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        seen.push({ url, ua: new Headers(init?.headers).get("User-Agent") });
        if (!url.startsWith("https://upload.wikimedia.org/")) throw new Error(`unexpected ${url}`);
        return new Response(mp3, { status: 200, headers: { "Content-Type": "audio/mpeg" } });
      }),
    );
    const member = app("member");
    // Pinned size and SHA-1: our 4 KB stand-in is not the file the catalog verified, so nothing is stored.
    const changed = await member.request("/api/studio/music/file?id=cat:desert-city", {}, env);
    expect(changed.status).toBe(502);
    expect((await json(changed)).error).toMatch(/changed at Wikimedia Commons/);
    expect([...env.BUCKET.objects.keys()].filter((k) => k.startsWith("music/catalog/"))).toEqual([]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM music_copies").first<{ n: number }>())!.n).toBe(0);
    // A transcode (nothing pinned): stored and recorded with its checksum.
    const ok = await member.request("/api/studio/music/file?id=cat:sneaky-snitch", {}, env);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(seen.every((s) => /LevelSocialMediaStudio/.test(s.ua ?? ""))).toBe(true);
    const row = await env.DB.prepare("SELECT * FROM music_copies WHERE track = 'sneaky-snitch'").first<{ bytes: number; sha1: string; source_url: string; licence: string }>();
    expect(row).toMatchObject({ bytes: 4096, source_url: catalogEntry("sneaky-snitch")!.file!.url });
    expect(row!.sha1).toMatch(/^[0-9a-f]{40}$/);
    expect(row!.licence).toContain("CC BY 4.0");
    const before = seen.length;
    await member.request("/api/studio/music/file?id=cat:sneaky-snitch", { headers: { Range: "bytes=0-9" } }, env);
    expect(seen.length).toBe(before);
  });

  it("says Commons is busy (and stores nothing) when it answers 429", async () => {
    const env = await seed();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("slow down", { status: 429 })));
    const r = await app("member").request("/api/studio/music/file?id=cat:goldberg-aria", {}, env);
    expect(r.status).toBe(503);
    expect((await json(r)).error).toMatch(/busy.*Nothing was stored/);
    expect(env.BUCKET.objects.size).toBe(0);
  });

  it("answers 404 for an unknown track", async () => {
    const env = await seed();
    expect((await app("member").request("/api/studio/music/file?id=cat:nope", {}, env)).status).toBe(404);
    expect((await app("member").request("/api/studio/music/file?id=lib:nope", {}, env)).status).toBe(404);
  });
});

describe("the waveform", () => {
  it("is computed once for WAV test audio and then read from the cache", async () => {
    const env = await seed();
    const member = app("member");
    const first = await json(await member.request("/api/studio/music/peaks?id=cat:test-pads-80", {}, env));
    expect(first).toMatchObject({ cached: false, computed: "server" });
    expect((first.peaks as number[]).length).toBe(400);
    expect(Math.max(...(first.peaks as number[]))).toBe(1);
    const put = vi.spyOn(env.BUCKET, "put");
    const again = await json(await member.request("/api/studio/music/peaks?id=cat:test-pads-80", {}, env));
    expect(again).toMatchObject({ cached: true, computed: "server" });
    expect(again.peaks).toEqual(first.peaks);
    expect(put).not.toHaveBeenCalled();
  });

  it("waits for a browser on an mp3, keeps the first one sent and never overwrites it", async () => {
    const env = await seed();
    const member = app("member");
    const none = await json(await member.request("/api/studio/music/peaks?id=cat:upbeat-forever", {}, env));
    expect(none).toMatchObject({ peaks: null, cached: false });
    expect(guard.stub).not.toHaveBeenCalled(); // asking for peaks does not copy the track
    const a = new Array(400).fill(0).map((_, i) => (i % 10) / 10);
    const b = new Array(400).fill(0.5);
    const s1 = await json(await send(member, env, "PUT", "/api/studio/music/peaks", { id: "cat:upbeat-forever", peaks: a }));
    expect(s1).toMatchObject({ cached: false });
    const s2 = await json(await send(member, env, "PUT", "/api/studio/music/peaks", { id: "cat:upbeat-forever", peaks: b }));
    expect(s2).toMatchObject({ cached: true, peaks: a });
    const read = await json(await member.request("/api/studio/music/peaks?id=cat:upbeat-forever", {}, env));
    expect(read).toMatchObject({ cached: true, computed: "browser", peaks: a });
    const badPut = await send(member, env, "PUT", "/api/studio/music/peaks", { id: "cat:upbeat-forever", peaks: [2, 3] });
    expect(badPut.status).toBe(400);
  });
});

describe("importing (admins)", () => {
  it("refuses a member's upload, Drive import, edit and removal with 403 and writes nothing", async () => {
    const env = await seed();
    const member = app("member");
    const up = await upload(member, env);
    expect(up.status).toBe(403);
    expect((await json(up)).error).toMatch(/Admins only for now/);
    expect((await send(member, env, "POST", "/api/studio/music/library/drive", { client: "c1", file: "1AbCdEfGhIjKlMnOpQrStUvWx", ...LICENCE })).status).toBe(403);
    expect((await send(member, env, "PATCH", "/api/studio/music/library/x", { title: "y" })).status).toBe(403);
    expect((await send(member, env, "DELETE", "/api/studio/music/library/x")).status).toBe(403);
    expect(env.BUCKET.objects.size).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM music_tracks").first<{ n: number }>())!.n).toBe(0);
    expect(await listIntegrationOps(env, { provider: "audio" })).toEqual([]);
    expect(drive.driveAudioFile).not.toHaveBeenCalled();
  });

  it("refuses an upload whose licence fields are missing, before storing anything", async () => {
    const env = await seed();
    const admin = app("admin");
    for (const drop of ["source", "author", "licence", "contentId", "confirmed"]) {
      const fields = { ...LICENCE } as Record<string, string>;
      delete fields[drop];
      const r = await upload(admin, env, fields);
      expect(r.status, drop).toBe(400);
    }
    const nc = await upload(admin, env, { ...LICENCE, licence: "other", licenceName: "CC BY-NC 4.0", licenceUrl: "https://creativecommons.org/licenses/by-nc/4.0/" });
    expect(nc.status).toBe(400);
    expect(env.BUCKET.objects.size).toBe(0);
  });

  it("keeps an upload with its licence, lists it for the client and lets everyone play it", async () => {
    const env = await seed();
    const admin = app("admin");
    const r = await upload(admin, env);
    expect(r.status).toBe(200);
    const track = (await json(r)).track as MusicTrack;
    expect(track).toMatchObject({ kind: "library", title: "Souq morning", moods: ["arabic", "calm"], origin: "upload", client: "c1" });
    expect(track.licence).toMatchObject({ id: "own", name: "Own work or commissioned" });
    expect(track.contentId).toEqual({ status: "not_registered", note: "Never registered (our commission)." });
    expect(track.source).toEqual({ name: LICENCE.source, page: LICENCE.sourceUrl, author: "Oud trio" });
    expect(track.duration).toBeCloseTo(2, 1);
    const row = await env.DB.prepare("SELECT * FROM music_tracks").first<{ key: string; confirmed_by: string; sha1: string }>();
    expect(row!.key).toMatch(/^music\/library\/c1\/.+\.wav$/);
    expect(row!.confirmed_by).toBe("u1");
    expect(env.BUCKET.objects.get(row!.key)!.customMetadata?.licence).toBe("Own work or commissioned");
    const ops = await listIntegrationOps(env, { provider: "audio" });
    expect(ops.map((o) => o.kind)).toEqual(["music.import"]);
    expect(ops[0].note).toMatch(/Souq morning.*Content ID: not_registered/);

    const member = app("member");
    const list = await json(await member.request("/api/studio/music/library?client=c1&mood=arabic", {}, env));
    expect((list.tracks as MusicTrack[]).map((t) => t.id)).toEqual([track.id]);
    expect(((await json(await member.request("/api/studio/music/library?client=c1&mood=energy", {}, env))).tracks as MusicTrack[]).length).toBe(0);
    const file = await member.request(track.url, { headers: { Range: "bytes=0-3" } }, env);
    expect(file.status).toBe(206);
    expect(new TextDecoder().decode(await file.arrayBuffer())).toBe("RIFF");
    // A WAV upload gets its waveform on the server.
    expect((await json(await member.request(track.peaksUrl, {}, env))).computed).toBe("server");
  });

  it("imports from Drive with the Drive file's version and checksum", async () => {
    const env = await seed();
    drive.driveAudioFile.mockResolvedValue({ bytes: wavBytes(new Float32Array(22050)), name: "jingle.wav", mime: "audio/wav", version: "2026-10-01T10:00:00.000Z", md5: "abc123" });
    const admin = app("admin");
    const bad = await send(admin, env, "POST", "/api/studio/music/library/drive", { client: "c1", file: "not a link", ...LICENCE, confirmed: true });
    expect(bad.status).toBe(400);
    const r = await send(admin, env, "POST", "/api/studio/music/library/drive", { client: "c1", file: "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWx/view", ...LICENCE, moods: ["upbeat"], confirmed: true });
    expect(r.status).toBe(200);
    expect(drive.driveAudioFile).toHaveBeenCalledWith(expect.anything(), "1AbCdEfGhIjKlMnOpQrStUvWx", 25 * 1024 * 1024);
    const row = await env.DB.prepare("SELECT * FROM music_tracks").first<{ origin: string; drive_id: string; drive_version: string; drive_md5: string; file_name: string }>();
    expect(row).toMatchObject({ origin: "drive", drive_id: "1AbCdEfGhIjKlMnOpQrStUvWx", drive_version: "2026-10-01T10:00:00.000Z", drive_md5: "abc123", file_name: "jingle.wav" });
  });

  it("corrects the licence only with a new confirmation, and archives instead of deleting", async () => {
    const env = await seed();
    const admin = app("admin");
    const track = (await json(await upload(admin, env))).track as MusicTrack;
    const id = track.id.slice(4);
    const noConfirm = await send(admin, env, "PATCH", `/api/studio/music/library/${id}`, { licence: "cc-by-4.0", attribution: '"Souq morning" by Oud trio, CC BY 4.0' });
    expect(noConfirm.status).toBe(400);
    const missingCredit = await send(admin, env, "PATCH", `/api/studio/music/library/${id}`, { licence: "cc-by-4.0", licenceName: "", licenceVersion: "", licenceUrl: "", confirmed: true });
    expect(missingCredit.status).toBe(400);
    const ok = await send(admin, env, "PATCH", `/api/studio/music/library/${id}`, { licence: "cc-by-4.0", licenceName: "", licenceVersion: "", licenceUrl: "", attribution: '"Souq morning" by Oud trio, CC BY 4.0', contentId: "unknown", confirmed: true });
    expect(ok.status).toBe(200);
    expect(((await json(ok)).track as MusicTrack).licence).toMatchObject({ id: "cc-by-4.0", version: "4.0", url: "https://creativecommons.org/licenses/by/4.0/", attributionRequired: true });
    const edits = (await listIntegrationOps(env, { provider: "audio" })).filter((o) => o.kind === "music.edit");
    expect(edits[0].note).toMatch(/changed .*licence.*attribution.*contentId/);

    expect((await send(admin, env, "DELETE", `/api/studio/music/library/${id}`)).status).toBe(200);
    const member = app("member");
    expect(((await json(await member.request("/api/studio/music/library?client=c1", {}, env))).tracks as MusicTrack[]).length).toBe(0);
    expect((await member.request(track.url, {}, env)).status).toBe(410);
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM music_tracks").first<{ n: number }>())!.n).toBe(1);
  });

  it("is refused while an admin has switched video audio off", async () => {
    const env = await seed();
    await setIntegrationSwitch(env, "audio", false);
    const r = await upload(app("admin"), env);
    expect(r.status).toBe(503);
    expect(env.BUCKET.objects.size).toBe(0);
  });

  it("stores a browser-measured BPM for a client's track that had none", async () => {
    const env = await seed();
    const admin = app("admin");
    const track = (await json(await upload(admin, env))).track as MusicTrack;
    expect(track.bpm).toBeNull();
    await env.BUCKET.delete(`music/peaks/${track.id}.json`);
    await send(app("member"), env, "PUT", "/api/studio/music/peaks", { id: track.id, peaks: new Array(64).fill(0.2), bpm: 99.6 });
    const list = await json(await admin.request("/api/studio/music/library?client=c1", {}, env));
    expect((list.tracks as MusicTrack[])[0]).toMatchObject({ bpm: 100, bpmSource: "measured" });
  });
});
