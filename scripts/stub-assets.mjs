// Writes an empty server/generated/assets.ts when none exists, so a fresh clone can typecheck,
// test and build. `pnpm run deploy` replaces it with the real embedded client (embed-assets.mjs).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const file = join(root, "server/generated/assets.ts");
if (!existsSync(file)) {
  mkdirSync(join(root, "server/generated"), { recursive: true });
  writeFileSync(
    file,
    "// Generated placeholder (scripts/stub-assets.mjs). Do not edit; `pnpm run deploy` embeds the real client.\nexport const ASSETS: Record<string, { type: string; data: string }> = {};\n",
  );
  console.log("[stub] wrote empty server/generated/assets.ts");
}
