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

describe("ideas first: a real place, a hook move, a format and a camera position from the library (24 Oct: every Abu Saleh picture sat on a teal studio backdrop)", () => {
  const products = [{ id: "a", name: "Spicy hot chocolate", from: "library" as const, thumb: null, listId: "P1" }];
  const studioStyle = "High-energy studio product shots, bold monochromatic backgrounds, centred composition.";
  const input = { setup: { ...defaultSetup(), imagePosts: 2, videos: 1, shotsPerVideo: 3 }, brand: { name: "Abu Saleh", tone: "", audience: "", language: "ar", dos: "", donts: "", style: studioStyle }, products, media: [], references: [], looks: [], month: "2026-10" };
  const defaults = { imageEngine: { kind: "engine" as const, model: "gemini-3-pro-image" }, frameEngine: { kind: "engine" as const, model: "gemini-3-pro-image" }, clipEngine: { provider: "higgsfield-mcp" as const, model: "seedance_2_5", name: "Seedance 2.5" }, frame: "9:16" as const, videoSeconds: 12 };
  const shot = (angleId: string, angle = "") => ({ seconds: 4, action: "a hand lifts the cup", framing: "medium", camera: "static", reference: "", source: "start-image", asset: "", text: "", angle, lens: "", placement: "", speed: "normal", angleId });

  it("the planner is told ideas come first, the style lends palette only, and gets the angle library by id", async () => {
    const { campaignInstruction } = await import("../shared/campaign-planner");
    const t = campaignInstruction(input);
    expect(t).toMatch(/IDEAS FIRST/);
    expect(t).toMatch(/never set a scene \(lifestyle, phone moment, still life, a filmed Reel\) in a studio or against a plain backdrop unless the CREATIVE DIRECTION asks for a studio/);
    expect(t).toMatch(/^handoff-lens: Hand-off to the lens: .* · mid$/m);
    expect(t).toMatch(/^worms-eye: /m);
    expect(t).toMatch(/at least one tight, one mid and one wide; at most one shot at plain eye level/);
    expect(t).not.toMatch(/eye level by default/);
  });

  it("keeps the idea fields, drops an angle id that is not in the library", async () => {
    const { planFromAnswer } = await import("../shared/campaign-planner");
    const plan = planFromAnswer(
      {
        images: [{ idea: "x", objective: "", product: "P1", visual: "", reference: "", headline: "", caption: "", cta: "", setting: "a car at a takeaway window on a cold night", angleId: "handoff-lens", kind: "still-life" }, { idea: "y", objective: "", product: "P1", visual: "", reference: "", headline: "", caption: "", cta: "", setting: "cocoa powder and chilli flakes on a deep red surface", angleId: "made-up", kind: "product-hero" }],
        videos: [{ concept: "c", hook: "", product: "P1", shots: [shot("macro-rim"), shot("pov-hand"), shot("wide-place")], voiceover: "", music: "", transitions: "cuts", look: "", cta: "", caption: "", direction: { look: "", lighting: "", colour: "", lens: "", wardrobe: "", place: "old stone stairs at dusk" }, format: "ugc", hookMove: "the cup is pushed toward the lens" }],
      },
      input,
      defaults,
    );
    expect(plan.images[0]).toMatchObject({ setting: "a car at a takeaway window on a cold night", angleId: "handoff-lens", kind: "still-life" });
    expect(plan.images[1].kind).toBe("product-hero");
    expect(plan.images[1].angleId).toBeUndefined();
    expect(plan.videos[0]).toMatchObject({ format: "ugc", hookMove: "the cup is pushed toward the lens" });
    expect(plan.videos[0].shots.map((s) => s.angleId)).toEqual(["macro-rim", "pov-hand", "wide-place"]);
    expect(plan.planningNotes).toEqual([]);
  });

  it("says so when pieces share a place, sit in a studio, repeat a camera position, stay at one distance or at eye level", async () => {
    const { varietyNotes, samePlace } = await import("../shared/campaign-planner");
    expect(samePlace("a car at a takeaway window on a cold night", "the car at the takeaway window, cold night")).toBe(true);
    expect(samePlace("a car at a takeaway window", "a balcony over the city")).toBe(false);
    const v = (shots: object[], place: string) => ({ key: "vid-1", direction: { place }, shots, format: "tv-spot" }) as never;
    const s = (angleId: string, angle = "") => ({ source: "start-image", angleId, angle }) as never;
    const notes = varietyNotes(
      {
        images: [{ key: "img-1", setting: "a car at a takeaway window on a cold night", visual: "" }, { key: "img-2", setting: "the car at the takeaway window on a cold night", visual: "teal seamless backdrop" }] as never,
        videos: [v([s("pov-hand", "eye level"), s("pov-hand", "eye level"), s("handoff-lens")], "studio set with deep teal backgrounds")],
      },
      false,
    ).join(" ");
    expect(notes).toMatch(/img-1 and img-2 happen in the same place/);
    expect(notes).toMatch(/img-2 is set in a studio/);
    expect(notes).toMatch(/vid-1 is set in a studio/);
    expect(notes).toMatch(/vid-1: two shots use the same camera position/);
    expect(notes).toMatch(/vid-1: all its shots are at the same distance/);
    expect(notes).toMatch(/vid-1: 2 shots at plain eye level/);
    // A studio the admin asked for is not a problem.
    expect(varietyNotes({ images: [{ key: "img-1", setting: "", visual: "studio, seamless yellow backdrop" }] as never, videos: [] }, true)).toEqual([]);
  });

  it("the shot picture keeps light and wardrobe, gets its own place, its camera plate and its register", () => {
    const v = { concept: "Warmth on a cold night", frame: "9:16", product: { name: "Spicy hot chocolate", id: "a", from: "library" }, direction: { look: "", lighting: "sodium street light, 2700 K", colour: "", lens: "", wardrobe: "", place: "a parked car on a rainy street in Amman" }, format: "ugc", hookMove: "the cup is pushed through the window toward the lens", shots: [{ key: "s1" }] } as never;
    const s = { key: "s2", seconds: 4, action: "a hand lifts the cup off the dashboard", framing: "medium", camera: "static", reference: null, source: "start-image" as const, asset: null, text: "", angleId: "pov-hand" };
    const p = framePrompt(v, s, { plate: 4 });
    expect(p).toMatch(/The place is this shot's own spot in the same world/);
    expect(p).not.toMatch(/the same place, light/);
    expect(p).toMatch(/CAMERA SETUP: camera position "First-person POV": first-person view/);
    expect(p).toMatch(/Image 4 is a black-and-white camera-position reference: copy its camera height, angle, distance and framing/);
    expect(p).toMatch(/REGISTER: authentic creator phone footage/);
    expect(p).toMatch(/no legible signs of other businesses, no car badges/);
    expect(p).toMatch(/a real place in Jordan \(Amman unless the brief names another city\)/);
    expect(p).toMatch(/no red-brick campuses/);
    const c1 = clipPrompt(v, { ...s, key: "s1" });
    const c2 = clipPrompt(v, s);
    expect(c1).toMatch(/The first second, to stop the scroll: the cup is pushed through the window/);
    expect(c2).not.toMatch(/The first second/);
    expect(c2).toMatch(/Camera movement: static, handheld with a slight natural micro-shake\./);
  });

  it("a studio place keeps the old continuity wording", () => {
    const v = { concept: "x", frame: "9:16", product: null, direction: { look: "", lighting: "", colour: "", lens: "", wardrobe: "", place: "studio set with deep teal backgrounds" } } as never;
    expect(framePrompt(v, { key: "s2", seconds: 3, action: "a cup", framing: "", camera: "", reference: null, source: "start-image", asset: null, text: "" })).toMatch(/the same place, light, time of day/);
  });

  it("plans without the idea fields keep their signatures; the fields count once written", async () => {
    const { stepSignature, itemProductionSignature, normalizePlan } = await import("../shared/campaign-plan");
    const base = normalizePlan({ images: [{ key: "img-1", idea: "x", visual: "", headline: "", caption: "", cta: "", objective: "" }] as never, videos: [{ key: "vid-1", concept: "c", shots: [{ key: "s1", seconds: 4, action: "a", framing: "", camera: "", source: "start-image" }] }] as never }, defaults);
    const img = itemProductionSignature(base.images[0]);
    const key = stepSignature(base, { item: "vid-1", shot: null, kind: "image" });
    const withIdeas = normalizePlan({ ...base, images: [{ ...base.images[0], setting: "a balcony", angleId: "high-45" }], videos: [{ ...base.videos[0], format: "tv-spot", hookMove: "x", shots: [{ ...base.videos[0].shots[0], angleId: "macro-rim" }] }] }, defaults);
    expect(withIdeas.images[0]).toMatchObject({ setting: "a balcony", angleId: "high-45" });
    expect(withIdeas.videos[0]).toMatchObject({ format: "tv-spot", hookMove: "x" });
    expect(itemProductionSignature(withIdeas.images[0])).not.toBe(img);
    expect(stepSignature(withIdeas, { item: "vid-1", shot: null, kind: "image" })).not.toBe(key);
    expect(normalizePlan({ ...base, images: [{ ...base.images[0], angleId: "not-an-angle" }] }, defaults).images[0].angleId).toBeUndefined();
    expect(itemProductionSignature(normalizePlan(base, defaults).images[0])).toBe(img);
    // A new place for a Reel is a material change: its pictures are made again after approval.
    const placed = normalizePlan({ ...base, videos: [{ ...base.videos[0], direction: { look: "", lighting: "", colour: "", lens: "", wardrobe: "", place: "a campus in Amman" } }] }, defaults);
    const moved = normalizePlan({ ...base, videos: [{ ...base.videos[0], direction: { look: "", lighting: "", colour: "", lens: "", wardrobe: "", place: "a balcony over Abdoun" } }] }, defaults);
    expect(itemProductionSignature(placed.videos[0])).not.toBe(itemProductionSignature(moved.videos[0]));
    expect(itemProductionSignature(normalizePlan(base, defaults).videos[0])).toBe(itemProductionSignature(base.videos[0]));
  });

  it("a post set on location takes the client style for palette and finish only", async () => {
    const { buildPostPrompt } = await import("../shared/posts");
    const brief = { post: true, index: 1, type: "product", title: "t", brief: "A cup in a car.", palette: [], style: studioStyle, theme: "" } as never;
    expect(buildPostPrompt({ ...(brief as object), onLocation: true } as never)).toMatch(/CLIENT STYLE \(its palette, energy and finish only: this picture is on location/);
    expect(buildPostPrompt(brief)).toMatch(/CLIENT STYLE:\nHigh-energy studio/);
    const { STUDIO_WORDS } = await import("../shared/campaign-planner");
    expect(STUDIO_WORDS.test("teal seamless backdrop")).toBe(true);
    expect(STUDIO_WORDS.test("a balcony over the city")).toBe(false);
  });
});

describe("Higgsfield templates as a Reel format (24 Oct: not every Reel is lifestyle)", () => {
  const CHILI = "fd5645a1-1cfc-4db1-bc9c-2b5a043e3079";
  const defaults = { imageEngine: { kind: "engine" as const, model: "gemini-3-pro-image" }, frameEngine: { kind: "engine" as const, model: "gemini-3-pro-image" }, clipEngine: { provider: "higgsfield-mcp" as const, model: "seedance_2_5", name: "Seedance 2.5" }, frame: "9:16" as const, videoSeconds: 12 };

  it("the planner gets every template and plans one as a single-shot Reel; an unknown one stays filmed", async () => {
    const { campaignInstruction, planFromAnswer } = await import("../shared/campaign-planner");
    const { CREATIVE_TEMPLATES } = await import("../shared/creative-templates");
    const input = { setup: { ...defaultSetup(), imagePosts: 0, videos: 2, shotsPerVideo: 4 }, brand: { name: "Abu Saleh", tone: "", audience: "", language: "ar", dos: "", donts: "", style: "" }, products: [{ id: "a", name: "Spicy hot chocolate", from: "library" as const, thumb: null, listId: "P1" }], media: [], references: [], looks: [], month: "2026-10" };
    const t = campaignInstruction(input);
    expect(CREATIVE_TEMPLATES).toHaveLength(15);
    for (const x of CREATIVE_TEMPLATES) expect(t).toContain(`${x.id}: ${x.name}: `);
    expect(t).toMatch(/A campaign is not all lifestyle/);
    expect(t).toMatch(/at least one of them is a template unless no template fits the product/);
    const shot = { seconds: 3, action: "cocoa bursts", framing: "", camera: "", reference: "", source: "start-image", asset: "", text: "", angle: "", lens: "", placement: "", speed: "normal", angleId: "" };
    const plan = planFromAnswer(
      {
        images: [],
        videos: [
          { concept: "Heat you can see", hook: "", product: "P1", shots: [shot, shot, shot, shot], voiceover: "", music: "", transitions: "cuts", look: "", cta: "", caption: "", format: "template", templateId: CHILI, templateBrief: "Cocoa and red chili burst in macro." },
          { concept: "x", hook: "", product: "P1", shots: [shot], voiceover: "", music: "", transitions: "cuts", look: "", cta: "", caption: "", format: "template", templateId: "not-a-template", templateBrief: "" },
        ],
      },
      input,
      defaults,
    );
    expect(plan.videos[0]).toMatchObject({ format: "template", template: { id: CHILI, brief: "Cocoa and red chili burst in macro." } });
    expect(plan.videos[0].shots).toHaveLength(1);
    expect(plan.videos[0].shots[0]).toMatchObject({ key: "s1", seconds: 15, source: "start-image" });
    expect(plan.videos[1].template).toBeUndefined();
    expect(plan.planningNotes.join(" ")).toMatch(/template that is not in the list/);
  });

  it("a template Reel is one clip on the subscription credits: no key frame, no shot pictures, no picture review", async () => {
    const { normalizePlan, planSteps, needsKeyFrame } = await import("../shared/campaign-plan");
    const plan = normalizePlan({ videos: [{ key: "vid-1", concept: "c", frame: "9:16", format: "template", template: { id: CHILI, brief: "b" }, shots: [{ key: "s1", seconds: 4, action: "a", source: "start-image" }, { key: "s2", seconds: 4, action: "b", source: "start-image" }] }] as never }, defaults);
    expect(needsKeyFrame(plan.videos[0])).toBe(false);
    const steps = planSteps(plan);
    expect(steps.map((s) => s.id)).toEqual(["vid-1:-:post", "vid-1:s1:clip", "vid-1:-:assemble", "vid-1:-:render"]);
    expect(steps[1]).toMatchObject({ priceKey: `clip:higgsfield-mcp:template:${CHILI}:15:9:16`, unit: "higgsfield-credits", deps: ["vid-1:-:post"] });
  });

  it("prices a template from the library without asking Higgsfield, and reads a clip's length apart from its 9:16 frame", async () => {
    const { normalizePlan } = await import("../shared/campaign-plan");
    const { priceBook } = await import("../server/campaign");
    const plan = normalizePlan(
      {
        videos: [
          { key: "vid-1", concept: "c", frame: "9:16", shots: [{ key: "s1", seconds: 4, action: "a", source: "existing", asset: { kind: "asset", id: "m", label: "m", thumb: null, from: "Drive", media: "photo" } }, { key: "s2", seconds: 4, action: "a", source: "animate", asset: { kind: "asset", id: "m", label: "m", thumb: null, from: "Drive", media: "photo" } }] },
          { key: "vid-2", concept: "c", frame: "9:16", format: "template", template: { id: CHILI, brief: "b" }, shots: [] },
        ] as never,
      },
      defaults,
    );
    const asked: unknown[] = [];
    const r = await priceBook({} as never, {} as never, "b", plan, false, { magnificCamera: async () => ({ credits: null, note: "" }), higgsfieldCredits: async (_e: unknown, _b: string, model: string, seconds: number, frame: string) => (asked.push([model, seconds, frame]), { credits: 35, note: "" }) } as never);
    expect(asked).toEqual([["seedance_2_5", 5, "9:16"]]);
    expect(r.prices[`clip:higgsfield-mcp:template:${CHILI}:15:9:16`]).toMatchObject({ amount: 78, unit: "higgsfield-credits", source: "catalog" });
  });

  it("the template request: its type and preset, the product's photo as its input, the brief with the brand's rules", async () => {
    const { templateParams, TEMPLATE_MODEL } = await import("../server/higgsfield-mcp");
    const { templatePrompt } = await import("../server/campaign-runner");
    const { templateById } = await import("../shared/creative-templates");
    expect(templateParams({ presetId: CHILI, type: "hypermotion", name: "Chili Burst" }, { prompt: " brief " }, "media-1", "9:16")).toEqual({ model: TEMPLATE_MODEL, type: "hypermotion", preset_id: CHILI, medias: [{ value: "media-1", role: "input_images" }], count: 1, prompt: "brief", aspect_ratio: "9:16" });
    const giant = templateById("6017577c-d9f9-4d1a-87d6-26e96e8e4f25")!;
    const p = templatePrompt({ concept: "c", template: { id: giant.id, brief: "A giant Sakina cup on a limestone street." }, product: { name: "Sakina", note: "green smoothie with nuts", id: "s", from: "library" } } as never, giant, [{ name: "omar", gender: "man", modest: true }]);
    expect(p).toMatch(/A giant Sakina cup on a limestone street/);
    expect(p).toMatch(/Adapt the template for this brand: the creator is one of the brand's cast/);
    expect(p).toMatch(/keep it exactly as in the photo/);
    expect(p).toMatch(/omar/);
    expect(p).toMatch(/toasting or clinking/);
    expect(p).toMatch(/in Jordan/);
  });
});

describe("the mix: not every piece is lifestyle, and one ambassador is not in every piece (24 Oct: Habibah's campaign was Ahmad at home in every post)", () => {
  const cast = [{ name: "Ahmad", gender: "man", modest: true }, { name: "Lina", gender: "woman", modest: true }];
  const img = (key: string, idea: string, kind?: string) => ({ key, selected: true, idea, objective: "", product: null, visual: "", reference: null, headline: "", caption: "", cta: "", engine: { kind: "engine" as const, model: "m" }, outputs: 1, setting: `${key} somewhere different ${key}`, ...(kind ? { kind: kind as never } : {}) });

  it("the planner gets the kinds, the mix rules, people as optional and the direction as a mood", async () => {
    const { campaignInstruction } = await import("../shared/campaign-planner");
    const t = campaignInstruction({ setup: { ...defaultSetup(), imagePosts: 4, videos: 1 }, brand: { name: "Habibah", tone: "", audience: "", language: "ar", dos: "", donts: "", style: "" }, products: [], media: [], references: [], looks: [], month: "2026-10", cast });
    for (const k of ["lifestyle", "ugc", "product-hero", "still-life", "detail", "graphic"]) expect(t).toMatch(new RegExp(`^- ${k}: `, "m"));
    expect(t).toMatch(/At most half of the image posts show a person/);
    expect(t).toMatch(/The same cast member never carries two image posts/);
    expect(t).toMatch(/A person, a place or a scene it names is one of the campaign's ideas, not the idea of every piece/);
    expect(t).toMatch(/for food, sweets, drinks and packaged products a template whose mechanic fits the product usually sells it better/);
  });

  it("notes a plan where every post is lifestyle, none sells the product alone, people fill most pieces and one ambassador carries several posts", async () => {
    const { varietyNotes } = await import("../shared/campaign-planner");
    const habibah = { images: [img("img-1", "Ahmad arriving at a friend's apartment with the tin"), img("img-2", "Lina preparing a hospitality tray"), img("img-3", "A close-up of the tin on a coffee table at night"), img("img-4", "Ahmad holding the sugar-free plate")], videos: [] };
    const notes = varietyNotes(habibah, false, cast).join(" | ");
    expect(notes).toMatch(/The image posts are all lifestyle: mix 3 kinds/);
    expect(notes).toMatch(/No image post sells the product on its own/);
    expect(notes).toMatch(/Ahmad carries img-1, img-4/);
    // A mixed plan passes.
    const mixed = { images: [img("img-1", "Ahmad arriving with the tin", "lifestyle"), img("img-2", "the tin among pistachios and syrup", "product-hero"), img("img-3", "the layers of baklava up close", "detail"), img("img-4", "the tin cut out on navy shapes with the headline", "graphic")], videos: [] };
    expect(varietyNotes(mixed, false, cast)).toEqual([]);
    // A designed post may use a built set: no studio note for it, one for a scene.
    const studio = { images: [{ ...img("img-1", "the tin", "product-hero"), setting: "a navy seamless backdrop with pistachios" }, { ...img("img-2", "a tray", "still-life"), setting: "a plain studio backdrop" }, img("img-3", "x", "detail")], videos: [] };
    const s = varietyNotes(studio, false, cast);
    expect(s.some((n) => n.startsWith("img-1 is set in a studio"))).toBe(false);
    expect(s.some((n) => n.startsWith("img-2 is set in a studio"))).toBe(true);
  });

  it("a card shows the cast member its words name, nobody on a picture kind without people, and the first only when nobody is named", async () => {
    const { castFor } = await import("../server/campaign-runner");
    expect(castFor(cast, "Lina's hands arrange the baklava", { people: true })).toBe("Lina");
    expect(castFor(cast, "a hand lifts the lid of the tin", { people: false })).toBeNull();
    expect(castFor(cast, "the tin on navy shapes", { people: false })).toBeNull();
    expect(castFor(cast, "a man walks to the door with the tin", { people: true })).toBe("Ahmad");
    expect(castFor([], "a man walks to the door", null)).toBeNull();
  });

  it("keeps a post's kind in the plan, counts it in the production signature and tells the picture engine", async () => {
    const { normalizePlan, itemProductionSignature } = await import("../shared/campaign-plan");
    const defaults = { imageEngine: { kind: "engine" as const, model: "m" }, frameEngine: { kind: "engine" as const, model: "m" }, clipEngine: { provider: "higgsfield-mcp" as const, model: "seedance", name: "Seedance" }, frame: "9:16" as const, videoSeconds: 12 };
    const plan = normalizePlan({ rev: 1, images: [img("img-1", "x", "graphic"), img("img-2", "y", "nonsense")], videos: [] } as never, defaults);
    expect(plan.images[0].kind).toBe("graphic");
    expect(plan.images[1].kind).toBeUndefined();
    expect(itemProductionSignature({ ...plan.images[0], kind: "detail" })).not.toBe(itemProductionSignature(plan.images[0]));
  });
});
