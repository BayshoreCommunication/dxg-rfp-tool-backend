# Tenancy cutover and rollback (ORG-502)

Moves every existing customer out of the shared `dxg` organization into a legacy holding tenant
of their own (ORG-107), verifies it (ORG-109), and says how to back out. One-time, in a
maintenance window, in production.

Read first: [`ORG_TENANCY_REHEARSAL.md`](ORG_TENANCY_REHEARSAL.md) (what was rehearsed, the
timings, findings 1 to 8 referred to below) and `PRODUCTION.md`, "Moving existing customers
into their own organizations".

**What this rests on.** The sequence was rehearsed on a generated fixture in local Docker only,
up to 150 customers, with timings good to a factor of two or three. Production data, the
production deployment (ECS one-off tasks, RDS, Atlas), pausing services and draining the outbox
were not rehearsed. Steps that could not be confirmed from the repository are marked
**OPERATOR TO CONFIRM**; things that are expected to work but were never run are marked
**UNREHEARSED**. Both are listed again at the end.

## What customers will see

- The product is down for the whole window (the API is stopped).
- After cutover, every legacy customer is refused at sign-in with
  `ORGANIZATION_SETUP_REQUIRED` until DXG places them in an organization (ORG-110). This is by
  design (DECISIONS 2026-11-04). Do not cut over without the placement list ready (step 0.6).
- Organizations created since sign-up started creating them (ORG-106) are not touched.

## How commands are run in production

There is no SSH, no ECS Exec, no bastion and no `psql` in the image
(`docs/operations/developer-access.md`). Everything runs as a one-off Fargate task on the
**migrate** task definition, which is the only one holding both `MONGODB_URL` and
`POSTGRES_MIGRATION_URL` (the table-owner role). Secrets are injected by ECS from Secrets
Manager at task start: nobody handles a connection string. If a credential is ever needed
outside a task (the snapshot rehearsal, step 0.1), it comes only through Secrets Manager with
`asm-exec`; never call `get-secret-value`, and never print, paste or log one.

```bash
export AWS_PROFILE=rfpilot AWS_REGION=us-east-2 ENV=production
# OPERATOR TO CONFIRM: the private subnets and the migrate security group (App stack outputs;
# deploy/aws/README.md calls them <PrivateSubnetIds> and <MigrateSecurityGroupId>).
SUBNETS=<PrivateSubnetIds, comma separated>
SG=<MigrateSecurityGroupId>

run_migrate_task() {   # usage: run_migrate_task '<shell command line>'
  TASK=$(aws ecs run-task --cluster rfpilot-$ENV --task-definition rfpilot-$ENV-migrate \
    --launch-type FARGATE \
    --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=DISABLED}" \
    --overrides "{\"containerOverrides\":[{\"name\":\"migrate\",\"command\":[\"sh\",\"-c\",\"$1\"],\"environment\":[{\"name\":\"PGOPTIONS\",\"value\":\"-c lock_timeout=15000\"}]}]}" \
    --query 'tasks[0].taskArn' --output text)
  echo "task: $TASK"
  aws ecs wait tasks-stopped --cluster rfpilot-$ENV --tasks "$TASK"
  aws ecs describe-tasks --cluster rfpilot-$ENV --tasks "$TASK" --query 'tasks[0].containers[0].exitCode'
}
# Reports: aws logs tail /rfpilot/$ENV/migrate --since 30m
```

Three things about this that were never run (**UNREHEARSED**):

- The scripts ran locally through `npm run` and ts-node. In production they are
  `node dist/scripts/migrateCustomerOrganizations.js` and
  `node dist/scripts/verifyCustomerOrganizations.js`. Same code, different entry point.
- The verifier's snapshot is a file. A Fargate task's disk is gone when the task stops, so the
  snapshot, the apply and the verify that reads the snapshot have to be **one task** (step 5).
  The `sh -c` chain that does this was not rehearsed.
- `PGOPTIONS` is how `lock_timeout` is set without changing code (see "Locks"). node-postgres
  reads it; this was not rehearsed. `aws ecs wait tasks-stopped` gives up after 10 minutes;
  for a longer task, repeat the wait.

**Always read the report in the logs, not just the exit code.**

## Locks: why everything needs the window

Each customer is one Postgres transaction that runs 542 `ALTER TABLE` statements, each under an
`ACCESS EXCLUSIVE` lock on a tenant table (finding 4). That is true of the **dry run**, the
**apply**, the **rollback dry run** and the **rollback**. With the API, worker, dispatcher or AI
gateway connected, the migration queues behind any open query and blocks every query behind
itself, once per customer. So:

- None of the four may run while any service is up. There is no safe "dry run the day before"
  against production. Do that on the restored snapshot (step 0.1).
- The scripts set no `lock_timeout`. Without one, a forgotten connection holding a lock stalls
  the run silently. The task wrapper above sets 15 s through `PGOPTIONS`: a blocked statement
  then fails that customer, which is reported as `failed` and retried by re-running the same
  run id. If `PGOPTIONS` turns out not to take effect (the snapshot rehearsal will show it),
  the alternative is `ALTER ROLE <migration role> SET lock_timeout = '15s'` for the window and
  `RESET` afterwards. **OPERATOR TO CONFIRM** which is used.

## Sizing the window

```
window  = pause and drain (step 2)
        + N × (dry-run seconds per customer + apply seconds per customer)
        + snapshot and verify
        + smoke test
reserve = N × (rollback-dry-run + rollback seconds per customer) + verify
book    = window + reserve
```

`N` is the number of customers in the shared organization: the `customers` field of the dry
run on the restored snapshot.

**The per-customer figures must come from the snapshot rehearsal (step 0.1), not from the
table below.** The local figures are from an 8 GB laptop under load, on at most 150 customers,
with every statement a loopback round trip:

| Step | Seconds per customer, local range |
|---|---|
| Dry run | 1.0 to 12 |
| Apply | 0.75 to 6.4 |
| Rollback dry run | 0.7 to 1.0 |
| Rollback | 0.4 to 1.1 |

The cost is mostly fixed per customer, not per row. Whether it also grows with the size of the
shared organization is not settled (apply went from 1.3 to 4.0 s per customer between 50 and
150 on a busier machine). The dry run takes about as long as the apply. If the snapshot
rehearsal has not been done, there is no basis for a window: do not cut over.

## 0. Before the day: go / no-go

Every line must be "yes" or a recorded decision. Any "no" is a no-go.

1. **Snapshot rehearsal done.** The round trip has been run on a restored production snapshot,
   following "Repeating it on the production snapshot" in `ORG_TENANCY_REHEARSAL.md`, and its
   `summary.json` meets the pass criteria there. Take from it: `N`, the per-customer seconds,
   any failed customer, and whether the Postgres leftover counts were non-empty before the
   apply. Note: `npm run rehearsal:run` needs a checkout with dev dependencies and network reach
   to the restore; the production image cannot run it. **OPERATOR TO CONFIRM** where it runs.
2. **Decision: suspended and removed memberships** (finding 3). The apply makes every moved
   customer an active Planner in their holding tenant, including ones whose membership in the
   shared organization was suspended or removed, and the verifier cannot see it. Decide: accept,
   or list those accounts first and deal with them after cutover (do not place them; block the
   user). Record the list before the window; it cannot be reconstructed afterwards except
   from a rollback.
3. **Decision: customers who are admins of the shared organization.** A customer holding
   `owner` or `organization_admin` there sees every customer's RFPs before and only their own
   after, so the verifier reports them as lost visibility. Remove those roles first, or decide
   in advance that those specific differences are expected and write down the user ids.
4. **Decision: RFPs owned by DXG staff in the shared organization.** Staff do not move, and the
   verifier counts every RFP left in the shared organization as a leftover. If staff own RFPs
   there, either reassign them first or decide in advance that exactly those are expected.
   Neither 3 nor 4 was in the rehearsal fixture; this is from reading the verifier.
5. **Platform organization marked**: `platform:mark-organization -- --slug=dxg` has been
   applied (`PRODUCTION.md`, "Shared platform corpus"). Otherwise moved customers lose pricing
   and knowledge grounding.
6. **Placement list ready.** For every legacy customer: new organization or existing one, and
   the role. Customers are locked out until placed. Agree who places them and how fast.
7. **Plans decided.** The list of organizations that get `full_access` (step 9.1).
8. **Code deployed.** The production image contains the ORG-501 fixes (the verifier's Postgres
   check and rollback of membership status), and nobody will deploy during the window: a deploy
   restarts the services and re-runs migrations under the migration.
9. **Backups.** A manual RDS snapshot
   (`aws rds create-db-snapshot --db-instance-identifier <id> --db-snapshot-identifier pre-tenancy-cutover`)
   and an on-demand Atlas snapshot, both complete. **OPERATOR TO CONFIRM** the Atlas step.
10. **Window booked** as sized above, customers told, alarms expected (the tasks-low alarms
    will fire while services are at 0).

## 1. Start of window

1. Note the time. Pick the run id and write it down; it is the only handle for rollback:
   `RUN=cutover-<yyyymmdd>` (letters, digits and hyphens only).
2. Record the current service counts:
   ```bash
   aws ecs describe-services --cluster rfpilot-$ENV \
     --services api worker dispatcher ai-gateway cron \
     --query 'services[].{name:serviceName,desired:desiredCount,running:runningCount}'
   ```
   Expected today: api 1, worker 1 (autoscales to 4), dispatcher 1, ai-gateway 1, cron 0.

## 2. Pause, in this order

The order matters: stop new work first, let queued work finish, then stop the workers.

1. **Stop the API** (this also stops the cron jobs, which run inside it):
   ```bash
   aws ecs update-service --cluster rfpilot-$ENV --service api --desired-count 0
   aws ecs wait services-stable --cluster rfpilot-$ENV --services api
   ```
   Users now get errors from the load balancer. **OPERATOR TO CONFIRM** whether a maintenance
   page is wanted in front; nothing in the repository provides one.
2. **Let the outbox drain and jobs finish**, with the dispatcher, worker and AI gateway still
   running. Drained means, in Postgres:
   ```sql
   SELECT status, count(*) FROM rfpilot.outbox_events
    WHERE status IN ('pending','publishing','failed') GROUP BY 1;   -- no rows
   SELECT count(*) FROM rfpilot.job_attempts WHERE status = 'running'; -- 0
   ```
   **OPERATOR TO CONFIRM how these are read.** Nothing in the repository reports outbox depth
   and production has no SQL access. Two warnings for whoever runs them: the tables are under
   forced row-level security, so the migration role and the app role see **zero rows** without
   an organization set and the count looks drained when it is not (the same trap as finding
   1): run them as the RDS master user. And a `failed` outbox row will not drain by waiting;
   see `DURABLE_JOBS.md`.
   Why it matters: a pending event or a running job carries the shared organization's id. If
   its customer moves underneath it, it runs against the wrong tenant when services resume.
   Stop condition: not drained after 15 minutes → resume the API (step 7) and call it off.
3. **Stop the workers and the dispatcher.** The worker has autoscaling with a minimum of 1, so
   setting the count alone may not hold:
   ```bash
   # OPERATOR TO CONFIRM: suspend or lower the worker's scaling target first, e.g.
   # aws application-autoscaling register-scalable-target --service-namespace ecs \
   #   --resource-id service/rfpilot-$ENV/worker --scalable-dimension ecs:service:DesiredCount \
   #   --min-capacity 0 --max-capacity 0
   for s in worker ai-gateway dispatcher; do
     aws ecs update-service --cluster rfpilot-$ENV --service $s --desired-count 0
   done
   aws ecs wait services-stable --cluster rfpilot-$ENV --services worker ai-gateway dispatcher
   ```
4. **Check nothing is running**: the command from step 1.2 shows `running: 0` for api, worker,
   dispatcher, ai-gateway and cron. Stop condition: anything still running → do not continue.

## 3. Baseline (read only, no locks)

```bash
run_migrate_task "node dist/scripts/verifyCustomerOrganizations.js --from-slug=dxg"
```

Expected: exit 1 (customers are still in the shared organization). Save the report. It is the
reference for a rollback:

- `"postgres": "checked"` and **`leftovers.postgres` is not empty.** This proves the Postgres
  half really reads rows (findings 1 and 8). If it is `{}` while customers have used AI
  features, stop: the verifier is blind, and its pass after the apply would mean nothing.
- `leftovers.mongo` and `leftovers.postgres`: the per-collection and per-table counts of
  customer records. After a rollback they must be exactly these again.
- `orphans.total`: note it. Orphans that exist now (RFPs of suspended or membership-less
  accounts) are not caused by the migration.

## 4. Dry run (takes the locks; about as long as the apply)

```bash
run_migrate_task "node dist/scripts/migrateCustomerOrganizations.js --run-id=$RUN --from-slug=dxg"
```

Expected in the report: `"mode": "dry_run"`, `"postgres": "enabled"`, `"failed": 0`,
`customers` equal to `N` from the snapshot rehearsal, every result `"would_move"`, and
non-empty `postgres` counts for customers who have used AI features.

Stop conditions (nothing has changed; go to step 7 to resume):

- `failed` above 0. A permission error here means the task is not connecting as the table
  owner.
- `"postgres": "skipped"`: the migration role is not configured.
- `customers` far from `N`.
- It runs much longer than the per-customer figure predicts, or customers fail with
  `lock timeout`: something else is connected. Find it before going on.

## 5. Snapshot, apply and verify (one task)

```bash
run_migrate_task "node dist/scripts/verifyCustomerOrganizations.js --snapshot=/tmp/before.json \
  && node dist/scripts/migrateCustomerOrganizations.js --apply --run-id=$RUN --from-slug=dxg; \
  node dist/scripts/verifyCustomerOrganizations.js --before=/tmp/before.json --from-slug=dxg"
```

The verify runs whether or not the apply reported failures, because it is the only chance to
compare against the snapshot. Three reports appear in the log, in order.

**Apply report, expected:** `"mode": "apply"`, `"failed": 0`, every result `"done"`,
`remainingInSharedOrganization` all zero (or exactly the staff-owned RFPs decided in 0.4).

**Verify report, pass criteria (all of them):**

| Check | Pass |
|---|---|
| `"postgres"` | `"checked"`, and step 3 showed it reading rows |
| `visibilityUnchanged` | `true` (or exactly the differences decided in 0.3) |
| `noCustomerRecordsInSharedOrganization` | `true`: `leftovers.mongo` and `leftovers.postgres` both `{}` (or exactly the RFPs decided in 0.4) |
| `everyProposalHasAnActiveOwner` | `true`, `orphans.total` 0 |
| exit code | 0 |

If the apply reported failed customers: re-run it alone with the same run id. It skips
customers already moved and retries the rest:

```bash
run_migrate_task "node dist/scripts/migrateCustomerOrganizations.js --apply --run-id=$RUN --from-slug=dxg"
```

Then verify without the snapshot (`--from-slug=dxg` only; `visibilityUnchanged` reads
`"skipped"`, the other two checks still count). If the same customers fail twice, that is a
rollback trigger.

**If the task dies mid-apply** (lost connection, task stopped): the customer in flight is
journaled as `started` (finding 6). Re-running the same run id is written to finish it and
rollback is written to undo it. Neither was run in rehearsal (**UNREHEARSED**). Re-run the
apply once; if it does not come back clean, roll back.

## 6. Decide

Pass on every line of the table → go to step 7. Otherwise roll back ("Rollback" below) unless
the cause is one of the decisions recorded in step 0.

## 7. Resume

Reverse order of the pause: dispatcher and workers first, API last.

```bash
# OPERATOR TO CONFIRM: restore the worker's scaling target to its previous min/max (1 and 4).
for s in dispatcher worker ai-gateway; do
  aws ecs update-service --cluster rfpilot-$ENV --service $s --desired-count 1
done
aws ecs update-service --cluster rfpilot-$ENV --service api --desired-count 1
aws ecs wait services-stable --cluster rfpilot-$ENV --services dispatcher worker ai-gateway api
```

Never set the API above 1 (`docs/operations/services.md`). Leave cron at 0.

## 8. Smoke test

1. `GET /health` answers 200 with `database: "connected"`, `postgres.ready: true`,
   `queue.ready: true`.
2. A DXG staff account signs in to the admin app and sees the legacy customers list
   (`/api/admin/legacy-customers`) with as many unplaced customers as were moved.
3. A legacy customer's sign-in is refused with `ORGANIZATION_SETUP_REQUIRED`. Expected.
4. A member of an organization created after ORG-106 signs in and sees their RFPs as before.
5. Place one agreed customer (step 9.2), have them sign in, and check they see exactly their
   previous RFPs and can open one.
6. That customer triggers one background job (for example the proposal assistant) and it
   completes: the worker, dispatcher and outbox are working across the new tenant.

Stop condition: 4 or 5 fails → this is a rollback trigger while the window is still open.

## 9. After cutover

1. **Plans (ORG-601, ORG-603).** Every organization is on `free_trial` (2 RFPs, vendor
   responses and RFP intelligence locked) unless set otherwise. Legacy holding tenants are
   exempt and need nothing (rehearsed: a holding tenant with 150 RFPs could still create one).
   But an organization a customer is **placed into** is an ordinary organization on
   `free_trial`. DXG staff set `full_access` in the admin app's Organizations page for DXG's
   own organization and every organization on the list from step 0.7, and for each new
   organization created by a placement if that customer is meant to keep what they had.
2. **Place legacy customers (ORG-110).** In production the API cannot place (it has no
   table-owner role and answers 503 `PLACEMENT_REQUIRES_MIGRATION_ROLE`), so placement runs on
   the migrate task, dry run first, then with `--apply`:
   ```bash
   run_migrate_task "node dist/scripts/placeLegacyCustomer.js --list"
   run_migrate_task "node dist/scripts/placeLegacyCustomer.js --email=<customer> --admin-email=<DXG admin> --new-org='<name>'"
   run_migrate_task "node dist/scripts/placeLegacyCustomer.js --email=<customer> --admin-email=<DXG admin> --org-slug=<slug> --role=planner"
   ```
   A placement takes the same exclusive locks, briefly, for one customer, while the product is
   live. Do them at a quiet time, one at a time. Each is journaled and has its own rollback
   (`--rollback=<runId>`). Placement was not part of the ORG-501 rehearsal; the integration
   suite covers it.
3. **Orphan check.** The API's daily cron logs `[Cron] Orphaned proposals: N` in
   `/rfpilot/production/api`. Check it the morning after: it should be 0, or the number noted
   in step 3 if those accounts were left as they were. Anything new needs an owner reassigned.
4. **Clean up.** Keep the run id and the three reports with the change record. The snapshot
   file died with its task. Keep the RDS and Atlas backups until every customer is placed.
5. **Once customers have been placed or have created anything, rollback by run id is no longer
   clean** (see below). From then on the way back is forward: fix the specific problem.

## Rollback

### Triggers

Roll back, inside the window, if any of these is true and it is not a decision recorded in
step 0:

- The verify after the apply fails any line of the table in step 5.
- The same customers fail the apply twice.
- The task died mid-apply and one re-run did not come back with `failed: 0`.
- Smoke test 4 or 5 fails.
- The window will run out before verify can finish. Rolling back takes roughly a quarter of
  the apply time; decide while the reserve is still there.

Do not roll back after the window just because something looks odd: by then customers may
have been placed. Rollback moves *everything* in each holding tenant back, including anything
created since, and deletes the holding tenant; a placed customer's holding tenant is retired
and their records are elsewhere, which a run-id rollback does not account for. Rolling back
after placements was not rehearsed and is not supported by this runbook.

### Steps

Services must be at 0 (step 2). Both modes take the exclusive locks.

1. **Rollback dry run** (lists what would move back; about 1 s per customer locally):
   ```bash
   run_migrate_task "node dist/scripts/migrateCustomerOrganizations.js --rollback-run=$RUN"
   ```
   Expected: `"mode": "dry_run"`, `customers` equal to the number moved, `"failed": 0`, every
   result `"would_roll_back"`.
2. **Rollback** (about 0.4 to 1.1 s per customer locally), then verify:
   ```bash
   run_migrate_task "node dist/scripts/migrateCustomerOrganizations.js --rollback-run=$RUN --apply; \
     node dist/scripts/verifyCustomerOrganizations.js --from-slug=dxg"
   ```
3. **Pass criteria. Exit 0 is not one of them** (finding 7): after a correct rollback the
   verifier exits 1, because customers are back in the shared organization.

   | Check | Pass |
   |---|---|
   | Rollback report | `"mode": "apply"`, `"failed": 0`, every result `"rolled_back"` |
   | `leftovers.mongo` | identical, collection by collection, to the baseline from step 3 |
   | `leftovers.postgres` | identical, table by table, to the baseline (`audit_events` may be higher) |
   | `orphans.total` | the baseline number |
   | Holding tenants | none left: a second rollback dry run reports `customers: 0` |

   The rehearsal proved more than this: identical ids, not just counts, and identical roles
   and status on every membership. That used the rehearsal runner's fingerprint, which cannot
   run in the production image; counts against the baseline are what production has. Comparing
   visibility against the snapshot is also not available here, because the snapshot died with
   the apply task.
4. Resume (step 7) and run smoke tests 1 and 4. Every customer signs in again as before; their
   sessions from before the window are invalid (membership versions moved forward).
5. If the rollback itself reports failures, re-run it (it retries entries not yet rolled
   back). If it still fails: stop, leave services down, and restore the RDS and Atlas backups
   from step 0.9 (`docs/operations/rollback.md`). Restoring was not rehearsed.

### What was and was not rehearsed

Rehearsed, four times, at 50 and 150 customers: rollback dry run, rollback, restoring the
shared organization exactly, then applying again with the same run id, which works and gives
the same state as the first apply. So a rollback does not burn the run id.

Not rehearsed: rollback of a run that died mid-apply; rollback after any placement; rollback
through ECS tasks; restoring from backups.

## Marked for the operator, and unrehearsed assumptions

**OPERATOR TO CONFIRM**

1. Private subnet ids and the migrate security group for `run-task`.
2. Where the snapshot rehearsal runs (needs dev dependencies and network reach to the restore).
3. Whether `lock_timeout` is set through `PGOPTIONS` on the task or `ALTER ROLE`.
4. Whether a maintenance page goes in front of the stopped API.
5. How the outbox and running-job counts are read in production, and as which role.
6. How the worker's autoscaling is held at 0 and restored.
7. The Atlas on-demand snapshot.

**UNREHEARSED**

1. Everything on production data and at production scale.
2. Running the scripts as `node dist/scripts/*.js` in one-off ECS tasks, including the single
   task that chains snapshot, apply and verify, and `/tmp` as the snapshot location.
3. `PGOPTIONS` carrying `lock_timeout` into the scripts' connections.
4. Pausing services, draining the outbox, resuming, and the smoke test.
5. Recovery from a task that dies mid-apply.
6. The verifier's behaviour with customer admins or staff-owned RFPs in the shared
   organization (read from the code).
7. Counts against the baseline as the rollback check (the rehearsal used a stricter one).
8. Placement after cutover, and any rollback after a placement.
