const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// ORG-403 guard: Proposal.lifecycle.stage is derived from status, isDraft and isArchived plus
// vendor, review and award facts. Every code path that writes a proposal is listed here with how
// it keeps the stage current, or why it can't move it. Adding a writer, or another write to a
// listed file, fails this test until someone has decided which it is.
const ROOTS = ["src", "controller", "routes", "middleware", "utils"];
const WRITES = ["create", "insertMany", "findOneAndUpdate", "findByIdAndUpdate", "findOneAndDelete", "findByIdAndDelete", "updateOne", "updateMany", "deleteOne", "deleteMany", "replaceOne", "findOneAndReplace", "bulkWrite"];

// file -> { writes: number of write calls in the file, how: the classification }
const WRITERS = {
  "src/modules/proposalLifecycle/mongoProposalLifecycleRepository.ts": {
    writes: 1,
    how: "the lifecycle itself: compare-and-set of Proposal.lifecycle plus the transition insert",
  },
  "src/modules/proposals/infrastructure/mongo/mongoProposalWriteRepository.ts": {
    writes: 6,
    how: "hooked in the application layer: create, copy, update, status, meta, archive and restore call ProposalLifecycleRecorder after the write; view counts and permanent delete can't move the stage",
  },
  "utils/cronJobs.ts": {
    writes: 2,
    how: "expiry (save) records reason expired with a system actor; the archive purge deletes rows whose history is kept",
  },
  "src/modules/candidateApplication/mongoProposalCandidateMutation.ts": {
    writes: 1,
    how: "no stage effect: content fields on an unsubmitted, unarchived draft only (the filter requires it)",
  },
  "src/modules/conversations/answerFieldWriter.ts": {
    writes: 1,
    how: "no stage effect: content fields on an unsubmitted, unarchived draft only (the filter requires it)",
  },
  "src/modules/roomRecommendation/mongoRoomRecommendationMutation.ts": {
    writes: 1,
    how: "no stage effect: room content on an unsubmitted draft only (the filter requires it)",
  },
  "src/modules/vendorResponses/infrastructure/mongo/mongoVendorResponseQuestionnaireRepository.ts": {
    writes: 1,
    how: "no stage effect: sets proposalSettings.vendorResponseFormat",
  },
  "src/modules/proposals/infrastructure/mongo/mongoPublicProposalAccessRepository.ts": {
    writes: 1,
    how: "no stage effect: increments viewsCount",
  },
  "src/modules/organizationMembers/infrastructure/mongoMembershipStore.ts": {
    writes: 1,
    how: "no stage effect: transfers userId when a member leaves",
  },
};

const repoRoot = path.join(__dirname, "..");
const sourceFiles = (dir) =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sourceFiles(full);
    return /\.ts$/.test(entry.name) && !/\.d\.ts$/.test(entry.name) ? [full] : [];
  });

// Counts writes through whatever name the file imports the Proposal model as, plus document
// writes (`new Proposal(`, `proposal.save(`).
const countWrites = (source) => {
  const names = [...source.matchAll(/import\s+(\w+)\s+from\s+["'][^"']*modal\/proposalsModel["']/g)].map((match) => match[1]);
  if (names.length === 0) return 0;
  let count = 0;
  for (const name of names) {
    count += [...source.matchAll(new RegExp(`\\b${name}\\.(${WRITES.join("|")})\\(`, "g"))].length;
    count += [...source.matchAll(new RegExp(`\\bnew ${name}\\(`, "g"))].length;
  }
  count += [...source.matchAll(/\bproposal\.save\(/g)].length;
  return count;
};

const writers = () => {
  const found = {};
  for (const root of ROOTS) {
    const dir = path.join(repoRoot, root);
    if (!fs.existsSync(dir)) continue;
    for (const file of sourceFiles(dir)) {
      const count = countWrites(fs.readFileSync(file, "utf8"));
      if (count > 0) found[path.relative(repoRoot, file)] = count;
    }
  }
  return found;
};

test("every proposal writer is classified for the lifecycle stage", () => {
  const found = writers();
  const problems = [];
  for (const [file, count] of Object.entries(found)) {
    const entry = WRITERS[file];
    if (!entry) problems.push(`${file}: ${count} unclassified write(s)`);
    else if (entry.writes !== count) problems.push(`${file}: ${count} writes, ${entry.writes} classified`);
  }
  for (const file of Object.keys(WRITERS)) {
    if (!found[file]) problems.push(`${file}: listed but no longer writes proposals`);
  }
  assert.deepEqual(problems, [], `Classify each writer in WRITERS (hook it into the lifecycle, or say why it can't move the stage):\n${problems.join("\n")}`);
});

test("hooked writers still call the lifecycle", () => {
  const read = (file) => fs.readFileSync(path.join(repoRoot, file), "utf8");
  const author = read("src/modules/proposals/application/authorOwnedProposal.ts");
  for (const reason of ["created", "updated", "copied"]) assert.match(author, new RegExp(`reason: "${reason}"`));
  assert.match(author, /delete proposal\.lifecycle/);
  const mutate = read("src/modules/proposals/application/mutateOwnedProposal.ts");
  for (const reason of ["status_changed", "metadata_changed", "archived", "restored"]) assert.match(mutate, new RegExp(`reason: "${reason}"`));
  assert.match(read("src/modules/proposals/composition.ts"), /lifecycle: proposalLifecycleRecorderAdapter/);
  assert.match(read("utils/cronJobs.ts"), /reason: "expired"/);
  assert.match(read("src/modules/vendorResponses/composition.ts"), /withSubmissionLifecycle\(/);
  assert.match(read("src/modules/vendorResponses/composition.ts"), /withDeletionLifecycle\(/);
  assert.match(read("src/modules/publicAccess/composition.ts"), /reason: "vendor_invited"/);
  const comparison = read("controller/comparisonOrchestrationController.ts");
  assert.match(comparison, /proposalLifecycle\.markReviewStarted\(/);
  assert.match(comparison, /proposalLifecycle\.applyComparisonDecision\(/);
});

test("the guard counts writes through the imported model name", () => {
  const source = `import P from "../../modal/proposalsModel";\nawait P.updateOne({}, {});\nconst doc = new P({});\nawait proposal.save();`;
  assert.equal(countWrites(source), 3);
  assert.equal(countWrites("await Proposal.updateOne({}, {});"), 0);
});
