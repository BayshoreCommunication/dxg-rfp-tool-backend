---
name: ticket
description: Implement one Organization Accounts ticket (ORG-xxx) end to end across the three RFPilot repos - read the spec, check blockers, branch, build to the acceptance criteria, verify, update project state, commit. Use when asked to "do ORG-401", "start the next ticket", or implement a ticket by ID.
argument-hint: ORG-401
disable-model-invocation: true
---

# /ticket $ARGUMENTS

Paths below are relative to the backend repo. The other repos are `../dxg-rfp-tool-dashboard`
and `../dxg-rfp-tool-admin`; the workspace tracker is `../tasks/`.

## 1. Load the ticket

- Find `**$ARGUMENTS ·` in `docs/specs/ORGANIZATION_ACCOUNTS_TICKETS.md` and read the whole block:
  area tag (BE = backend, DB = dashboard, AD = admin), size, PRD refs, `blocked by`, and every `AC:`.
- Read the PRD sections it cites in `docs/specs/ORGANIZATION_ACCOUNTS_PRD.md`. If it cites a DXG
  decision (`Qn`), read that answer in `docs/specs/dxg-open-questions.html`.
- Check each blocker in the "Organization accounts" table of `docs/PROJECT_STATE.md` and in
  `git log --oneline origin/main`. **Stop and report** if a blocker is not merged.
- Skim `docs/DECISIONS.md` for entries naming the ticket or its blockers.

## 2. Preflight

- `git status -sb` in every repo the ticket touches. Stop if there are unrelated uncommitted changes.
- `git fetch origin` and branch from `origin/main` in each touched repo, using the repo's style:
  `feat/<ticket-id-lowercase>-<short-slug>` (for example `feat/org-401-dashboard-queries`).

## 3. Plan, then build

Write a short plan: each AC mapped to the test that will prove it, plus the files you expect to
change. Then implement. Rules that are easy to miss here:

- **Tenant scope.** Every query on a proposal-derived Mongo model names the tenant
  (`organizationId`, `tenantFilter(`, `scopeProposalFilter(`, `rfpListScope(` ...) or carries a
  `tenant-scoped: <how>` / `scope-exempt: <reason>` comment. `tests/tenant-scope-guard.test.js`
  fails the build otherwise. Access decisions go through `src/modules/identity/domain/rfpAccessPolicy.ts`
  and `src/modules/identity/application/proposalAccess.ts`; do not re-derive roles in a controller.
- **Postgres** tables are under forced organization RLS. A schema change goes through `/migration`.
- **Shared types** in `contracts/` go through `/contract-change` (the dashboard has a copy).
- **API** changes are documented in `docs/API.md` in the same commit.
- **UI copy** says "RFP", not "proposal". Role labels: Owner, Admin, Team Manager, Planner, Viewer
  (`owner`, `organization_admin`, `team_manager`, `planner`, `viewer`). Show error codes as human messages.
- Dashboard server actions live in `app/actions/*.ts` and use `authenticatedBackendFetch`, returning
  `{ success, message, data }`. Copy the look of `components/settings/*`.
- AI stays deny-by-default; never widen `AI_ENVIRONMENT` or capability flags to make a test pass.

## 4. Verify

- `npm run ci` in every touched repo. Fix failures; never skip or delete a failing test.
- If the change touches Postgres, Mongo transactions, auth sessions or migrations:
  `npm run integration:up`, `npm run test:integration`, `npm run integration:down` (needs Docker).
- If it changes a screen, run `/verify-ui` in the dashboard.
- Each AC needs evidence: a test name, a command result, or a screenshot path.

- Run `/rfp-review`. Fix every critical and high finding and re-run the reviewer that raised it.

## 5. Record

- `docs/PROJECT_STATE.md`: update the milestone row in "Organization accounts" and the header
  line if the milestone state changed. Keep it factual: what merged, what is left.
- `docs/DECISIONS.md`: add a row when the ticket changes ownership or a trust boundary, or
  interprets a DXG decision. Date it and name the ticket.
- Update `../tasks/README.md` only if this ticket has its own plan file there.

## 6. Commit and report

- Focused commits on the branch, messages in the repo's style (`Area: what changed`), each ending
  with the Co-Authored-By trailer from the session. Do not push, open a PR or merge unless asked.
- Report: a table of AC -> evidence, commands run with pass/fail, branches and commits per repo,
  anything deferred, and open questions for DXG.
