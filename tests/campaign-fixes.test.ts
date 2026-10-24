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
    expect(p).toMatch(/The second image is the product itself, and it wins over the key frame: keep Sakina Mango exactly as that photo shows it/);
    expect(p).toMatch(/no mint or other garnish, no straw, no lid/);
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

describe("a card with its own format is made in that format (23 Oct: a Reel's key frame came out 4:5)", () => {
  it("a 9:16 card in a 4:5 month gets the 9:16 ratio; other cards keep the month's", async () => {
    const { taskConfig } = await import("../server/engine");
    const { postConfig } = await import("../shared/config");
    const config = postConfig("c1", "2026-10", { format: "4:5", ratio: "4:5", plan: [{ index: 1, type: "product", title: "", brief: "", caption: "", hashtags: "" }, { index: 2, type: "product", title: "", brief: "", caption: "", hashtags: "", format: "9:16" }] } as never);
    expect(taskConfig(config, { post: 2, model: null }).ratio).toBe("9:16");
    expect(taskConfig(config, { post: 1, model: null }).ratio).toBe(config.ratio);
    expect(taskConfig(config, { post: 2, model: "gemini-3-pro-image" })).toMatchObject({ ratio: "9:16", model: "gemini-3-pro-image" });
  });
});

describe("the people in a shot are the cast, photographed (24 Oct: shot 4 gave Omar and Khaled one face, and looked AI-made)", () => {
  it("each named person gets his portrait, two people never share a face, the real-people rules and a real photo for realism", () => {
    const shot = { key: "s4", seconds: 4, action: "Khaled and Omar laughing by the car", framing: "medium", camera: "orbit left", reference: null, source: "start-image" as const, asset: null, text: "" };
    const v = { concept: "A car ride", frame: "9:16", product: null } as never;
    const p = framePrompt(v, shot, { faces: [{ name: "khaled", image: 3 }, { name: "omar", image: 4 }], realRef: 5 });
    expect(p).toMatch(/Image 3 is khaled's portrait/);
    expect(p).toMatch(/Image 4 is omar's portrait/);
    expect(p).toMatch(/khaled and omar are different people with different faces: never give two people the same face, never twins/);
    expect(p).toMatch(/REAL PEOPLE: every person looks photographed/);
    expect(p).toMatch(/Image 5 is a real photograph of a real person/);
  });
});

describe("the audience is Muslim: no toasting (24 Oct)", () => {
  it("every people rule, the shot prompts and the month's pictures say no clinking cups", async () => {
    expect(peopleRule([])).toMatch(/never show people toasting or clinking cups/);
    expect(peopleRule([{ name: "omar", gender: "man", modest: true }])).toMatch(/no 'cheers'/);
    const shot = { key: "s4", seconds: 4, action: "Omar and Khaled laughing, holding their cups", framing: "medium", camera: "static", reference: null, source: "start-image" as const, asset: null, text: "" };
    expect(clipPrompt({ product: null } as never, shot, [{ name: "omar", gender: "man", modest: true }])).toMatch(/toasting or clinking/);
    expect(framePrompt({ concept: "x", frame: "9:16", product: null } as never, shot, { cast: [{ name: "omar", gender: "man", modest: true }] })).toMatch(/toasting or clinking/);
  });
});

describe("the approved picture is the clip's first frame (24 Oct: Higgsfield read role 'image' as a reference)", () => {
  it("start_image wherever the engine takes it or the catalog does not say", async () => {
    const { pictureRole, parseModels } = await import("../server/higgsfield-mcp");
    expect(pictureRole({ roles: ["audio_references", "end_image", "image_references", "start_image"] })).toBe("start_image");
    expect(pictureRole({})).toBe("start_image");
    expect(pictureRole({ roles: ["image"] })).toBe("image");
    const models = parseModels({ content: [{ type: "text", text: JSON.stringify({ items: [{ id: "seedance_2_5", name: "Seedance 2.5", output_type: "video", medias: [{ roles: ["start_image", "image_references"] }] }] }) }] } as never);
    expect(models[0].roles).toEqual(["start_image", "image_references"]);
  });
});

describe("a recommended preset is not a started clip (24 Oct: all four clips failed)", () => {
  it("'Submitted 0/1 … declined_preset_id=<uuid>' has no job, and its preset id is declined", async () => {
    const { parseJobs, declinedPresetIn } = await import("../server/higgsfield-mcp");
    const text = 'Submitted 0/1 video generations.\n- index 0: submission_failed — Preset "IN THE DARK" was recommended instead of submitting a job. Retry this index with declined_preset_id=24bae836-2c4a-48e0-89b6-49fcc0b21612.\nWait for the complete requested set with jobs_wait.';
    const r = { isError: true, content: [{ type: "text", text }] } as never;
    expect(parseJobs(r)).toEqual([]);
    expect(declinedPresetIn(r)).toBe("24bae836-2c4a-48e0-89b6-49fcc0b21612");
    const ok = { content: [{ type: "text", text: "Submitted 1 job.\n- 53fc284d-dd1f-46af-b0c0-1ea9895ee1cd" }] } as never;
    expect(parseJobs(ok).map((j) => j.jobId)).toEqual(["53fc284d-dd1f-46af-b0c0-1ea9895ee1cd"]);
  });
});
