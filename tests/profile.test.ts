import { describe, expect, it } from "vitest";
import { parseProfile, profileBrief, profileInstruction } from "@shared/profile";
import { captionFromImageInstruction, ideasInstruction, type Post } from "@shared/posts";

const raw = {
  summary: "A Jordanian sweets house since 1951.",
  audience: "Families in Amman buying for gatherings.",
  offer: { products: ["kunafa", "gift tins"], services: [], heroes: ["Nabulsi kunafa"] },
  tone: { description: "Warm, short, proud", dialect: "Jordanian", examples: ["حلاوة الصبح"], keep: ["pride"], improve: ["shorter headlines"] },
  branding: { colours: ["Navy #0b2a4a"], type: "Arabic calligraphy", packaging: "navy tins", photography: "warm light" },
  content: { pillars: ["product 60%"], works: ["kunafa close-ups"], weak: ["text-only posts"], rhythm: "daily" },
  refs: [{ name: "Brand X", kind: "competitor", strengths: ["reels"], gaps: ["no heritage story"], takeaways: ["own the heritage"] }],
  direction: "Lead with heritage and generosity.",
  tips: { headlines: ["2-4 words, Jordanian"], captions: ["one warm line"], design: ["one product hero"] },
  gridQueries: ["arabic sweets instagram feed"],
};

describe("client profile", () => {
  it("reads the model's answer and refuses an empty one", () => {
    const p = parseProfile(raw)!;
    expect(p.tone.dialect).toBe("Jordanian");
    expect(p.refs[0].gaps).toEqual(["no heritage story"]);
    expect(parseProfile({})).toBeNull();
  });

  it("tells the reader to study other brands, never copy them", () => {
    const ins = profileInstruction({
      clientName: "Habibah",
      brandKit: { tone: "", dos: "", donts: "", style: "", colours: [] },
      accounts: [
        { name: "Habibah", kind: "client", images: 9, instagram: { username: "habibah", bio: "since 1951", followers: 1000, posts: [{ caption: "حلاوة", likes: 10, comments: 1, type: "IMAGE", date: "2026-10-01" }] } },
        { name: "Brand X", kind: "competitor", images: 3 },
      ],
    });
    expect(ins).toContain("Images 1 to 9");
    expect(ins).toContain("Images 10 to 12");
    expect(ins).toContain("never suggest copying");
  });

  it("steers the ideas and the captions", () => {
    const brief = profileBrief(parseProfile(raw));
    expect(brief).toContain("Headline rules: 2-4 words, Jordanian");
    const ideas = ideasInstruction({
      clientName: "Habibah", tone: "", dos: "", donts: "", language: "ar", palette: [], style: "", themeTitle: "", themeDirection: "",
      products: [], month: "2026-10", count: 4, profile: brief,
    });
    expect(ideas).toContain("CLIENT PROFILE");
    const post: Post = { index: 1, type: "lifestyle", title: "T", brief: "B", caption: "", hashtags: "" };
    expect(captionFromImageInstruction({ clientName: "Habibah", tone: "", language: "ar", post, products: [], profile: brief })).toContain("Caption rules: one warm line");
  });
});
