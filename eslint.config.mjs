import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/**", "data/**", "keys/**", "coverage/**"] },
  js.configs.recommended,
  {
    files: ["**/*.mjs", "public/**/*.js"],
    languageOptions: { ecmaVersion: 2025, sourceType: "module" },
    linterOptions: { reportUnusedDisableDirectives: "error" },
    rules: {
      curly: ["error", "all"],
      eqeqeq: ["error", "always"],
      "no-eval": "error",
      "no-var": "error",
      "prefer-const": "error",
      "no-unused-vars": ["error", { args: "all", argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
      "sort-imports": ["error", { ignoreDeclarationSort: true }],
      "no-restricted-syntax": [
        "error",
        {
          selector: "VariableDeclarator[id.name='state']",
          message: "Name the concept explicitly: snapshot, session, context or oidcState.",
        },
        {
          selector:
            ":matches(FunctionDeclaration, FunctionExpression, ArrowFunctionExpression) > Identifier.params[name='state']",
          message: "Name the parameter after its specific concept, not state.",
        },
      ],
    },
  },
  { files: ["**/*.mjs"], languageOptions: { globals: globals.node } },
  { files: ["public/**/*.js"], languageOptions: { globals: globals.browser } },
];
