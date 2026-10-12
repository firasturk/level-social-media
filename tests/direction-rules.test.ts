import { describe, expect, it } from "vitest";
import {
  DEFAULT_DIRECTION_RULES,
  composeFixedRules,
  parseDirectionRules,
  ruleOn,
  storeDirectionRules,
} from "../shared/direction-rules";
import {
  buildEditorialPrompt,
  LIGHT_RULE,
  DETAIL_RULE,
  BLEND_RULE,
  GRAIN_RULE,
  POSE_RULE,
  ANATOMY_RULE,
} from "../shared/prompts";

describe("creative direction fixed rules", () => {
  it("numbers the enabled rules in the team's order", () => {
    const text = composeFixedRules(DEFAULT_DIRECTION_RULES);
    expect(text.startsWith("Fixed rules for every prompt")).toBe(true);
    expect(text).toContain("(1) OUTFIT:");
    expect(text).toContain("(15) COMPOSITION:");
    expect(text).toContain("POSE: write one coherent pose");
    expect(text).toContain("away from the face, forehead, hair and head");
    expect(text).toContain("FILM GRAIN:");
    expect(text).toContain("Catalogue-safe wording only");
    const fewer = composeFixedRules([
      { key: "a", title: "", text: "Rule A.", enabled: true },
      { key: "b", title: "", text: "Rule B;", enabled: false },
      { key: "c", title: "", text: "Rule C", enabled: true },
    ]);
    expect(fewer).toBe(
      "Fixed rules for every prompt (they override the skill's own direction, template and library, including any default framing such as full body): (1) Rule A; (2) Rule C.",
    );
    expect(composeFixedRules([])).toBe("");
  });

  it("reads a stored list and falls back to the defaults", () => {
    expect(parseDirectionRules(null)).toBe(DEFAULT_DIRECTION_RULES);
    expect(parseDirectionRules("nonsense")).toBe(DEFAULT_DIRECTION_RULES);
    const list = parseDirectionRules(
      JSON.stringify([{ key: "light", text: "Sun.", enabled: false }, { text: "Mine." }]),
    );
    // A plain stored array (older save) gets the built-ins it does not mention appended.
    expect(list.slice(0, 2)).toEqual([
      { key: "light", title: "", text: "Sun.", enabled: false },
      { key: "custom-2", title: "", text: "Mine.", enabled: true },
    ]);
    expect(list.map((r) => r.key)).toContain("grain");
    expect(ruleOn(list, "light")).toBe(false);
    expect(ruleOn(list, "detail")).toBe(true);
    expect(ruleOn(undefined, "detail")).toBe(true);
    // A removed built-in stays removed; a new built-in still appears.
    const kept = DEFAULT_DIRECTION_RULES.filter((r) => r.key !== "light" && r.key !== "grain");
    const stored = storeDirectionRules(kept);
    expect(stored.removed).toEqual(["light", "grain"]);
    // An untouched copy of an older wording is upgraded; an edited one is kept.
    const upgraded = parseDirectionRules(
      JSON.stringify([
        {
          key: "grain",
          title: "",
          text: "FILM GRAIN: every image carries a subtle, fine, even analog film grain over the whole frame, like a professionally scanned 35mm colour negative: fine organic grain visible in the midtones and shadows, slightly softened micro-contrast, a gentle bloom on the brightest sunlit edges and backlit hair, natural restrained colour; write this in the prompt's photographic treatment section as a delicate finishing texture that stays uniform across model and background, never heavy, never digital noise, never a vintage filter, never blur or loss of detail.",
          enabled: true,
        },
        { key: "light", title: "", text: "My own light rule.", enabled: true },
      ]),
    );
    expect(upgraded[0].text).toContain("ISO 400");
    expect(upgraded[0].title).toBe("Film grain");
    expect(upgraded[1].text).toBe("My own light rule.");
    const back = parseDirectionRules(JSON.stringify({ rules: kept, removed: ["light"] }));
    expect(back.map((r) => r.key)).not.toContain("light");
    expect(back.map((r) => r.key)).toContain("grain");
  });

  it("switches the engine-side rules with the list", () => {
    const full = buildEditorialPrompt("Body.", "", "", {}, false, true, "FULL_BODY", false, true);
    expect(full).toContain(LIGHT_RULE);
    expect(full).toContain(DETAIL_RULE);
    expect(full).toContain(BLEND_RULE);
    expect(full).toContain(GRAIN_RULE);
    expect(full).toContain(POSE_RULE);
    expect(full).toContain(ANATOMY_RULE);
    expect(
      buildEditorialPrompt("Body.", "", "", { set: true }, false, true, "FULL_BODY", false, true),
    ).toContain("the pose is the one written in the prompt, which differs from the sibling's pose");
    expect(
      buildEditorialPrompt("Body.", "", "", { mood: true }, false, true, "FULL_BODY", false, true),
    ).toContain("its stance was already turned into the written pose above");
    expect(full).toContain("hands in pockets");
    const off = buildEditorialPrompt(
      "Body.",
      "",
      "",
      {},
      false,
      true,
      "FULL_BODY",
      false,
      true,
      false,
      {
        light: false,
        detail: false,
        hands: false,
        tattoos: false,
        grain: false,
      },
    );
    expect(off).not.toContain(LIGHT_RULE);
    expect(off).not.toContain(GRAIN_RULE);
    expect(off).not.toContain("digital noise");
    expect(off).not.toContain(DETAIL_RULE);
    expect(off).toContain(BLEND_RULE);
    expect(off).not.toContain("overcast sky");
    expect(off).not.toContain("hands in pockets");
    expect(off).not.toContain("TATTOOS:");
    // The skill campaign ignores the flags entirely.
    const campaign = buildEditorialPrompt(
      "Body.",
      "",
      "",
      {},
      false,
      true,
      "FULL_BODY",
      false,
      false,
      false,
      {
        tattoos: false,
      },
    );
    expect(campaign).toContain("TATTOOS:");
  });
});
