import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "contracts/generated/**"],
  },
  {
    files: ["src/**/*.ts", "contracts/**/*.ts", "scripts/migrateProposalV1.ts", "scripts/migrateDxgOrganization.ts", "scripts/migrateOrganizationMemberships.ts"],
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": ["error", { "argsIgnorePattern": "^_" }],
    },
  },
  {
    files: ["src/**/domain/**/*.ts", "src/**/application/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["**/infrastructure/**", "**/http/**", "**/workers/**"],
              message: "Domain/application code must depend on ports, not outer-layer adapters.",
            },
          ],
        },
      ],
    },
  },
);
