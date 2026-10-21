import { describe, expect, it } from "vitest";
import { ideasChatInstruction, parseIdeasChat } from "@shared/ideas-chat";
import type { Post } from "@shared/posts";

const posts: Post[] = [
  { index: 1, type: "lifestyle", title: "Blue sign", brief: "A cup on a sign.", caption: "c1", hashtags: "#a", date: "2026-12-01", product: "Blue Curacao mojito" },
  { index: 2, type: "lifestyle", title: "Red sign", brief: "A cup on a red sign.", caption: "c2", hashtags: "#b", date: "2026-12-02" },
  { index: 3, type: "lifestyle", title: "Green sign", brief: "A cup on a green sign.", caption: "c3", hashtags: "#c", date: "2026-12-03" },
];
const products = ["Blue Curacao mojito", "Kiwi - Mojito", "Sakina avocado shake"];

describe("talk about the ideas", () => {
  it("shows the month, the products and the designer's words to the art director", () => {
    const text = ideasChatInstruction({ client: "Abu Saleh", month: "2026-12", posts, products: products.map((name) => ({ name, note: "" })), history: [{ role: "user", text: "hi", at: 1 }], message: "بوست ٣ خليه كيوي" });
    expect(text).toContain("#3 · 2026-12-03 · lifestyle");
    expect(text).toContain("- Kiwi - Mojito");
    expect(text).toContain("Designer: hi");
    expect(text).toContain('THE DESIGNER SAYS NOW: "بوست ٣ خليه كيوي"');
  });
  it("keeps only real posts, real products, dates inside the month and known types", () => {
    const a = parseIdeasChat(
      {
        reply: "غيّرت بوست ٣",
        actions: [
          { op: "update", index: 3, fields: { product: "kiwi mojito", caption: "new", date: "2027-01-05", type: "poster" } },
          { op: "update", index: 9, caption: "x" },
          { op: "remove", index: 2 },
          { op: "remove", index: 7 },
          { op: "add", fields: { title: "Mother's Day", date: "2026-12-21", brief: "A mother…", caption: "", hashtags: "", product: "Sakina" } },
          { op: "make", indexes: [1, 3, 8] },
        ],
      },
      posts,
      products,
      "2026-12",
    );
    expect(a.reply).toBe("غيّرت بوست ٣");
    expect(a.actions).toHaveLength(4);
    expect(a.actions[0]).toEqual({ op: "update", index: 3, fields: { product: "Kiwi - Mojito", caption: "new" } });
    expect(a.actions[1]).toEqual({ op: "remove", index: 2 });
    expect(a.actions[2].op).toBe("add");
    expect((a.actions[2] as { post: { product?: string; date?: string } }).post.product).toBe("Sakina avocado shake");
    expect((a.actions[2] as { post: { date?: string } }).post.date).toBe("2026-12-21");
    expect(a.actions[3]).toEqual({ op: "make", indexes: [1, 3] });
  });
  it("answers a question with no actions", () => {
    const a = parseIdeasChat({ reply: "Three posts carry mojitos.", actions: [] }, posts, products, "2026-12");
    expect(a.actions).toEqual([]);
    expect(a.notes).toBeUndefined();
  });
});
