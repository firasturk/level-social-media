/**
 * Magnific's MCP tools answer their catalogs as a compact YAML-like text, not JSON (seen live on
 * 23 Oct 2026: `models[7]:` with `- slug:` items, `durations[2]: 5,10`, nested blocks). `jsonOf`
 * reads that text into the same shape, so the video engines, the LUTs and the picture models are
 * listed instead of "Magnific listed no video engine the studio could read".
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { jsonOf, parseYamlish } from "../server/mcp-client";
import { parseVideoModels } from "../server/video-magnific";

const SAMPLE = readFileSync(join(process.cwd(), "tests", "fixtures", "magnific-video-models.txt"), "utf8");

describe("the YAML-like catalog text", () => {
  it("reads scalars, inline lists, blocks and lists of objects", () => {
    const j = parseYamlish(SAMPLE) as { models: Record<string, unknown>[]; instruction: string };
    expect(j.models).toHaveLength(2);
    const kling = j.models[0];
    expect(kling).toMatchObject({ slug: "kling-25", name: "Kling 2.5", tool: "video-generator", beta: true, mode: "25", aspectRatios: ["1:1", "16:9", "9:16"], durations: [5, 10], resolutions: ["1080p", "720p"], supportsStartFrame: true });
    expect(kling.aspectRatioAutoFrom).toEqual({ input: "startFrame", when: "filled" });
    expect(kling.prompt).toEqual({ required: true, maxLength: 2500 });
    expect((kling.agentRecommendation as Record<string, unknown>).tier).toBe("recommended");
    expect((kling.agentRecommendation as Record<string, unknown>).summary).toMatch(/^Best quality\/price choice/);
    expect(kling.keyframes).toEqual({ start: { assetType: "image", requiredIf: { resolution: ["720p"] } }, end: { assetType: "image" } });
    const mini = j.models[1];
    expect(mini.references).toEqual([{ type: "image", allowed: true, limit: 9 }, { type: "video", allowed: true }]);
    expect(mini.durations).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    expect(mini.private).toBe(true);
    expect(j.instruction).toMatch(/^Prefer models with/);
    // Not that text: prose, JSON, an empty answer.
    expect(parseYamlish("Nothing to list here.")).toBeNull();
    expect(parseYamlish("")).toBeNull();
    expect(parseYamlish("  indented: first")).toBeNull();
  });

  it("is what jsonOf answers when the text is not JSON, and the video engines read from it", () => {
    const r = { content: [{ type: "text" as const, text: SAMPLE }] };
    expect((jsonOf(r) as { models: unknown[] }).models).toHaveLength(2);
    expect(jsonOf({ content: [{ type: "text", text: '{"models":[]}' }] })).toEqual({ models: [] });
    const models = parseVideoModels(r);
    // The private engine is left out; the recommendation block is read; a start keyframe means a clip from a picture.
    expect(models.map((m) => m.slug)).toEqual(["kling-25"]);
    expect(models[0]).toMatchObject({ name: "Kling 2.5", durations: [5, 10], aspectRatios: ["1:1", "16:9", "9:16"], resolutions: ["1080p", "720p"], recommended: true, imageToVideo: true });
    expect(models[0].recommendation).toMatch(/^Best quality\/price choice/);
  });
});
