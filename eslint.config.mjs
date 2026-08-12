import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "contracts/generated/**"],
  },
  {
    files: ["src/**/*.ts", "contracts/**/*.ts", "config/postgres.ts", "controller/platformAssistantController.ts", "controller/historicalInsightsController.ts", "controller/requirementRegistryController.ts", "routes/platformAssistantRoute.ts", "routes/historicalInsightsRoute.ts", "routes/requirementRegistryRoute.ts", "scripts/migrateProposalV1.ts", "scripts/migrateDxgOrganization.ts", "scripts/migrateOrganizationMemberships.ts", "scripts/migratePostgres.ts", "scripts/backfillPostgresProposalReferences.ts", "scripts/backfillIdentityProjections.ts", "scripts/backfillVendorSubmissionVersions.ts", "scripts/cleanupAssistantRetention.ts", "scripts/checkAssistantReleaseReadiness.ts", "scripts/verifyAuthRefreshE2E.ts", "scripts/verifyDocumentIngestionE2E.ts", "scripts/verifyDurableJobsE2E.ts", "scripts/verifyKnowledgeIngestionE2E.ts", "scripts/verifyKnowledgeReviewE2E.ts", "scripts/verifyKnowledgeRetrievalE2E.ts", "scripts/verifyProposalContextE2E.ts", "scripts/verifyRetentionSweepE2E.ts", "scripts/platformAssistantEval.ts", "scripts/startCronWorker.ts", "scripts/startDurableWorker.ts", "scripts/startDurableDispatcher.ts", "scripts/startAiGatewayWorker.ts"],
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
