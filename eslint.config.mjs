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
        // Only test dirs NOT covered by a tsconfig "include" may use the default project;
        // apps/web includes test/ in its own tsconfig, so it must not be listed here.
        projectService: {
          allowDefaultProject: [
            "apps/api/test/*.ts",
            "apps/worker/test/*.ts",
            "packages/*/test/*.ts"
          ],
          defaultProject: "tsconfig.base.json",
          maximumDefaultProjectFileMatchCount_THIS_WILL_SLOW_DOWN_LINTING: 32
        },
        tsconfigRootDir: import.meta.dirname
      }
    }
  })),
  {
    // apps/web relies on its own tsconfig (Bundler resolution + "@/" paths). Pin it
    // explicitly so type-aware rules never fall back to a project without the alias.
    files: ["apps/web/**/*.ts", "apps/web/**/*.tsx"],
    languageOptions: {
      parserOptions: {
        projectService: false,
        project: ["./tsconfig.eslint.web.json"],
        tsconfigRootDir: import.meta.dirname
      }
    }
  },
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
