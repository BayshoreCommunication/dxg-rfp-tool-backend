import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { compileFromFile } from "json-schema-to-typescript";

const root = process.cwd();
const outputDir = path.join(root, "contracts", "generated");
const checkOnly = process.argv.includes("--check");

const contracts = [
  ["proposal/v1", "proposal.v1.schema.json", "proposal-v1.ts"],
  ["proposal/v1", "proposal-extraction-patch.v1.schema.json", "proposal-extraction-patch-v1.ts"],
  ["proposal/v1", "proposal-public.v1.schema.json", "proposal-public-v1.ts"],
  ["vendor-response/v1", "vendor-response-questionnaire.v1.schema.json", "vendor-response-questionnaire-v1.ts"],
  ["vendor-response/v1", "vendor-response.v1.schema.json", "vendor-response-v1.ts"],
  ["vendor-response/v1", "vendor-response-calculation.v1.schema.json", "vendor-response-calculation-v1.ts"],
  ["vendor-response/v1", "vendor-response-validation-error.v1.schema.json", "vendor-response-validation-error-v1.ts"],
  ["vendor-response/v1", "vendor-response-workspace.v1.schema.json", "vendor-response-workspace-v1.ts"],
];
const metadataContracts = [["proposal/v1", "proposal-form-ui.v1.json"]];
const manifestSchemaKey = (contractDir, name) =>
  contractDir === "proposal/v1" ? name : `${contractDir}/${name}`;

const compileOptions = (schemaDir, contractDir) => ({
  bannerComment: `/* AUTO-GENERATED from contracts/${contractDir}. Do not edit directly. */`,
  cwd: schemaDir,
  additionalProperties: false,
  ignoreMinAndMaxItems: contractDir === "vendor-response/v1",
  style: {
    bracketSpacing: true,
    printWidth: 100,
    semi: true,
    singleQuote: false,
    tabWidth: 2,
    trailingComma: "all",
    useTabs: false,
  },
});

await mkdir(outputDir, { recursive: true });

let stale = false;
const schemaHashes = {};
for (const [contractDir, schemaName, outputName] of contracts) {
  const schemaDir = path.join(root, "contracts", contractDir);
  const schemaContent = await readFile(path.join(schemaDir, schemaName));
  schemaHashes[manifestSchemaKey(contractDir, schemaName)] = createHash("sha256")
    .update(schemaContent)
    .digest("hex");
  const generated = await compileFromFile(
    path.join(schemaDir, schemaName),
    compileOptions(schemaDir, contractDir),
  );
  const outputPath = path.join(outputDir, outputName);

  if (checkOnly) {
    const current = await readFile(outputPath, "utf8").catch(() => "");
    if (current !== generated) {
      stale = true;
      process.stderr.write(`Generated contract is stale: ${outputName}\n`);
    }
  } else {
    await writeFile(outputPath, generated, "utf8");
  }
}
for (const [contractDir, contractName] of metadataContracts) {
  const contractContent = await readFile(path.join(root, "contracts", contractDir, contractName));
  schemaHashes[manifestSchemaKey(contractDir, contractName)] = createHash("sha256")
    .update(contractContent)
    .digest("hex");
}

const manifest = `${JSON.stringify({
  contractRelease: "proposal.v1+vendor-response.v1",
  generatedAt: null,
  schemas: schemaHashes,
}, null, 2)}\n`;
const manifestPath = path.join(outputDir, "manifest.json");

if (checkOnly) {
  const current = await readFile(manifestPath, "utf8").catch(() => "");
  if (current !== manifest) {
    stale = true;
    process.stderr.write("Generated contract manifest is stale\n");
  }
} else {
  await writeFile(manifestPath, manifest, "utf8");
}

if (stale) {
  process.exitCode = 1;
}
