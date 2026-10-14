import globals from "globals";
import tseslint from "typescript-eslint";

export default [
  { languageOptions: { globals: globals.node } },
  ...tseslint.configs.recommended,
  { ignores: ["indexer/gen"] },
  {
    rules: {
      "@typescript-eslint/ban-types": "off",
    },
  },
];
