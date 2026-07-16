import { readFile, mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { compileFromFile } from "json-schema-to-typescript";

const root = process.cwd();
const schemaDir = path.join(root, "contracts", "proposal", "v1");
const outputDir = path.join(root, "contracts", "generated");
const checkOnly = process.argv.includes("--check");

const contracts = [
  ["proposal.v1.schema.json", "proposal-v1.ts"],
  ["proposal-extraction-patch.v1.schema.json", "proposal-extraction-patch-v1.ts"],
  ["proposal-public.v1.schema.json", "proposal-public-v1.ts"],
];

const compileOptions = {
  bannerComment:
    "/* AUTO-GENERATED from contracts/proposal/v1. Do not edit directly. */",
  cwd: schemaDir,
  additionalProperties: false,
  style: {
    bracketSpacing: true,
    printWidth: 100,
    semi: true,
    singleQuote: false,
    tabWidth: 2,
    trailingComma: "all",
    useTabs: false,
  },
};

await mkdir(outputDir, { recursive: true });

let stale = false;
const schemaHashes = {};
for (const [schemaName, outputName] of contracts) {
  const schemaContent = await readFile(path.join(schemaDir, schemaName));
  schemaHashes[schemaName] = createHash("sha256")
    .update(schemaContent)
    .digest("hex");
  const generated = await compileFromFile(
    path.join(schemaDir, schemaName),
    compileOptions,
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

const manifest = `${JSON.stringify({
  contractRelease: "proposal.v1",
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
