import { describe, expect, it } from "vitest";
import { castLook, childOf } from "../shared/cast";
import { buildPostPrompt, photoRules, withoutWordsSentences, type PostBrief } from "../shared/posts";
import { lessonLine } from "../shared/qa";

describe("the words of a design never reach the picture", () => {
  it("drops headline and swipe sentences from a brief or a shot", () => {
    expect(
      withoutWordsSentences(
        "Kinan leans forward against a white wall with black paint splatters, wearing the light grey 'BORN TO PARTY' sweatshirt. The lighting is studio-bright, and the headline 'Be Silly.' is centered over the roller-skating cake graphic.",
      ),
    ).toBe("Kinan leans forward against a white wall with black paint splatters, wearing the light grey 'BORN TO PARTY' sweatshirt.");
    expect(withoutWordsSentences("He wears a red paper cape. The headline is centered across his chest. The mood is heroic.")).toBe(
      "He wears a red paper cape. The mood is heroic.",
    );
  });
  it("keeps caption, language and swipe rules out of the photograph's client rules", () => {
    expect(
      photoRules(
        "Use paper-cutout digital elements for a 'scrapbook' look.\nAlways include a 'Swipe' indicator for carousels.\nAvoid overly formal MSA; stick to friendly Levantine.\nKeep backgrounds uncluttered.",
      ),
    ).toBe("Use paper-cutout digital elements for a 'scrapbook' look.\nKeep backgrounds uncluttered.");
  });
});

describe("a child in the designer's words wins over the adult gender", () => {
  it("reads girl, boy and child", () => {
    expect(childOf("6 years old little girl with happy cute face")).toBe("girl");
    expect(childOf("8 years boy")).toBe("boy");
    expect(childOf("a 4 year old kid")).toBe("child");
    expect(childOf("tall man with a beard")).toBe("");
  });
  it("describes a girl saved as a man as a girl, without the man's dress rules", () => {
    const look = castLook({ description: "6 years old little girl with happy cute face", gender: "man" });
    expect(look).toContain("a little girl (child model)");
    expect(look).not.toContain("a man");
    expect(look).not.toContain("never wears a headscarf");
    expect(castLook({ description: "8 years boy", gender: "man" })).toContain("a little boy (child model)");
    expect(castLook({ description: "tall, calm", gender: "man" })).toBe("a man; tall, calm; never wears a headscarf, a hijab, a veil, a dress or a skirt");
  });
});

describe("lessons from earlier pictures", () => {
  it("words a review finding as a rule", () => {
    expect(lessonLine("text", 'Writing in the picture: "BE SILLY.", "Swipe ->"')).toMatch(/^No writing: an earlier picture carried "BE SILLY\.", "Swipe ->"\./);
    expect(lessonLine("ailook", "Looks AI-made: The child has airbrushed skin.")).toContain("an earlier picture the child has airbrushed skin");
    expect(lessonLine("people", "The post shows a young boy instead of a 6-year-old girl.")).toContain("a young boy instead of a 6-year-old girl");
  });
  it("puts the lessons and the children rule into the prompt", () => {
    const b: PostBrief = {
      post: true,
      take: 1,
      index: 1,
      type: "lifestyle",
      title: "Silly Party",
      brief: "Kinan stands by a wall. The headline is centered over the sweatshirt graphic.",
      palette: [],
      style: "",
      theme: "",
      format: "4:5",
      hasProduct: true,
      ambassadors: [{ name: "Kinan", description: "a little boy (child model); 8 years boy", key: "k" }],
      lessons: [lessonLine("text", 'Writing in the picture: "Swipe ->"')],
    } as unknown as PostBrief;
    const prompt = buildPostPrompt(b);
    expect(prompt).toContain("MISTAKES SEEN IN EARLIER PICTURES FOR THIS CLIENT");
    expect(prompt).toContain('- No writing: an earlier picture carried "Swipe ->"');
    expect(prompt).toContain("CHILDREN: the child looks like a real photographed child");
    expect(prompt).not.toContain("The headline is centered");
  });
});
