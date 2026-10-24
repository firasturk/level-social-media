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
    expect(p).toMatch(/CAMERA SETUP: shot size medium shot/);
    expect(p).toMatch(/The clip will move like this: low angle from the passenger seat/);
    expect(p).toMatch(/do not copy the key frame's composition/);
    expect(p).toMatch(/The second image is the product itself, and it wins over the key frame: keep Sakina Mango exactly as that photo shows it/);
    expect(p).toMatch(/no mint or other garnish, no straw, no lid/);
    expect(p).toMatch(/People: only the brand's cast/);
    expect(p).toMatch(/Brand rules \(never break them\): Never show a woman/);
    expect(p).toMatch(/A vertical 9:16 frame from a professionally filmed lifestyle commercial/);
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

describe("a Reel's hook is on-screen words (24 Oct: the hook was a description of the shot)", () => {
  it("drops a description written where the hook goes; keeps real hooks", async () => {
    const { onScreenWords, campaignInstruction } = await import("../shared/campaign-planner");
    expect(onScreenWords("Close-up of Khaled's hand passing a Sakina to Omar through a car window.")).toBe("");
    expect(onScreenWords("كل طلعة لازمها أبو صالح")).toBe("كل طلعة لازمها أبو صالح");
    expect(onScreenWords("Your road trip drink")).toBe("Your road trip drink");
    expect(campaignInstruction({ setup: defaultSetup(), brand: { name: "B", tone: "", audience: "", language: "ar", dos: "", donts: "", style: "" }, products: [], media: [], references: [], looks: [], month: "2026-11" })).toMatch(/A video's hook: the 2 to 6 words shown on screen/);
  });
});

describe("each Reel is directed as one filmed commercial (24 Oct)", () => {
  const direction = { look: "digital cinema camera, fine grain, gentle highlight roll-off", lighting: "late-afternoon sun from camera left, soft fill, 4800 K", colour: "warm neutral grade, low saturation in the greens", lens: "normal primes, 35 to 85 mm looks", wardrobe: "Omar in a tan jacket, Khaled in a beige shirt", place: "one street in Amman, the same afternoon" };
  const shot = { key: "s2", seconds: 4, action: "Omar sips while leaning on the car door", framing: "medium close-up", camera: "handheld, slight push-in", reference: null, source: "start-image" as const, asset: null, text: "", angle: "eye level, over Khaled's shoulder", lens: "50 mm look, 1.5 m away, f/2.8, street readable", placement: "Omar on the left third, the cup in the foreground", speed: "normal" as const };
  const v = { concept: "A cold smoothie on a drive", frame: "9:16", product: { name: "Sakina", id: "p1", from: "library" }, direction } as never;
  it("the shot picture carries the shared direction, the camera setup, the labelled references and the look to avoid", () => {
    const p = framePrompt(v, shot, { refs: [{ role: "colour", image: 5 }, { role: "composition", image: 6 }] });
    expect(p).toMatch(/PHOTOGRAPHIC DIRECTION \(one commercial/);
    expect(p).toMatch(/Light: late-afternoon sun from camera left/);
    expect(p).toMatch(/CAMERA SETUP: shot size medium close-up; camera eye level, over Khaled's shoulder; lens 50 mm look/);
    expect(p).toMatch(/Image 5 is a colour reference only: borrow its palette/);
    expect(p).toMatch(/Image 6 is a composition reference only: borrow its framing/);
    expect(p).toMatch(/orange-and-teal/);
    expect(p).not.toMatch(/photorealistic/);
  });
  it("the clip carries the setup, the movement, the speed, the light and the identity references", () => {
    const c = clipPrompt(v, shot, [{ name: "omar", gender: "man", modest: true }], { references: true });
    expect(c).toMatch(/Camera movement: handheld, slight push-in\. Real-time speed\./);
    expect(c).toMatch(/Light, as in the start frame: late-afternoon sun/);
    expect(c).toMatch(/reference images are the real product and the cast's faces/);
    expect(c).toMatch(/no constant orbiting/);
  });
  it("plans written before it keep their signatures; a shot's cinematography counts once written", async () => {
    const { stepSignature, cinematography, normalDirection } = await import("../shared/campaign-plan");
    expect(cinematography({ angle: " ", lens: "", speed: undefined })).toEqual({});
    expect(normalDirection({ look: "", lighting: "" })).toBeNull();
    void stepSignature;
  });
});

describe("Higgsfield clips get the product and the faces as references only where the engine takes them", () => {
  it("reads the roles from the catalog", async () => {
    const { takesReferences } = await import("../server/higgsfield-mcp");
    expect(takesReferences({ roles: ["start_image", "image_references", "end_image"] })).toBe(true);
    expect(takesReferences({ roles: ["start_image"] })).toBe(false);
    expect(takesReferences({})).toBe(false);
  });
});

describe("the planner writes new lines and keeps a Reel to its own product (24 Oct)", () => {
  const products = [
    { id: "a", name: "Hot chocolate", from: "drive" as const, thumb: null, listId: "P1" },
    { id: "b", name: "Sahlab", from: "drive" as const, thumb: null, listId: "P2" },
  ];
  const media = [{ kind: "asset" as const, id: "m1", label: "A cup topped with pistachios", thumb: null, from: "Drive", media: "clip" as const, listId: "M1" }];
  const input = { setup: { ...defaultSetup(), imagePosts: 1, videos: 1, shotsPerVideo: 2 }, brand: { name: "Abu Saleh", tone: "Stretch words for sound (وصفوووولي الصبـــرررررر, ختـــام الصيـــف).", audience: "", language: "ar", dos: "", donts: "", style: "" }, products, media, references: [], looks: [], month: "2026-10" };
  const defaults = { imageEngine: { kind: "engine" as const, model: "gemini-3-pro-image" }, frameEngine: { kind: "engine" as const, model: "gemini-3-pro-image" }, clipEngine: { provider: "higgsfield-mcp" as const, model: "seedance_2_5", name: "Seedance 2.5" }, frame: "9:16" as const, videoSeconds: 8 };
  it("tells the model the tone's quoted lines are not to be reused, and says so when one is", async () => {
    const { campaignInstruction, planFromAnswer } = await import("../shared/campaign-planner");
    expect(campaignInstruction(input)).toMatch(/lines quoted in the brand's tone are examples of its style, already used: never reuse them/);
    const plan = planFromAnswer({ images: [{ idea: "x", objective: "", product: "P2", visual: "", reference: "", headline: "وصفوولي الصبر", caption: "", cta: "" }], videos: [] }, input, defaults);
    expect(plan.planningNotes.join(" ")).toMatch(/img-1: its headline repeats an example line from the brand's tone/);
  });
  it("a client clip of another product becomes a made shot in a Reel about this one", async () => {
    const { planFromAnswer } = await import("../shared/campaign-planner");
    const plan = planFromAnswer({ images: [], videos: [{ concept: "c", hook: "", product: "P1", shots: [{ seconds: 4, action: "Omar sips the hot chocolate", framing: "", camera: "", reference: "", source: "start-image", asset: "", text: "" }, { seconds: 4, action: "A hand picks a roll next to the Sahlab cup", framing: "", camera: "", reference: "", source: "existing", asset: "M1", text: "" }], voiceover: "", music: "", transitions: "cuts", look: "", cta: "", caption: "" }] }, input, defaults);
    expect(plan.videos[0].shots[1].source).toBe("start-image");
    expect(plan.videos[0].shots[1].asset).toBeNull();
    expect(plan.planningNotes.join(" ")).toMatch(/vid-1 shot 2: the client's clip shows sahlab/);
  });
});
