# RFPilot Documentation

> Canonical entry point for humans and AI agents. Last updated: 2026-07-22. Owner: DXG/Bayshore engineering.

## Start here

Read these three documents, in order:

1. [README](README.md) — documentation map and operating rules.
2. [Project State](PROJECT_STATE.md) — current implementation, commitments, gaps, and next work.
3. [Architecture](ARCHITECTURE.md) — system boundaries, repositories, data ownership, and primary flows.

That sequence is sufficient for a new agent to orient itself. Read topic guides only when the task needs them.

## Project in one paragraph

RFPilot is an event-AV RFP platform. The dashboard serves planners, the admin app manages operational data, and the backend owns the API and governed AI capabilities. Proposal content remains authoritative in MongoDB. PostgreSQL owns AI runs, evidence, knowledge, pricing, reviews, audit, and the outbox. Redis carries reference-only work messages. AI may safely fill empty draft fields when confidence and validation gates pass, but conflicts require review and publication is always human-controlled.

## Documentation map

| Need | Canonical document |
|---|---|
| Current status, commitments, known bugs | [PROJECT_STATE.md](PROJECT_STATE.md) |
| System and repository boundaries | [ARCHITECTURE.md](ARCHITECTURE.md) |
| AI pipeline, governance, pricing | [AI_LAYER.md](AI_LAYER.md) |
| Platform Assistant architecture | [architecture/PLATFORM_ASSISTANT.md](architecture/PLATFORM_ASSISTANT.md) |
| Platform Assistant rollout and rollback | [runbooks/PLATFORM_ASSISTANT_ROLLOUT.md](runbooks/PLATFORM_ASSISTANT_ROLLOUT.md) |
| Client scope and acceptance obligations | [CLIENT_SCOPE.md](CLIENT_SCOPE.md) |
| Remaining work | [ROADMAP.md](ROADMAP.md) |
| Accepted architectural decisions | [DECISIONS.md](DECISIONS.md) |
| Local development and testing | [DEVELOPMENT.md](DEVELOPMENT.md) |
| Data ownership and migrations | [DATABASE.md](DATABASE.md) |
| API discovery and contracts | [API.md](API.md) |
| Recurring failures and recovery | [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |
| Production operations | [runbooks/PRODUCTION.md](runbooks/PRODUCTION.md) |
| **AWS deployment, monitoring, incidents (ops portal)** | [operations/README.md](operations/README.md) |
| Documentation audit and migration map | [DOCUMENTATION_AUDIT.md](DOCUMENTATION_AUDIT.md) |

Detailed component records remain under `architecture/`. They explain implementation history and internals, but their original slice status banners are historical; when they conflict with the canonical set above, the canonical documents win. Executable test guides are under `testing/`; incident procedures are under `runbooks/`.

## Repository map

| Repository | Responsibility | Local documentation |
|---|---|---|
| `dxg-rfp-tool-backend` | Express API, workers, AI, data integrations | `README.md`, this directory |
| `dxg-rfp-tool-dashboard` | Next.js planner experience | `README.md`, `docs/architecture/` |
| `dxg-rfp-tool-admin` | Next.js back office | `README.md` |

## Onboarding checklist

1. Read the three start-here documents.
2. Check `git status` in all three repositories; preserve unrelated work.
3. Read the relevant canonical topic guide and linked detailed record.
4. Confirm feature flags and which of API, worker, and dispatcher are required.
5. Verify changes with the relevant unit/integration tests and, for UI work, the running application.
6. Update `PROJECT_STATE.md` if implementation status, commitments, or priorities changed.

## Update rules

- Keep present truth in the canonical documents; link instead of copying explanations.
- `PROJECT_STATE.md` owns current status. `ROADMAP.md` owns future work. `DECISIONS.md` owns durable rationale.
- A component guide may describe mechanics, but must not redefine client scope or current milestone status.
- Add a date and owner to new durable documents. Archive superseded records under `archive/YYYY-MM/`; do not silently delete evidence.
- Keep proprietary client assets, credentials, and real proposal content out of git.
- Update links when moving a document and record material moves in `DOCUMENTATION_AUDIT.md`.
