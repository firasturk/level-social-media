/**
 * The editor's undo stacks and its recoverable autosave (phase 2), as pure rules: a drag is one
 * undo step, a commit that changes nothing records nothing; the local copy is offered back only
 * when it differs from the server's draft and is newer than its last save, with a warning when
 * the draft was saved again since; copies are written, capped and set aside, never sent.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { newClip, newProject } from "../shared/video-project";
import { HistoryStacks, MAX_HISTORY } from "../shared/video-history";
import { clearDraft as clear, draftKey, draftTime, MAX_DRAFTS, readDraft as read, recoveryOffer, setDraftAside as aside, writeDraft as write, type DraftStore, type LocalDraft } from "../shared/video-drafts";

describe("undo and redo", () => {
  it("records one step per commit and none for a commit that changes nothing", () => {
    const h = new HistoryStacks<string>();
    expect(h.commit("a", "b")).toBe(true);
    expect(h.commit("b", "b")).toBe(false);
    expect(h.past).toEqual(["a"]);
    expect(h.undo("b")).toBe("a");
    expect(h.redo("a")).toBe("b");
    expect(h.undo("b")).toBe("a");
    expect(h.undo("a")).toBeNull();
    // A new change after an undo drops the redo stack.
    h.commit("a", "c");
    expect(h.future).toEqual([]);
  });
  it("makes a whole drag (mark, patches, commit) one step, and an empty drag none", () => {
    const h = new HistoryStacks<string>();
    h.mark("start");
    // ...patches move the document to "dragged" without steps...
    expect(h.commit("dragged", "dragged")).toBe(true);
    expect(h.past).toEqual(["start"]);
    expect(h.undo("dragged")).toBe("start");
    const g = new HistoryStacks<string>();
    g.mark("same");
    g.commit("same", "same");
    expect(g.past).toEqual([]);
  });
  it("keeps at most MAX_HISTORY steps", () => {
    const h = new HistoryStacks<number>();
    for (let i = 0; i < MAX_HISTORY + 20; i++) h.commit(i, i + 1);
    expect(h.past.length).toBe(MAX_HISTORY);
    expect(h.past[0]).toBe(20);
  });
});

describe("autosave recovery", () => {
  const server = { ...newProject("Cut", 1000), rev: 4, clips: [newClip({ kind: "version", batch: "b", videoId: "v" }, 5, "a")] };
  const local = (patch: Partial<LocalDraft> = {}): LocalDraft => ({ key: "k", projectId: "p1", rev: 4, savedAt: 5000, project: { ...server, name: "Changed" }, ...patch });
  it("offers a copy newer than the server's save and different from it", () => {
    expect(recoveryOffer(local(), { id: "p1", rev: 4, updated: 4000, document: server })).toEqual({ offer: true, stale: false });
  });
  it("does not offer a copy that is older, the same, or another project's", () => {
    expect(recoveryOffer(local({ savedAt: 3000 }), { id: "p1", rev: 4, updated: 4000, document: server }).offer).toBe(false);
    expect(recoveryOffer(local({ project: { ...server, rev: 9, updatedAt: 77 } }), { id: "p1", rev: 4, updated: 4000, document: server }).offer).toBe(false);
    expect(recoveryOffer(local({ projectId: "other" }), { id: "p1", rev: 4, updated: 4000, document: server }).offer).toBe(false);
    expect(recoveryOffer(null, { id: "p1", rev: 4, updated: 4000, document: server }).offer).toBe(false);
  });
  it("warns when the draft was saved again after the copy's revision", () => {
    expect(recoveryOffer(local({ rev: 3 }), { id: "p1", rev: 4, updated: 4000, document: server })).toEqual({ offer: true, stale: true });
  });
  it("offers a never-saved cut's copy when it has something on it", () => {
    expect(recoveryOffer(local({ projectId: null }), null).offer).toBe(true);
    expect(recoveryOffer(local({ projectId: null, project: newProject("Empty") }), null).offer).toBe(false);
  });
  it("keys copies by project, or by post for a cut never saved", () => {
    expect(draftKey({ batch: "b1", index: 2 }, "p9")).toBe("lsm-video-draft:p9");
    expect(draftKey({ batch: "b1", index: 2 }, null)).toBe("lsm-video-draft:new:b1:2");
    expect(draftTime(new Date(2026, 9, 23, 14, 5).getTime(), new Date(2026, 9, 23, 18, 0).getTime())).toBe("14:05");
    expect(draftTime(new Date(2026, 9, 21, 9, 30).getTime(), new Date(2026, 9, 23, 18, 0).getTime())).toBe("21 Oct, 09:30");
  });

  describe("in local storage", () => {
    const store = new Map<string, string>();
    const fake: DraftStore = {
      get length() {
        return store.size;
      },
      key: (i: number) => [...store.keys()][i] ?? null,
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const writeDraft = (d: LocalDraft) => write(fake, d);
    const readDraft = (k: string) => read(fake, k);
    const clearDraft = (k: string) => clear(fake, k);
    const setDraftAside = (k: string) => aside(fake, k);
    beforeEach(() => store.clear());
    it("does nothing without a storage (private window, blocked site data)", () => {
      expect(write(null, local())).toBe(false);
      expect(read(null, "k")).toBeNull();
    });
    it("writes, reads, sets aside and clears a copy", () => {
      const d = local({ key: draftKey({ batch: "b", index: 1 }, "p1") });
      expect(writeDraft(d)).toBe(true);
      expect(readDraft(d.key)).toEqual(d);
      setDraftAside(d.key);
      expect(readDraft(d.key)).toBeNull();
      expect(store.has(`${d.key}:declined`)).toBe(true);
      writeDraft(d);
      clearDraft(d.key);
      expect(readDraft(d.key)).toBeNull();
    });
    it("keeps only the newest copies", () => {
      for (let i = 0; i < MAX_DRAFTS + 3; i++) writeDraft(local({ key: `lsm-video-draft:p${i}`, projectId: `p${i}`, savedAt: 1000 + i }));
      const keys = [...store.keys()].filter((k) => k.startsWith("lsm-video-draft:"));
      expect(keys.length).toBe(MAX_DRAFTS);
      expect(keys).not.toContain("lsm-video-draft:p0");
    });
  });
});
