# CI/CD

> Platform: **GitHub Actions**, repo `BayshoreCommunication/dxg-rfp-tool-backend`.
> Two workflows matter; everything else is legacy.

## Pipelines

### Deploy to AWS — [`.github/workflows/deploy-aws.yml`](https://github.com/BayshoreCommunication/dxg-rfp-tool-backend/blob/main/.github/workflows/deploy-aws.yml)

- **Trigger:** push to `production` (doc-only paths ignored), or manual
  `workflow_dispatch` against that branch. `main` runs CI only.
- **Target environment:** `production` — the only one. The deploy job binds
  to the `production` GitHub *environment*, which scopes its variables.
- **Concurrency:** one run per branch at a time (`aws-deploy-${ref}`), new
  runs queue — they are never cancelled mid-deploy.
- **Auth:** GitHub OIDC only. The job assumes
  `arn:aws:iam::295229565954:role/rfpilot-<env>-github-deploy`; the role's
  trust policy is locked to this repo and branch. **No stored AWS keys.**
- **Inert switch:** the whole deploy job is skipped unless the repository
  variable `AWS_ACCOUNT_ID` is set.

**Steps, in order:**

1. **Quality gates** (`npm run ci`): `contracts:check` → `eslint` →
   `tsc --noEmit` → `migration:check` → `npm test` (Node test runner,
   621 tests, `--runInBand`) → `npm run build`. Plus infra:
   `tsc --noEmit` and `cdk synth --strict -c nag=true` in `deploy/aws`
   (cdk-nag findings fail the build unless explicitly suppressed with a
   rationale in `bin/rfpilot.ts`).
2. **Docker build** of the single multi-entrypoint image.
3. **Trivy scan** — fails on **fixable HIGH/CRITICAL** findings
   (`ignore-unfixed: true`, exceptions in [`.trivyignore`](https://github.com/BayshoreCommunication/dxg-rfp-tool-backend/blob/main/.trivyignore)).
4. **Push immutable image** `sha-<full-git-sha>` to ECR. Promotion-aware:
   if the tag already exists (a re-run of the same commit), it is reused;
   a lost race against a concurrent same-sha push is also tolerated. The
   deploy role has `ecr:DescribeImages` specifically for this check.
5. **Read stack outputs** (cluster, private subnets, migrate SG, ALB DNS)
   from `Rfpilot-<env>-App`.
6. **Run Postgres migrations**: registers a new revision of
   `rfpilot-<env>-migrate` pointing at the *new* image, runs it as a one-off
   Fargate task, waits, and **fails the pipeline unless exit code is 0**.
7. **`cdk deploy Rfpilot-<env>-App Rfpilot-<env>-Observability`** with
   `--exclusively` (never implicitly deploys Data/Network — this guard
   exists because a dependency deploy once reset the app secret) and
   contexts: `imageTag=sha-<sha>`, `env`, plus `certificateArn` /
   `apiDomain` / `frontendUrl` / `adminUrl` from **environment-scoped GitHub
   variables** (`CERTIFICATE_ARN`, `API_DOMAIN` are set on both
   environments; empty values mean HTTP bootstrap mode, so a plain push can
   never strip HTTPS).
8. **Smoke checks** against the ALB DNS name: `GET /` then `GET /health`
   must return 200 (retried up to ~5 min).

- **Approvals:** none currently enforced (the `production` GitHub
  environment exists; adding required reviewers there would gate step 4+).
- **Failure handling:** any step fails the run; migrations failing prevents
  the deploy entirely; a failed ECS rollout is auto-rolled-back by the
  circuit breaker.
- **Rollback:** see [Rollback](rollback.md).
- **Logs:** GitHub → Actions → *Deploy to AWS* → the run → job
  `Build, migrate, deploy (<env>)`. CLI:
  `gh run list --workflow "Deploy to AWS"` / `gh run view <id> --log-failed`.

### Backend CI — runs the same quality gates on pushes/PRs (no deploy). If
*Deploy to AWS* is green, this is green.

### Deploy to DigitalOcean (legacy) — manual `workflow_dispatch` only;
retired. The droplet it targeted is being decommissioned. Do not use.

## When a deployment fails, look here in this order

1. `gh run view <run-id> --log-failed` (or the Actions UI) — which step?
2. **Quality gates**: reproduce locally with `npm run ci`; infra synth
   failures with `cd deploy/aws && npx cdk synth --strict -c nag=true -c env=production`.
3. **Trivy**: the log names the CVE and package. If unfixable upstream, add
   it to `.trivyignore` with a comment; prefer upgrading the dependency.
4. **Image push**: "tag already exists" on a *new* commit should be
   impossible (immutable tags + reuse logic); see the promotion notes above.
5. **Migration task**: exit code appears in the step log; the task's own
   output is in CloudWatch log group `/rfpilot/<env>/migrate` (newest
   stream). Common causes: bad SQL, or the task can't reach RDS.
6. **CDK deploy**: the step log streams CloudFormation events. Look for the
   first `CREATE_FAILED`/`UPDATE_FAILED` — everything after is rollback
   noise. Listener/SG errors → see the Network-stack trap in
   [Architecture](architecture.md#network-layout-per-environment).
7. **Smoke checks failing** with a successful deploy usually means the API
   task is crash-looping: check `/rfpilot/<env>/api` logs — most commonly a
   secret value problem (see [Troubleshooting](troubleshooting.md)).

## Bootstrap-era lessons already encoded in the workflow

- Immutable-tag reuse on promotion (+ race tolerance).
- `--exclusively` on every CDK deploy.
- Migrations run with the new image *before* services roll.
- The first App deploy of a new environment is manual (CI's migrate step
  needs the App stack to exist) — see [Deployment](deployment.md).
