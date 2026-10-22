import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "node_modules",
      ".wrangler",
      "src/components/ui/**",
      "scripts/**",
      "server/generated/**",
      "redirect/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: { ...reactHooks.configs.recommended.rules },
  },
  { rules: { "@typescript-eslint/no-explicit-any": "error" } },
  {
    // The promptfoo runner and assertions are plain Node modules.
    files: ["eval/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
);
