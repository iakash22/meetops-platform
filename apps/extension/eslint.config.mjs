import root from "../../eslint.config.mjs";

export default [
  { ignores: [".wxt/**", ".output/**", "dist/**"] },
  ...root,
  {
    files: ["**/*.ts", "**/*.tsx"],
    languageOptions: {
      parserOptions: { project: ["./tsconfig.json"], tsconfigRootDir: import.meta.dirname }
    }
  }
];
