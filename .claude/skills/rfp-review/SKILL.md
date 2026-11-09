---
name: rfp-review
description: Review the current RFPilot change before it is committed or merged - run the project's specialist reviewer agents in parallel on every repo with changes, verify their findings, and report one ranked list. Use before committing a ticket, before opening a PR, or when asked to review a branch.
argument-hint: "[repo name or PR number; default: every repo with changes]"
---

# /rfp-review $ARGUMENTS

## 1. Find the change

For each repo (`dxg-rfp-tool-backend`, `../dxg-rfp-tool-dashboard`, `../dxg-rfp-tool-admin`,
or only the one named in $ARGUMENTS): `git fetch -q origin` then
`git diff --stat origin/main...HEAD` and `git status -s`. Skip repos with no change.
For a PR number, `gh pr diff <n>` and `gh pr checkout <n>` in a worktree first.

## 2. Pick reviewers

| Repo | Agent | When |
|---|---|---|
| backend | `tenant-isolation-reviewer` | Mongo queries, Postgres, migrations, access policy, roles, sharing, invitations, auth, tokens |
| backend | `ai-safety-reviewer` | AI modules, prompts, providers, AI flags, workers, outbox |
| dashboard | `ui-reviewer` | any change under `app/`, `components/`, `lib/` |
| admin | `admin-reviewer` | any change under `app/`, `lib/` |

An agent defined in another repo is only loaded when Claude Code starts in that repo or in the
workspace folder (whose `.claude/agents/` links to all of them). If one is missing, run a
`general-purpose` agent with that agent file's body as its instructions.

When unsure, run it: a clean report is cheap. Also run a general correctness pass
(the built-in `/code-review` skill at medium effort) when the change has non-trivial logic.

Launch all chosen agents **in one message** so they run in parallel. Run each agent from its
repo directory and give it only the scope: repo path, base `origin/main`, and the ticket or PR
goal in one line. Do not pass your own opinion of the code; you want an independent read.

## 3. Verify

Agents can be wrong. For each CONFIRMED or PLAUSIBLE finding, open the cited `file:line` and
check the claim yourself. Drop findings you can disprove; keep the reason. Merge duplicates.

## 4. Report

One list, most severe first: severity, repo, `file:line`, the concrete failure, the fix, and
whether you verified it. Then one line per agent with what it checked. Then:
- critical / high: fix before committing (and re-run the agent that found it);
- medium / low: fix now if small, otherwise list as follow-ups in the PR description.

Do not edit code during the review unless the user asked for fixes.
