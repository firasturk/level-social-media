import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/** Every @shared/* module the worker imports must be an alias in both wrangler configs, or the deploy fails. */
function sharedImports(dir: string, out = new Set<string>()): Set<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sharedImports(p, out);
    else if (/\.ts$/.test(name)) for (const m of readFileSync(p, "utf8").matchAll(/from "@shared\/([\w-]+)"/g)) out.add(m[1]);
  }
  return out;
}

describe("worker aliases", () => {
  it("lists every shared module the worker imports in both wrangler configs", () => {
    const used = [...sharedImports("server"), ...sharedImports("shared")];
    // The deploy config stays out of git (it is written per deployment), so it is checked where it exists.
    for (const f of ["wrangler.deploy.json", "wrangler.jsonc"].filter((f) => existsSync(f))) {
      const text = readFileSync(f, "utf8");
      const missing = [...new Set(used)].filter((m) => !text.includes(`"@shared/${m}"`));
      expect(missing, `${f} lacks aliases for: ${missing.join(", ")}`).toEqual([]);
    }
  });
});
