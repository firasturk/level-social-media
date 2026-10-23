/**
 * The first live Campaign Autopilot run (Abu Saleh, 23 Oct): Higgsfield answered with a recommended
 * preset instead of starting the clips, Magnific's "Change camera" got no angle, the people in the
 * shots were not the brand's cast. These pin the fixes.
 */
import { describe, expect, it } from "vitest";
import { magnificOptionArgs, CAMERA_MOVES } from "../server/photo-tools";
import { declinedPresetIn } from "../server/higgsfield-mcp";
import { photoTool } from "../shared/photo-tools";
import { campaignInstruction, peopleRule, showsPeople } from "../shared/campaign-planner";
import { defaultSetup } from "../shared/campaign-plan";
import { clipPrompt, framePrompt, redoNote } from "../server/campaign-runner";

describe("Magnific Change camera", () => {
  it("moves the camera with rotate, vertical and closeup (the tool takes no angle name)", () => {
    const tool = photoTool("mg-camera")!;
    const params = ["creationIdentifier", "rotate", "vertical", "closeup", "folderReference"];
    for (const [angle, move] of Object.entries(CAMERA_MOVES)) {
      const r = magnificOptionArgs(tool, params, { camera: angle });
      expect(r.args).toEqual(move);
      expect(r.notes).toEqual([]);
    }
    expect(new Set(Object.values(CAMERA_MOVES).map((m) => JSON.stringify(m))).size).toBe(Object.keys(CAMERA_MOVES).length);
  });
});

describe("Higgsfield recommends a preset instead of starting the clip", () => {
  it("reads the preset id to decline", () => {
    const text = 'Submitted 0/1 video generations.\n- index 0: submission_failed — Preset "IN THE DARK" was recommended instead of submitting a job. Retry this index with declined_preset_id=24bae836-2c4a-48e0-89b6-49fcc0b21612.\nWait for the complete requested set with jobs_wait';
    expect(declinedPresetIn({ isError: false, content: [{ type: "text", text }] } as never)).toBe("24bae836-2c4a-48e0-89b6-49fcc0b21612");
    expect(declinedPresetIn({ isError: false, content: [{ type: "text", text: "Submitted 1/1 video generations. job_ids: [x]" }] } as never)).toBeNull();
  });
});

describe("only the brand's cast appears", () => {
  const men = [
    { name: "omar", gender: "man", modest: true },
    { name: "khaled", gender: "man", modest: true },
  ];
  it("a cast of men means men only, not even a woman's hand", () => {
    expect(peopleRule(men)).toMatch(/omar \(man, dressed modestly\), khaled/);
    expect(peopleRule(men)).toMatch(/never a woman or a girl, not even a woman's hand/);
    expect(peopleRule([])).toMatch(/no cast/);
  });
  it("the planner is told the cast and the approved brand rules", () => {
    const text = campaignInstruction({ setup: defaultSetup(), brand: { name: "Abu Saleh", tone: "", audience: "", language: "ar", dos: "", donts: "", style: "" }, products: [], media: [], references: [], looks: [], month: "2026-11", cast: men, rules: ["Never show women or girls."] });
    expect(text).toMatch(/PEOPLE: only the brand's cast/);
    expect(text).toMatch(/APPROVED RULES AND LESSONS[\s\S]*- Never show women or girls\./);
  });
  it("each clip prompt says who may appear", () => {
    const shot = { key: "s1", seconds: 4, action: "A hand reaching for the cup", framing: "close-up", camera: "static", reference: null, source: "start-image" as const, asset: null, text: "" };
    const v = { product: null } as never;
    expect(clipPrompt(v, shot, men)).toMatch(/People: only the brand's cast may appear: omar.*Men only/);
    expect(showsPeople("شاب يمسك كوب")).toBe(true);
    expect(showsPeople("A hand reaching for the cup")).toBe(true);
    expect(showsPeople("Ice cubes falling into the cup")).toBe(false);
  });
});

describe("each shot gets its own starting picture (23 Oct: four shots came out as one picture)", () => {
  const men = [{ name: "omar", gender: "man", modest: true }];
  const shot = { key: "s2", seconds: 4, action: "Omar pours the smoothie into a cup on the dashboard", framing: "medium shot", camera: "low angle from the passenger seat", reference: null, source: "start-image" as const, asset: null, text: "" };
  const v = { concept: "A cold smoothie on a hot drive", frame: "9:16", product: { name: "Sakina Mango", id: "p1", from: "library" } } as never;
  it("the prompt is the shot's own moment and camera, in the key frame's world, with the cast and the brand rules", () => {
    const p = framePrompt(v, shot, { cast: men, rules: ["Never show a woman, not even her hand."], productPhoto: true });
    expect(p).toMatch(/THIS SHOT: Omar pours the smoothie/);
    expect(p).toMatch(/Camera position for this moment: low angle from the passenger seat/);
    expect(p).toMatch(/do not copy the key frame's composition/);
    expect(p).toMatch(/The second image is the product itself: keep Sakina Mango exactly/);
    expect(p).toMatch(/People: only the brand's cast/);
    expect(p).toMatch(/Brand rules \(never break them\): Never show a woman/);
    expect(p).toMatch(/Vertical 9:16 photograph/);
  });
  it("Make again carries the admin's words, else what the automatic check found", () => {
    expect(redoNote({ data: JSON.stringify({ note: "No third hand" }), note: null })).toBe("No third hand");
    expect(redoNote({ data: null, note: "The automatic check asks you to look: A third hand is reaching for the cup." })).toBe("Fix what the check found on the last picture: A third hand is reaching for the cup.");
    expect(redoNote({ data: null, note: "Made by gemini-3-pro-image" })).toBe("");
    expect(framePrompt(v, shot, { note: "No third hand" })).toMatch(/Fix this from the last try: No third hand/);
  });
});
