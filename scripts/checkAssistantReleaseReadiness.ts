import fs from "node:fs";
import path from "node:path";
import {
  ASSISTANT_RELEASE_ENVIRONMENT_INVENTORY,
  evaluateAssistantReleaseReadiness,
  parseAssistantPilotReleaseRecord,
  safeOffEnvironmentIssues,
} from "../src/modules/platformAssistant/releaseReadiness";

const args = process.argv.slice(2);
const help = args.includes("--help");
const requireGo = args.includes("--require-go");
const checkSafeOff = args.includes("--check-safe-off");
const recordArg = args.find((item) => item.startsWith("--record="));

if (help) {
  console.log(`Usage:
  npm run release:assistant:check -- --record=<release-record.json>
  npm run release:assistant:check -- --record=<release-record.json> --require-go
  npm run release:assistant:check -- --check-safe-off

The checker is read-only. It never changes flags, allowlists, data, or deployments.`);
  process.exit(0);
}

if (checkSafeOff) {
  const issues = safeOffEnvironmentIssues(process.env);
  console.log(
    JSON.stringify(
      {
        mode: "safe_off",
        passed: issues.length === 0,
        checked: ASSISTANT_RELEASE_ENVIRONMENT_INVENTORY.filter(
          (item) => item.safeOffValue !== null,
        ).map((item) => item.name),
        issues,
      },
      null,
      2,
    ),
  );
  if (requireGo && issues.length > 0) process.exitCode = 1;
} else {
  if (!recordArg) {
    console.error("A --record=<release-record.json> path is required.");
    process.exit(2);
  }
  const recordPath = path.resolve(recordArg.slice("--record=".length));
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(fs.readFileSync(recordPath, "utf8"));
  } catch {
    console.error("The release record could not be read as JSON.");
    process.exit(2);
  }
  const parsed = parseAssistantPilotReleaseRecord(parsedJson);
  if (!parsed.record) {
    console.log(JSON.stringify({ verdict: "NO-GO", errors: parsed.errors }, null, 2));
    process.exitCode = requireGo ? 1 : 0;
  } else {
    const result = evaluateAssistantReleaseReadiness(parsed.record);
    console.log(JSON.stringify(result, null, 2));
    if (requireGo && result.verdict !== "GO") process.exitCode = 1;
  }
}
