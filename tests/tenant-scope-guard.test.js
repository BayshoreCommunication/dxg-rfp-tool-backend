const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// ORG-104 guard: every query against proposal-derived models must name the tenant in its filter,
// or carry a comment on the call line or the line above it: `tenant-scoped: <how>` when the filter
// is a variable built from the tenant or the access policy, `scope-exempt: <reason>` for paths that
// are deliberately not request-scoped (vendor token portal, cron, scripts).
const ROOTS = ["src", "controller", "routes", "middleware", "utils"];
const MODELS = ["Proposal", "VendorResponse", "VendorSubmission", "VendorSubmissionVersion", "VendorSubmissionDraft", "ProposalCanonicalSnapshot", "Notification", "PublicAccessGrant", "Team", "TeamMembership", "RfpShare", "ProposalStatusTransition", "OrganizationVendor", "SupportAccessGrant"];
const METHODS = ["find", "findOne", "findById", "findOneAndUpdate", "findByIdAndUpdate", "findOneAndDelete", "findByIdAndDelete", "updateOne", "updateMany", "deleteOne", "deleteMany", "countDocuments", "exists", "aggregate", "distinct", "replaceOne", "bulkWrite"];
const SCOPE_TOKENS = ["organizationId", "organizationMongoId", "tenantFilter(", "tenantObjectId(", "scopeProposalFilter(", "rfpListScope(", "scoped("];
// Whole files that are deliberately not request-scoped. Keep this list short and the reasons exact.
const EXEMPT_FILES = {
  "src/modules/vendorResponses/infrastructure/mongo/mongoVendorSubmissionDraftRepository.ts":
    "vendor portal: every draft query carries the grant's draft scope (organization, proposal, grant, recipient) or targets a draft row loaded under it; the cleanup cron is cross-tenant",
  "src/modules/vendorResponses/infrastructure/mongo/mongoVendorSubmissionRepository.ts":
    "vendor submission writes: callers authorize first (grant for the portal, access policy for manual entry), then this repository follows ids of the rows it just loaded or created",
  "src/modules/proposals/infrastructure/mongo/canonicalMigrationRepository.ts":
    "used only by scripts/migrateProposalV1.ts, which runs per organization outside any request",
  "utils/cronJobs.ts": "maintenance crons (expiry, purge) are cross-tenant by design",
};
const CALL = new RegExp(`\\b(${MODELS.join("|")})\\.(${METHODS.join("|")})\\(`, "g");

const repoRoot = path.join(__dirname, "..");
const sourceFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full);
    return /\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) ? [full] : [];
  });

// The text between the call's parentheses, so a scope token anywhere in the filter counts.
const argumentsOf = (source, openIndex) => {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === "(") depth++;
    else if (source[i] === ")" && --depth === 0) return source.slice(openIndex + 1, i);
  }
  return source.slice(openIndex + 1);
};

const unscopedCalls = () => {
  const findings = [];
  for (const root of ROOTS) {
    const dir = path.join(repoRoot, root);
    if (!fs.existsSync(dir)) continue;
    for (const file of sourceFiles(dir)) {
      if (EXEMPT_FILES[path.relative(repoRoot, file)]) continue;
      const source = fs.readFileSync(file, "utf8");
      const lines = source.split("\n");
      for (const match of source.matchAll(CALL)) {
        const lineIndex = source.slice(0, match.index).split("\n").length - 1;
        const nearby = `${lines[lineIndex - 1] ?? ""}\n${lines[lineIndex]}`;
        if (/(scope-exempt|tenant-scoped):\s*\S/.test(nearby)) continue;
        const args = argumentsOf(source, match.index + match[0].length - 1);
        if (SCOPE_TOKENS.some((token) => args.includes(token))) continue;
        findings.push(`${path.relative(repoRoot, file)}:${lineIndex + 1} ${match[1]}.${match[2]}`);
      }
    }
  }
  return findings;
};

test("queries on proposal-derived models are tenant-scoped or explicitly exempt", () => {
  const findings = unscopedCalls();
  assert.deepEqual(findings, [], `Unscoped queries (scope them, or add a scope-exempt: <reason> comment):\n${findings.join("\n")}`);
});

test("every exempt file still exists and has a reason", () => {
  for (const [file, reason] of Object.entries(EXEMPT_FILES)) {
    assert.ok(fs.existsSync(path.join(repoRoot, file)), file);
    assert.ok(reason.length > 20, file);
  }
});

test("the guard catches an unscoped query", () => {
  const source = "await Proposal.findOne({ _id: id, userId });";
  const match = [...source.matchAll(CALL)][0];
  assert.ok(match);
  assert.equal(SCOPE_TOKENS.some((token) => argumentsOf(source, match.index + match[0].length - 1).includes(token)), false);
});

module.exports = { unscopedCalls };
