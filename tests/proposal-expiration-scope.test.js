const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const source = fs.readFileSync(path.resolve(__dirname, "..", "utils/cronJobs.ts"), "utf8");
const model = fs.readFileSync(path.resolve(__dirname, "..", "modal/proposalsModel.ts"), "utf8");

test("expiry only sweeps proposals that have actually been published", () => {
  const check = source.slice(source.indexOf("runExpirationCheck"), source.indexOf("purgeArchivedProposals"));
  const query = check.slice(check.indexOf("Proposal.find("), check.indexOf("for (const proposal"));

  // isActive defaults to true, so a query on isActive alone also matches drafts
  // the planner has never submitted. Those were warned about and then closed as
  // "rejected" a week after creation.
  assert.match(model, /isActive:\s*\{\s*type:\s*Boolean,\s*default:\s*true\s*\}/, "isActive default changed; revisit the expiry scope");
  assert.match(query, /isActive:\s*true/, "expiry should still only consider active proposals");
  assert.match(query, /status:\s*\{\s*\$ne:\s*"unsubmitted"\s*\}/, "unsubmitted drafts must be excluded from expiry");
});

test("expiry notifications stay deduplicated per proposal and day", () => {
  const check = source.slice(source.indexOf("runExpirationCheck"), source.indexOf("purgeArchivedProposals"));
  // Repeated sweeps — the job also runs on every process start — must not
  // stack up notifications for the same proposal.
  assert.match(check, /dedupeKey:\s*`proposal-expiring-soon:\$\{proposal\._id\}:\$\{expiryDay\}`/);
  assert.match(check, /dedupeKey:\s*`proposal-expired:\$\{proposal\._id\}`/);
});
