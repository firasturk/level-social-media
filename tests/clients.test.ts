import { describe, expect, it } from "vitest";
import { initials, slugify, uniqueSlug } from "../shared/clients";

describe("client slugs", () => {
  it("lowercases, strips accents and joins words with dashes", () => {
    expect(slugify("Abu Saleh")).toBe("abu-saleh");
    expect(slugify("United Insurance")).toBe("united-insurance");
    expect(slugify("  Café   Noir! ")).toBe("cafe-noir");
    expect(slugify("Jubilee")).toBe("jubilee");
  });
  it("falls back for names without Latin letters and caps the length", () => {
    expect(slugify("حبيبة")).toBe("client");
    expect(slugify("x".repeat(80))).toHaveLength(40);
  });
  it("appends a counter when the slug is taken", () => {
    expect(uniqueSlug("abira", ["habibah"])).toBe("abira");
    expect(uniqueSlug("client", ["client", "client-2"])).toBe("client-3");
  });
  it("builds initials for the card badge", () => {
    expect(initials("United Insurance")).toBe("UI");
    expect(initials("Habibah")).toBe("H");
    expect(initials("حبيبة")).toBe("ح");
    expect(initials("   ")).toBe("?");
  });
});
