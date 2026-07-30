import "../config/env";
import { closePostgres } from "../config/postgres";
import {
  executeAssistantRetention,
  previewAssistantRetention,
} from "../src/modules/platformAssistant/retentionPolicy";

const organization = process.argv
  .find((value) => value.startsWith("--organization="))
  ?.split("=")[1]
  ?.trim();
const execute = process.argv.includes("--execute");

const help = (): void => {
  console.log(
    "Usage: ts-node scripts/cleanupAssistantRetention.ts --organization=<mongo-id> [--execute]",
  );
  console.log(
    "Default is dry-run. Execution also requires the approved policy and explicit environment safety gates.",
  );
};

const main = async (): Promise<void> => {
  if (process.argv.includes("--help")) {
    help();
    return;
  }
  if (!organization) {
    throw new Error("--organization=<mongo-id> is required");
  }
  const preview = await previewAssistantRetention(organization);
  console.log(JSON.stringify({ mode: "dry-run", ...preview }, null, 2));
  if (!execute) return;
  const result = await executeAssistantRetention(organization);
  console.log(JSON.stringify({ mode: "execute", ...result }, null, 2));
};

void main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(closePostgres);
