import { describe, expect, it } from "vitest";
import { postImages } from "../server/engine";
import { buildPostPrompt, type PostBrief } from "../shared/posts";

/**
 * The list of pictures a post sends, shared by the Google, OpenAI, fal, Flex and Higgsfield paths,
 * and the prompt's "Image n" numbering built from the same brief: they must agree.
 */
const base: PostBrief = {
  post: true,
  index: 1,
  type: "product",
  title: "t",
  brief: "A cup on a table.",
  palette: [],
  style: "",
  theme: "",
  format: "4:5",
  ref: null,
  refIsSource: false,
  hasProduct: true,
  product: "mango smoothie: a clear cup of mango smoothie",
};
const resolve = async (id: string) => (id === "style:grid-9" ? "styles/grid-9.jpg" : id === "ref-1" ? "refs/t-1/ref-1.jpg" : null);

/** The highest "Image n" the prompt names (0 when it names none). */
function highestImage(prompt: string): number {
  let n = 0;
  for (const m of prompt.matchAll(/Images? (\d+)(?: to (\d+))?/g)) n = Math.max(n, Number(m[2] ?? m[1]));
  return n;
}

describe("the pictures a post sends", () => {
  it("come in the prompt's order: products, portraits, place, real people, look, edit reference", async () => {
    const pb: PostBrief = {
      ...base,
      extraProducts: [{ name: "karak", key: "p/karak.jpg" }],
      ambassadors: [{ name: "Lina", description: "woman", key: "amb/lina.jpg" }],
      place: { key: "place/shop.jpg", what: "shop" },
      realRef: { key: "real/1.jpg" },
      styleKey: "styles/s-42.jpg",
      editRef: { key: "u/b/ref.jpg", note: "keep the cup" },
    };
    const r = await postImages(pb, resolve);
    expect(r.images.map((i) => i.role)).toEqual(["product", "portrait", "place", "realRef", "look", "editRef"]);
    expect(r.mood).toBe(true);
    expect(r.reference).toBe(true);
    // Image 1 is the product photo itself (the task source), then these six.
    expect(highestImage(buildPostPrompt(pb, "", { reference: true }))).toBe(1 + r.images.length);
  });

  it("attaches the cut grid tile when there is one, else resolves a library grid or theme reference", async () => {
    const tile = await postImages({ ...base, ref: "style:grid-9", tileKey: "styles/grid-9-tile-3.jpg" }, resolve);
    expect(tile.images.map((i) => i.key)).toEqual(["styles/grid-9-tile-3.jpg"]);
    const grid = await postImages({ ...base, ref: "style:grid-9" }, resolve);
    expect(grid.images).toEqual([{ key: "styles/grid-9.jpg", role: "look", refId: "style:grid-9" }]);
    const theme = await postImages({ ...base, ref: "ref-1" }, resolve);
    expect(theme.images[0].key).toBe("refs/t-1/ref-1.jpg");
    const gone = await postImages({ ...base, ref: "ref-missing" }, resolve);
    expect(gone.images).toEqual([]);
    expect(gone.mood).toBe(false);
  });

  it("sends no look picture when it is described instead, or when it is image 1 itself", async () => {
    const people = await postImages({ ...base, styleKey: "styles/s-42.jpg", noRefImage: true, ambassadors: [{ name: "Lina", description: "woman", key: "amb/lina.jpg" }] }, resolve);
    expect(people.images.map((i) => i.role)).toEqual(["portrait"]);
    expect(people.mood).toBe(false);
    expect(highestImage(buildPostPrompt({ ...base, styleKey: "styles/s-42.jpg", noRefImage: true, ambassadors: [{ name: "Lina", description: "woman", key: "amb/lina.jpg" }] }))).toBe(2);
    const source = await postImages({ ...base, hasProduct: false, product: undefined, ref: "ref-1", refIsSource: true }, resolve);
    expect(source.images).toEqual([]);
  });

  it("numbers the prompt the same way for every creation method", async () => {
    const cases: PostBrief[] = [
      { ...base, ref: "ref-1" },
      { ...base, ref: "style:grid-9", tileKey: "styles/grid-9-tile-3.jpg" },
      { ...base, styleKey: "styles/brief-7.jpg", campaign: { ingredients: "mango" } },
      { ...base, styleKey: "styles/s-42.jpg", extraProducts: [{ name: "karak", key: "p/karak.jpg" }, { name: "mojito", key: "p/mojito.jpg" }] },
      { ...base, ref: "ref-1", editRef: { key: "u/b/ref.jpg" } },
    ];
    for (const pb of cases) {
      const r = await postImages(pb, resolve);
      expect(highestImage(buildPostPrompt(pb, "", { reference: r.reference }))).toBe(1 + r.images.length);
    }
  });
});
