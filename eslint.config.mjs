// Flat ESLint config for monorepo
import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintPluginUnusedImports from "eslint-plugin-unused-imports";

/** @type {import('eslint').Linter.FlatConfig[]} */
export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      ".turbo/**",
      "**/.vite/**",
      "**/coverage/**"
    ]
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked.map((c) => ({
    ...c,
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      ...c.languageOptions,
      parserOptions: {
        ...c.languageOptions?.parserOptions,
        project: ["./tsconfig.base.json", "./apps/*/tsconfig.json", "./packages/*/tsconfig.json"]
      }
    }
  })),
  {
    plugins: {
      "unused-imports": eslintPluginUnusedImports
    },
    rules: {
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-debugger": "warn",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "unused-imports/no-unused-imports": "error"
    }
  }
];
