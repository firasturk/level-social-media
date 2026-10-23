/**
 * The Help assistant (server/help.ts): a question answered from the studio's guide in one text call
 * (stood in for here), the answer bounded, an unknown answer carrying a drafted request; "Send to
 * Firas" storing the request (and mailing the admins when Resend is set up); the member's own
 * requests with Firas's reply; the admins' inbox; the daily limit; the preview's fixed answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { guardFetch, type Reached } from "./support/paid-guard";
import { app, json, postJson, seed, type FakeEnv } from "./support/photo-mcp";
import * as posts from "../server/posts";
import { HELP_DAILY_LIMIT, helpInstruction, readHelpAnswer } from "../server/help";
import { HELP_GUIDE } from "../shared/help-guide";
import { setSetting, RESEND_KEY_SETTING } from "../server/settings";

let reached: Reached[];
beforeEach(() => {
  reached = guardFetch().reached;
});
afterEach(() => {
  vi.restoreAllMocks();
  expect(reached).toEqual([]);
});

const answer = (a: Record<string, unknown>) => vi.spyOn(posts, "askText").mockResolvedValue(JSON.stringify(a));
const ask = (env: FakeEnv, message: string, role: "admin" | "member" = "member") => postJson(app(role), env, "/api/studio/help/ask", { message, screen: "/studio?batch=b1" });

describe("asking", () => {
  it("answers from the guide with steps, and keeps the question for Firas to read", async () => {
    const env = await seed();
    const spy = answer({ answer: "تقدر تعمل كاروسيل من أدوات الصورة.", steps: ['Open the post and press "Edit picture"', 'Under the result press "Add as a carousel"'], known: true, request: "ignored when known" });
    const r = await ask(env, "كيف بعمل كاروسيل؟");
    expect(r.status).toBe(200);
    expect(await json(r)).toMatchObject({ known: true, request: "", steps: ['Open the post and press "Edit picture"', 'Under the result press "Add as a carousel"'] });
    const instruction = spy.mock.calls[0][1];
    expect(instruction).toContain("كيف بعمل كاروسيل؟");
    expect(instruction).toContain(HELP_GUIDE.slice(0, 200));
    expect(instruction).toContain("/studio?batch=b1");
    const inbox = (await json(await app("admin").request("/api/studio/help/requests?kind=question", {}, env))) as { items: { question: string; known: boolean; user: string }[] };
    expect(inbox.items).toMatchObject([{ question: "كيف بعمل كاروسيل؟", known: true, user: "member" }]);
  });

  it("passes on a drafted request when the guide does not cover it", async () => {
    const env = await seed();
    answer({ answer: "This is not in the studio yet.", steps: [], known: false, request: "Nour would like to schedule posts to TikTok from the studio." });
    expect(await json(await ask(env, "How do I post to TikTok?"))).toMatchObject({ known: false, request: "Nour would like to schedule posts to TikTok from the studio." });
  });

  it("stops at the daily limit", async () => {
    const env = await seed();
    const t = Date.now();
    for (let i = 0; i < HELP_DAILY_LIMIT; i++) await env.DB.prepare("INSERT INTO help_requests (id, user_id, kind, question, created, updated) VALUES (?, 'u2', 'question', 'q', ?, ?)").bind(`q${i}`, t, t).run();
    const spy = answer({ answer: "x", steps: [], known: true, request: "" });
    expect((await ask(env, "One more?")).status).toBe(429);
    expect(spy).not.toHaveBeenCalled();
  });

  it("answers on the preview from a fixed reply, without a text model", async () => {
    const env = await seed();
    (env as unknown as { PREVIEW_NO_IMAGES: string }).PREVIEW_NO_IMAGES = "1";
    const r = (await json(await ask(env, "How do I change the words?"))) as { answer: string; known: boolean };
    expect(r.answer).toContain("DEMO FIXTURE");
    expect(r.known).toBe(true);
  });

  it("reads the model's answer safely", () => {
    expect(readHelpAnswer({ answer: " Hi ", steps: ["a", 3, " ", "b"], known: true, request: "x" })).toEqual({ answer: "Hi", steps: ["a", "b"], known: true, request: "" });
    expect(readHelpAnswer({ answer: "No", known: false, request: " Please add it " })).toMatchObject({ known: false, request: "Please add it" });
    expect(() => readHelpAnswer({ answer: "", steps: [] })).toThrow();
    const text = helpInstruction({ message: "q?", history: [{ role: "user", text: "earlier" }], role: "member", name: "Nour" });
    expect(text).toContain("Member: earlier");
    expect(text).toContain("member, not an admin");
  });
});

describe("sending to Firas", () => {
  it("keeps the request, shows it in the admins' inbox, and the sender sees the reply", async () => {
    const env = await seed();
    const sent = (await json(await postJson(app("member"), env, "/api/studio/help/requests", { question: "How do I post to TikTok?", message: "Please add TikTok posting." }))) as { id: string; mailed: boolean };
    expect(sent.mailed).toBe(false);
    expect((await app("member").request("/api/studio/help/requests", {}, env)).status).toBe(403);
    const inbox = (await json(await app("admin").request("/api/studio/help/requests", {}, env))) as { open: number; items: { id: string; message: string; status: string }[] };
    expect(inbox).toMatchObject({ open: 1, items: [{ id: sent.id, message: "Please add TikTok posting.", status: "open" }] });
    expect((await postJson(app("admin"), env, `/api/studio/help/requests/${sent.id}`, { status: "done", reply: "Added: Connection → TikTok." })).status).toBe(200);
    const mine = (await json(await app("member").request("/api/studio/help/requests/mine", {}, env))) as { requests: { status: string; reply: string }[] };
    expect(mine.requests).toMatchObject([{ status: "done", reply: "Added: Connection → TikTok." }]);
  });

  it("mails the admins when Resend is set up", async () => {
    const env = await seed();
    await setSetting(env, RESEND_KEY_SETTING, "re_test_key");
    const mails: { to: string[]; subject: string; text: string }[] = [];
    const real = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url === "https://api.resend.com/emails") {
        mails.push(JSON.parse(String(init?.body)));
        return Response.json({ id: "mail_1" });
      }
      return real(input, init);
    });
    const sent = (await json(await postJson(app("member"), env, "/api/studio/help/requests", { question: "q", message: "Please add it." }))) as { mailed: boolean };
    expect(sent.mailed).toBe(true);
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ to: ["admin@test"], subject: "Studio request from member (via the assistant)" });
    expect(mails[0].text).toContain("Please add it.");
  });
});
