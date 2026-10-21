// tests/ has its own tsconfig, so point type-aware linting at it.
import root from "../eslint.config.mjs";

export default [
  { ignores: ["test-results/**", "playwright-report/**"] },
  ...root.map((c) =>
    c.languageOptions?.parserOptions?.project
      ? {
          ...c,
          languageOptions: {
            ...c.languageOptions,
            parserOptions: {
              ...c.languageOptions.parserOptions,
              project: ["./tsconfig.json"],
              tsconfigRootDir: import.meta.dirname
            }
          }
        }
      : c
  )
];
