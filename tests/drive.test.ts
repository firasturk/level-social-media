import { describe, expect, it } from "vitest";
import { driveFolderId, drivePickInstruction, freeName, parseMatches, parsePicks, photoName, productMatchInstruction, spreadPhotos, type DrivePhoto, type ProductOption } from "@shared/drive";

const photo = (id: string, folder: string, modified = "2026-01-01", file = `${id}.jpg`): DrivePhoto => ({ id, file, name: photoName(file, folder.split(" / ")), folder, w: 0, h: 0, modified });

describe("Drive folders", () => {
  it("reads the folder id from the links people paste", () => {
    expect(driveFolderId("https://drive.google.com/drive/u/0/folders/13wXonkYm9bKQbNHEV9LWmDZVDh1fid4s?dmr=1&ec=wgc")).toBe("13wXonkYm9bKQbNHEV9LWmDZVDh1fid4s");
    expect(driveFolderId("https://drive.google.com/open?id=1vE6i36TSE9y6eFc-HH6AAJNU4yFjfTeo")).toBe("1vE6i36TSE9y6eFc-HH6AAJNU4yFjfTeo");
    expect(driveFolderId("1vE6i36TSE9y6eFc-HH6AAJNU4yFjfTeo")).toBe("1vE6i36TSE9y6eFc-HH6AAJNU4yFjfTeo");
    expect(driveFolderId("habibah.com")).toBeNull();
  });

  it("names a photo after its product, not its camera code", () => {
    expect(photoName("DSC09913.JPG", ["Gallery", "Kunafah - كنـافة", "Sidr - Tray"])).toBe("Sidr - Tray");
    expect(photoName("AT5A0019.png", ["Gallery", "Cans"])).toBe("Cans");
    expect(photoName("Carrot Cake.JPG", ["Soli Cakes", "Carrot Cake"])).toBe("Carrot Cake");
    expect(photoName("Chocolate_SwissRoll 1.png", ["Final"])).toBe("Chocolate SwissRoll");
    expect(photoName("IMG_2041.jpg", ["Gallery", "2024"])).toBe("IMG_2041");
  });

  it("spreads the candidates over the folders, newest first", () => {
    const list = [photo("a1", "A", "2026-01-01"), photo("a2", "A", "2026-03-01"), photo("a3", "A", "2026-02-01"), photo("b1", "B"), photo("c1", "C")];
    expect(spreadPhotos(list, 4).map((p) => p.id)).toEqual(["a2", "b1", "c1", "a3"]);
  });

  it("asks for varied, clean product photos and keeps the picks it can place", () => {
    const list = [photo("a", "Kunafah"), photo("b", "Cans")];
    const text = drivePickInstruction({ client: "Habibah", count: 2, photos: list, profile: "Hero products: kunafa" });
    expect(text).toContain("1. Kunafah / a.jpg");
    expect(text).toContain("Hero products: kunafa");
    expect(text).toMatch(/near-identical/);
    const picks = parsePicks({ picks: [{ image: 2, product: "علب", reason: "clean" }, { image: 2, product: "again" }, { image: 9 }, { image: 1, product: "" }] }, list, 5);
    expect(picks).toEqual([
      { id: "b", product: "علب", reason: "clean" },
      { id: "a", product: "Kunafah", reason: "" },
    ]);
  });

  it("matches products to posts and keeps only the options it can place", () => {
    const posts = [
      { index: 1, type: "product", brief: "A kunafa tray close-up", product: "كنافة", tile: { kind: "product", items: "tray" } },
      { index: 2, type: "lifestyle", brief: "A quote on cream", tile: { kind: "text", items: "" } },
    ];
    const options: ProductOption[] = [
      { source: "month", id: "m1", name: "كنافة ناعمة", note: "" },
      { source: "drive", id: "d1", name: "Sidr - Tray", note: "4 photos in Kunafah / Sidr - Tray" },
    ];
    const text = productMatchInstruction({ client: "Habibah", posts, options });
    expect(text).toContain("grid tile: product (tray)");
    expect(text).toContain("2. Sidr - Tray (the client's Drive)");
    expect(text).toMatch(/gets no picks/);
    const m = parseMatches({ matches: [{ post: 1, picks: [{ option: 2, reason: "a tray" }, { option: 2 }, { option: 7 }] }, { post: 9, picks: [] }] }, posts, options);
    expect(m).toEqual([
      { index: 1, picks: [{ ...options[1], reason: "a tray" }] },
      { index: 2, picks: [] },
    ]);
  });

  it("finds a free product name in the month", () => {
    expect(freeName("Sidr - Tray", new Set(["sidr - tray", "sidr - tray (2)"]))).toBe("Sidr - Tray (3)");
    expect(freeName("Kunafah / Sidr", new Set())).toBe("Kunafah Sidr");
  });
});
