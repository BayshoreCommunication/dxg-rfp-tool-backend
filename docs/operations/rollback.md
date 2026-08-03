# Rollback Runbook

> Goal: previous working version serving traffic in under 10 minutes.

## When to roll back

- A deploy introduced user-facing breakage (5xx spike, broken flows) and the
  fix isn't a one-liner you can ship through the pipeline in minutes.
- Smoke checks passed but real traffic exposed a regression.
- **Don't** roll back for: the normal ~30–60s API window during a deploy, a
  failed rollout ECS already auto-reverted (circuit breaker — verify with
  the service's events, then just fix forward), or infra-stack issues
  (those need forward fixes).

## Who

Anyone with the `rfpilot` operator credentials (see
[Developer Access](developer-access.md)). No approval gate is configured —
communicate in the team channel *as* you act, not after.

## 1. Identify the previous good version

```bash
export AWS_PROFILE=rfpilot AWS_REGION=us-east-2; ENV=production
# What is running now (the task definition pins the image tag):
aws ecs describe-services --cluster rfpilot-$ENV --services api \
  --query 'services[0].taskDefinition'
aws ecs describe-task-definition --task-definition <that-arn> \
  --query 'taskDefinition.containerDefinitions[0].image'
# Candidate previous tags (every deploy pushes sha-<git-sha>):
git log --oneline -5 origin/production        # the commit before HEAD
aws ecr describe-images --repository-name rfpilot-backend \
  --query 'sort_by(imageDetails,&imagePushedAt)[-5:].imageTags' --output json
```

## 2. Roll the application back

Redeploy the App stack pinned to the previous image tag (this is the same
mechanism CI uses, so task definitions, secrets, and env all stay coherent):

```bash
cd deploy/aws && npm ci
AWS_PROFILE=rfpilot AWS_REGION=us-east-2 npx cdk deploy Rfpilot-$ENV-App \
  --exclusively --require-approval never \
  -c env=$ENV -c imageTag=sha-<previous-git-sha> \
  -c certificateArn=arn:aws:acm:us-east-2:295229565954:certificate/f6976da6-0174-40b4-86bc-9525267a8b08 \
  -c apiDomain=$([ "$ENV" = production ] && echo api.dxg-agency.com || echo api-staging.dxg-agency.com)
```

> The cert/domain contexts are **required** — omitting them deploys the
> HTTP-bootstrap listener and drops HTTPS.

Git bookkeeping afterwards: `production` must never be force-pushed.
Land the revert forward instead —
`git revert <bad-commit>` on `main`, let staging verify it, then promote.

## 3. Database considerations

- Migrations are **forward-only by policy**. Code rollback is safe against a
  newer schema *if* the migration was backward-compatible (the rule for all
  migrations here — see [Database Migrations](database-migrations.md)).
- A genuinely bad migration: one step back is supported —
  run a one-off task on the **migrate** task definition with command
  `["node","dist/scripts/migratePostgres.js","rollback"]`. Anything worse:
  restore the pre-deploy RDS snapshot (new instance), update
  `POSTGRES_URL`/`POSTGRES_MIGRATION_URL` in `rfpilot/$ENV/app`, force new
  deployments. Details in [`deploy/aws/README.md`](https://github.com/BayshoreCommunication/dxg-rfp-tool-backend/blob/main/deploy/aws/README.md).

## 4. Verify

```bash
curl -s https://api.dxg-agency.com/health | jq          # OK + expected migrationVersion
aws ecs describe-services --cluster rfpilot-$ENV --services api worker dispatcher \
  --query 'services[].{name:serviceName,running:runningCount,rollout:deployments[0].rolloutState}'
# Confirm the running image is the rolled-back tag (step 1 commands)
# Watch the 5xx alarm recover: CloudWatch → Alarms → rfpilot-$ENV-api-5xx
```

Exercise the flow that was broken.

## 5. Communicate & follow up

Announce: what was rolled back, from/to which `sha-` tags, user impact
window, and the forward plan. File the root cause. Add a regression test
before re-promoting. Update `deploy/aws/STATE.md` if the incident taught a
new operational lesson.
