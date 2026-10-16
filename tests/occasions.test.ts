import { describe, expect, it } from "vitest";
import { occasionsOf, pickedOccasions } from "@shared/occasions";
import { buildPostPrompt, ideasInstruction, offerReady, parseIdeas, singleIdeaInstruction, type Post, type PostBrief } from "@shared/posts";

describe("Jordan's occasions", () => {
  it("knows royal, national, religious and movable days", () => {
    const jan = occasionsOf("2027-01");
    const king = jan.find((o) => o.id === "king-birthday")!;
    expect(king.date).toBe("2027-01-30");
    expect(king.portrait).toBe(true);
    expect(occasionsOf("2027-03").map((o) => o.id)).toEqual(expect.arrayContaining(["easter", "mothers-day", "karameh"]));
    expect(occasionsOf("2027-03").find((o) => o.id === "easter")!.date).toBe("2027-03-28");
    expect(occasionsOf("2027-05").find((o) => o.id === "orthodox-easter")!.date).toBe("2027-05-02");
    expect(occasionsOf("2026-11").find((o) => o.id === "black-friday")!.date).toBe("2026-11-27");
    expect(occasionsOf("2027-02").map((o) => o.id)).toContain("ramadan");
  });

  it("posts only the picked occasions and the team's own", () => {
    const list = pickedOccasions("2026-05", {
      picked: ["independence"],
      custom: [{ id: "c-x1", date: "2026-05-10", name: "Branch opening" }],
    });
    expect(list.map((o) => o.id)).toEqual(["c-x1", "independence"]);
  });
});

const ideasBase = {
  clientName: "Habibah",
  tone: "",
  dos: "",
  donts: "",
  language: "ar" as const,
  palette: [],
  style: "",
  themeTitle: "",
  themeDirection: "",
  products: ["Mini Tart"],
  month: "2027-01",
  count: 6,
};

describe("post types", () => {
  it("defaults to lifestyle with the product and greets picked occasions", () => {
    const text = ideasInstruction({
      ...ideasBase,
      occasions: [{ id: "king-birthday", date: "2027-01-30", name: "King Abdullah II's birthday", elements: "flag colours", portrait: true }],
    });
    expect(text).toContain('every post is "lifestyle"');
    expect(text).toContain('Never write "offer" posts');
    expect(text).toContain('occasion "king-birthday"');
    expect(text).toContain("ROYAL DAY: no product and no person");
  });

  it("never lets the writer invent an offer", () => {
    const [p] = parseIdeas(JSON.stringify({ posts: [{ type: "offer", title: "T", brief: "B", caption: "", hashtags: "" }] }), 1, []);
    expect(p.type).toBe("lifestyle");
  });

  it("writes an offer exactly as the designer set it", () => {
    const post: Post = {
      index: 3,
      type: "offer",
      title: "T",
      brief: "B",
      caption: "",
      hashtags: "",
      offer: { products: ["Mini Tart", "Kunafa"], price: "15 JD", details: "Two boxes for the weekend" },
    };
    expect(offerReady(post.offer)).toBe(true);
    expect(offerReady({ products: [], price: "1", details: "x" })).toBe(false);
    const t = singleIdeaInstruction({ ...ideasBase, count: 1 }, post, [], "");
    expect(t).toContain("products Mini Tart, Kunafa; price 15 JD");
  });

  it("leaves room for the official portrait and keeps packaging and genders", () => {
    const b = {
      post: true,
      index: 1,
      type: "greeting",
      title: "King's birthday",
      brief: "A greeting.",
      palette: [],
      style: "",
      theme: "",
      format: "4:5",
      ref: null,
      refIsSource: false,
      hasProduct: false,
      occasion: { name: "King Abdullah II's birthday", elements: "flag colours", portrait: true },
    } as PostBrief;
    const p = buildPostPrompt(b);
    expect(p).toContain("an official portrait is placed there later");
    expect(p).toContain("No person, face");
    const withProduct = buildPostPrompt({ ...b, type: "lifestyle", occasion: undefined, hasProduct: true, ambassadors: [{ name: "Khalif", description: "man", key: "k" }] } as PostBrief);
    expect(withProduct).toContain("a closed box keeps its printed lid on");
    expect(withProduct).toContain("a headscarf or hijab");
  });
});

describe("a post without a product photo", () => {
  it("never invents packaging", () => {
    const p = buildPostPrompt({
      post: true,
      index: 5,
      type: "behind",
      title: "The craft of gifting",
      brief: "Hands carry the silver 56 - Assorted Arabic Sweets (Elite) box.",
      palette: [],
      style: "",
      theme: "",
      format: "4:5",
      ref: "r1",
      refIsSource: true,
      hasProduct: false,
      productNames: ["56 - Assorted Arabic Sweets (Elite) - Assorted Arabic Sweets (Elite)"],
    } as PostBrief);
    expect(p).toContain("NO PRODUCT PHOTO");
    expect(p).not.toContain("Assorted Arabic Sweets");
  });
});

describe("size, grip and colours of the product", () => {
  it("keeps real size, a real grip, its own colours and no bags", () => {
    const p = buildPostPrompt({
      post: true,
      index: 6,
      type: "lifestyle",
      title: "Carrying Habibah home",
      brief: "A person carries the tray. The tray sits inside a white paper bag. Warm light.",
      palette: ["deep blue #0042aa"],
      paletteChosen: true,
      style: "",
      theme: "",
      format: "4:5",
      ref: null,
      refIsSource: false,
      hasProduct: true,
    } as PostBrief);
    expect(p).toContain("TRUE SIZE AND GRIP");
    expect(p).toContain("never put into a bag");
    expect(p).toContain("a silver tin stays silver on a blue wall");
    expect(p).not.toContain("white paper bag");
    expect(p).toContain("Warm light.");
  });
});

describe("captions", () => {
  it("are at most 15 words", async () => {
    const { shortCaption } = await import("@shared/posts");
    expect(shortCaption("حلاوة الصبح بلمسة حبيبه. جربوها مع القهوة واحكولنا رأيكم. متوفرة بكل فروعنا ومستنيينكم بأحلى عروض الموسم مع أهلكم وحبايبكم.")).toBe(
      "حلاوة الصبح بلمسة حبيبه. جربوها مع القهوة واحكولنا رأيكم.",
    );
    expect(shortCaption("one two three")).toBe("one two three");
    expect(shortCaption(Array.from({ length: 30 }, (_, i) => `w${i}`).join(" ")).split(" ").length).toBe(15);
  });
});
