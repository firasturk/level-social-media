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
import { clipPrompt } from "../server/campaign-runner";

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
