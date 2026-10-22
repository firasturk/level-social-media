import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";

export default tseslint.config(
  {
    ignores: [
      "dist",
      "node_modules",
      ".wrangler",
      ".claude",
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
    // The integrations stub (governance) keeps its parameters named for the merge; the underscore says they are unused on purpose.
    files: ["server/integrations.ts"],
    rules: { "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }] },
  },
  {
    // The promptfoo runner and assertions are plain Node modules.
    files: ["eval/**/*.mjs"],
    languageOptions: { globals: { process: "readonly", console: "readonly" } },
  },
);
