# Documentation Audit and Migration Map

> Purpose: record the 2026-07-22 documentation cleanup. Owner: engineering. Status labels: canonical, keep, archive, update, delete candidate.

## Outcome

Current knowledge now starts in `docs/README.md` and is consolidated into focused canonical guides. Historical approvals, evidence, plans, and conversation artifacts were archived rather than deleted. Detailed component records and executable runbooks remain available.

## Inventory by category

| Category | Files / location | Classification |
|---|---|---|
| Canonical project knowledge | `README.md`, `PROJECT_STATE.md`, `ARCHITECTURE.md`, `AI_LAYER.md`, `CLIENT_SCOPE.md`, `ROADMAP.md`, `DECISIONS.md`, `DEVELOPMENT.md`, `DATABASE.md`, `API.md`, `TROUBLESHOOTING.md` | Canonical |
| Detailed backend design | `architecture/*.md` | Keep as implementation records; old slice status text is historical and needs gradual header normalization |
| Operations | `runbooks/*.md`, `deploy/DIGITALOCEAN.md` | Keep; `KNOWLEDGE_RETRIEVAL.md` and `PROPOSAL_CONTEXT_TEST.md` need current-flag review |
| Active testing | `testing/GOLD_EVALUATION.md`, `testing/INTEGRATION_SUITE.md`, fixtures | Keep |
| Repository onboarding | backend/dashboard/admin `README.md`, dashboard architecture docs, scripts/src/utils/font READMEs | Keep; dashboard/admin generated starter READMEs need updating |
| Pre-implementation plans and ADRs | `archive/2026-07/pre-consolidation-root/` | Archive |
| Slice approval and authorization packs | `archive/2026-07/approval-packs/` plus root historical set | Archive |
| Slice test evidence | `archive/2026-07/evidence/` | Archive |
| Superseded manual slice guides | Formerly `testing/SLICE_*_MANUAL_TEST_GUIDE.md` | Deleted after preserving acceptance outcomes in evidence records |
| Generated presentation notes | workspace `outputs/.../RFPilot-AI-Layer-Diagrams.md` | Delete candidate; reproducible output, retained because outputs may be user-owned |
| Scratch/session files | archived `conversation.md`, `chat-starter.txt`, `demo-event-brief.txt` | Archive |

## Duplicate and conflict analysis

- The root technical design, plain-language confirmation, requirements confirmation, and backlog repeated scope, architecture, roadmap, and acceptance content. Their durable conclusions are consolidated into `CLIENT_SCOPE.md`, `ARCHITECTURE.md`, `AI_LAYER.md`, and `ROADMAP.md`.
- Root `ARCHITECTURE.md` described the pre-AI application and duplicated repository/run instructions. Current boundaries are now in `docs/ARCHITECTURE.md`.
- Approval packs and evidence files repeat slice design details but preserve authorization and acceptance history, so they are archived. Obsolete procedural manual guides were removed after their acceptance outcomes were preserved in evidence records.
- Several detailed architecture files retain obsolete authorization language. The canonical index now establishes precedence; gradual header updates remain safer than rewriting historical bodies.
- The two Next.js starter READMEs contain generic framework text and do not explain their applications.

## Migration map

| Old location | New authority |
|---|---|
| workspace `ARCHITECTURE.md` | `docs/ARCHITECTURE.md` |
| `RFPilot_AI_Intelligence_Layer_Technical_Design.md` | `ARCHITECTURE.md`, `AI_LAYER.md`, `DATABASE.md`, `API.md` |
| requirements/plain-language confirmation | `CLIENT_SCOPE.md` |
| implementation backlog and milestone status files | `PROJECT_STATE.md`, `ROADMAP.md` |
| decision register and ADRs | `DECISIONS.md`; full originals in archive |
| provider benchmark protocol | `testing/GOLD_EVALUATION.md`, with full protocol in archive |
| slice approvals and evidence | `archive/2026-07/{approval-packs,evidence}/` |
| slice manual guides | Deleted; current testing authority is `testing/GOLD_EVALUATION.md` and `testing/INTEGRATION_SUITE.md` |

## Deletion recommendations

Seven obsolete slice manual-test guides were deleted after the linked acceptance records were made self-contained. Safe future deletions are `.DS_Store`, generated presentation output after confirming it is reproducible and unneeded, and empty legacy directories. Deletion of historical client authorization or acceptance evidence is not recommended.

## Remaining gaps

- Replace generic dashboard/admin READMEs with application-specific setup and ownership maps.
- Generate an OpenAPI specification from runtime schemas.
- Normalize metadata headers on retained architecture/runbook documents and mark historical slice sections explicitly.
- Reconcile old test-only flag examples with `AI_ENVIRONMENT` and current feature names.
- Add a repository-wide link checker and documentation lint step.
- Decide whether root-level documentation should live in a dedicated umbrella repository; the workspace root is not itself versioned.
