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
        // Resolve each file against its nearest tsconfig.json (per-package paths/aliases such as @/)
        // Test files live outside each package's tsconfig "include" (src only); lint them
        // with the base tsconfig, matching the previous behaviour.
        projectService: {
          allowDefaultProject: ["apps/*/test/*.ts", "packages/*/test/*.ts"],
          defaultProject: "tsconfig.base.json",
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 32
        },
        tsconfigRootDir: import.meta.dirname
      }
    }
  })),
  {
    files: ["**/*.ts", "**/*.tsx"],
    plugins: {
      "unused-imports": eslintPluginUnusedImports,
      "@typescript-eslint": tseslint.plugin
    },
    rules: {
      "no-console": ["warn", { allow: ["warn", "error"] }],
      "no-debugger": "warn",
      "@typescript-eslint/explicit-function-return-type": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-call": "off",
      "@typescript-eslint/no-unsafe-member-access": "off",
      "@typescript-eslint/no-unsafe-return": "off",
      "@typescript-eslint/require-await": "off",
      "@typescript-eslint/no-redundant-type-constituents": "off",
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "unused-imports/no-unused-imports": "error"
    }
  }
];
