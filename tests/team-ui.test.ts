import { describe, expect, it } from "vitest";
import type { Channel, Message, TeamUser } from "../shared/team";
import { QUICK_EMOJI } from "../shared/team";
import {
  aiQuestion,
  channelTitle,
  dueState,
  EMOJI_GRID,
  groupChannels,
  groupMessages,
  insertMention,
  LEVEL_AI,
  matchUsers,
  mentionQuery,
  mergeChannels,
  mergeMessages,
  nextBackoff,
  nextCursor,
  readChannel,
  SYNC_FAST,
  SYNC_MAX,
  tokenizeBody,
  unreadOf,
} from "../shared/team-ui";

const firas: TeamUser = { id: "u1", name: "Firas Haddad", email: "f@x", role: "admin" };
const lina: TeamUser = { id: "u2", name: "Lina Saad", email: "l@x", role: "member" };
const msg = (p: Partial<Message> & { id: string; at: number }): Message => ({
  channel: "general",
  thread: null,
  author: firas,
  kind: "text",
  body: "hi",
  attachments: [],
  mentions: [],
  reactions: [],
  replies: 0,
  pinned: false,
  ...p,
});
const T0 = new Date(2026, 9, 28, 10, 0, 0).getTime();
const MIN = 60_000;

describe("message grouping", () => {
  it("opens every day with a divider and collapses one person's run within five minutes", () => {
    const rows = groupMessages([
      msg({ id: "a", at: T0 }),
      msg({ id: "b", at: T0 + 2 * MIN }),
      msg({ id: "c", at: T0 + 9 * MIN }),
      msg({ id: "d", at: T0 + 10 * MIN, author: lina }),
      msg({ id: "e", at: T0 + 36 * 60 * MIN }),
    ]);
    expect(rows.map((r) => (r.kind === "message" ? `${r.message.id}${r.collapsed ? "+" : ""}` : r.kind))).toEqual(["day", "a", "b+", "c", "d", "day", "e"]);
  });
  it("never collapses onto a system or deleted message, and puts 'New messages' before the first unread by someone else", () => {
    const rows = groupMessages(
      [msg({ id: "s", at: T0, kind: "system" }), msg({ id: "a", at: T0 + MIN }), msg({ id: "b", at: T0 + 2 * MIN, deleted: true }), msg({ id: "c", at: T0 + 3 * MIN }), msg({ id: "mine", at: T0 + 4 * MIN }), msg({ id: "theirs", at: T0 + 5 * MIN, author: lina })],
      { lastRead: T0 + 3 * MIN, me: "u1" },
    );
    expect(rows.map((r) => (r.kind === "message" ? `${r.message.id}${r.collapsed ? "+" : ""}` : r.kind))).toEqual(["day", "s", "a", "b+", "c", "mine+", "unread", "theirs"]);
  });
  it("shows no unread line when every unread message is my own", () => {
    const rows = groupMessages([msg({ id: "a", at: T0 }), msg({ id: "b", at: T0 + MIN })], { lastRead: T0, me: "u1" });
    expect(rows.some((r) => r.kind === "unread")).toBe(false);
  });
});

describe("mentions and links in a body", () => {
  it("tokenizes mentions, links (without trailing punctuation) and line breaks", () => {
    const t = tokenizeBody("Hi @[Lina Saad](u2), see https://example.com/a). \nثانيًا @[Level AI](level-ai)");
    expect(t).toEqual([
      { t: "text", v: "Hi " },
      { t: "mention", name: "Lina Saad", id: "u2" },
      { t: "text", v: ", see " },
      { t: "link", href: "https://example.com/a" },
      { t: "text", v: "). " },
      { t: "br" },
      { t: "text", v: "ثانيًا " },
      { t: "mention", name: "Level AI", id: "level-ai" },
    ]);
  });
  it("finds the @query under the caret and replaces it with the token", () => {
    expect(mentionQuery("hello @li", 9)).toEqual({ start: 6, q: "li" });
    expect(mentionQuery("mail me@x", 9)).toBeNull();
    expect(mentionQuery("done @[Lina Saad](u2) ", 22)).toBeNull();
    const r = insertMention("hello @li there", 9, lina);
    expect(r.text).toBe("hello @[Lina Saad](u2)  there");
    expect(r.caret).toBe("hello @[Lina Saad](u2) ".length);
  });
  it("matches people by the start of their name first and always offers the assistant", () => {
    expect(matchUsers([firas, lina], "l").map((u) => u.id)).toEqual(["u2", "level-ai"]);
    expect(matchUsers([firas, lina], "sa").map((u) => u.id)).toEqual(["u2"]);
    expect(matchUsers([firas, lina], "").map((u) => u.id)).toEqual(["u1", "u2", LEVEL_AI.id]);
  });
  it("recognises a question to Level AI and strips the mention", () => {
    expect(aiQuestion("@[Level AI](level-ai) pending tasks for Abu Saleh")).toBe("pending tasks for Abu Saleh");
    expect(aiQuestion("@[Lina Saad](u2) can you check?")).toBeNull();
  });
  it("has a quick row of eight and a grid of sixty distinct emoji", () => {
    expect(QUICK_EMOJI).toHaveLength(8);
    expect(new Set(EMOJI_GRID).size).toBe(60);
  });
});

describe("merging a sync into the caches", () => {
  const cache = [msg({ id: "a", at: 1 }), msg({ id: "b", at: 3 })];
  it("replaces rows by id, inserts new ones in time order, and keeps the array when nothing changed", () => {
    const next = mergeMessages(cache, [msg({ id: "c", at: 2 }), msg({ id: "b", at: 3, body: "edited", edited: 4 })]);
    expect(next.map((m) => m.id)).toEqual(["a", "c", "b"]);
    expect(next[2].body).toBe("edited");
    expect(mergeMessages(cache, [cache[0]])).toBe(cache);
    expect(mergeMessages(cache, [])).toBe(cache);
  });
  const channels: Channel[] = [
    { id: "general", kind: "general", name: "general", client: null, unread: 2, mentioned: false, lastAt: 10, archived: false },
    { id: "c1", kind: "client", name: "Abu Saleh", client: "abu", unread: 0, mentioned: false, lastAt: 5, archived: false },
    { id: "old", kind: "project", name: "Old", client: null, unread: 7, mentioned: true, lastAt: 1, archived: true },
  ];
  it("applies the sync's counts to the channels it names and leaves the rest", () => {
    const next = mergeChannels(channels, [{ id: "c1", unread: 3, mentioned: true, lastAt: 20 }]);
    expect(next[1]).toMatchObject({ unread: 3, mentioned: true, lastAt: 20 });
    expect(next[0]).toBe(channels[0]);
    expect(mergeChannels(channels, [{ id: "general", unread: 2, mentioned: false, lastAt: 10 }])).toBe(channels);
  });
  it("counts unread across live channels plus unseen notifications, and reading a channel clears it", () => {
    expect(unreadOf(channels, 1)).toBe(3);
    const read = readChannel(channels, "general");
    expect(read[0]).toMatchObject({ unread: 0, mentioned: false });
    expect(unreadOf(read)).toBe(0);
  });
  it("groups the navigation and names a dm after the other person", () => {
    const dm: Channel = { id: "d", kind: "dm", name: "", client: null, unread: 0, mentioned: false, lastAt: 2, archived: false, members: [firas, lina] };
    const g = groupChannels([...channels, dm]);
    expect(g.general.map((c) => c.id)).toEqual(["general"]);
    expect(g.clients.map((c) => c.id)).toEqual(["c1"]);
    expect(g.projects).toEqual([]);
    expect(g.dms.map((c) => c.id)).toEqual(["d"]);
    expect(channelTitle(dm, "u1")).toBe("Lina Saad");
    expect(channelTitle(dm, "u2")).toBe("Firas Haddad");
  });
});

describe("the sync cursor and its back-off", () => {
  it("only moves the cursor forward", () => {
    expect(nextCursor(100, { cursor: 150 })).toBe(150);
    expect(nextCursor(200, { cursor: 150 })).toBe(200);
    expect(nextCursor(200, { cursor: 0 })).toBe(200);
  });
  it("doubles the wait after a failure up to thirty seconds", () => {
    const waits = [SYNC_FAST];
    for (let i = 0; i < 5; i++) waits.push(nextBackoff(waits[i]));
    expect(waits).toEqual([4000, 8000, 16000, 30000, 30000, 30000]);
    expect(nextBackoff(1000)).toBe(8000);
    expect(SYNC_MAX).toBe(30000);
  });
});

describe("due dates", () => {
  const now = new Date(2026, 9, 28, 15, 0).getTime();
  it("tells overdue, today, this week and later apart", () => {
    expect(dueState("2026-10-27", now)).toBe("overdue");
    expect(dueState("2026-10-28", now)).toBe("today");
    expect(dueState("2026-11-02", now)).toBe("soon");
    expect(dueState("2026-12-01", now)).toBe("later");
    expect(dueState(null, now)).toBeNull();
  });
});
