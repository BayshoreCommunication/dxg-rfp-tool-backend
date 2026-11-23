# Tenancy migration rehearsal (ORG-501)

What was rehearsed, what it showed, and how to repeat it on a restored production snapshot.
The cutover procedure itself is `ORG_TENANCY_CUTOVER.md` (ORG-502); the commands are described
in `PRODUCTION.md` under "Moving existing customers into their own organizations".

**Status: local rehearsal, plus one production-copy rehearsal that failed (finding 9).** The
first rehearsal on a copy of production, on 2026-11-23, showed the migration putting one
customer's Postgres data in another customer's tenant. That is fixed here; the production-copy
rehearsal has not been repeated with the fix and is still owed before any real run. The rest
of this document describes the local rehearsal of 2026-11-11. On 2026-11-10 the owner decided that, with no production or
staging copy available, the rehearsal runs on a generated fixture in local Docker. No production
data, Atlas, AWS or Secrets Manager was touched. The rehearsal on a restored production snapshot
is still to do, on cutover day, before the real run ("Repeating it on the production snapshot"
below). Nothing here says how long production will take; it says how the run scales and what to
watch.

## What was run

The ORG-107 migration and the ORG-109 verifier, through the same npm commands the cutover uses,
against an isolated stack (`deploy/rehearsal`, compose project `rfpilot501`, MongoDB 7 replica
set on `localhost:37017` and PostgreSQL 16 + pgvector on `127.0.0.1:35432`). As in production,
the migration connected to Postgres as the role that owns the tables, with no superuser and no
`BYPASSRLS`.

```bash
npm run rehearsal:up                           # stack, owner role, all Postgres migrations
npm run rehearsal:seed -- --reset --users=50   # or --users=150
RFPILOT_ENV_FILE=deploy/rehearsal/rehearsal.env npm run rehearsal:run -- --run-id=<id> --out=<dir>
npm run rehearsal:down                         # removes the containers and their data
```

`rehearsal:run` (`scripts/rehearseCustomerOrganizations.ts`) prints the database targets, then
runs these as child processes and times each one:

| Step | Command |
|---|---|
| 00 start-up | `npm run migrate:customer-organizations -- --help` (what starting the process costs) |
| 01 snapshot | `npm run verify:customer-organizations -- --snapshot=<file>` |
| 02 dry run | `npm run migrate:customer-organizations -- --run-id=<id> --from-slug=dxg` |
| 03 apply | `npm run migrate:customer-organizations -- --apply --run-id=<id> --from-slug=dxg` |
| 04 verify | `npm run verify:customer-organizations -- --before=<file> --from-slug=dxg` |
| 05 rollback dry run | `npm run migrate:customer-organizations -- --rollback-run=<id>` |
| 06 rollback | `npm run migrate:customer-organizations -- --rollback-run=<id> --apply` |
| 07 verify | as 04; exits 1 by design, see "Verifier results" |
| 08 apply again | as 03, same run id |
| 09 verify | as 04 |
| 10 apply once more | as 03, same run id (idempotence) |
| 11 verify | as 04 |

Between steps it fingerprints the shared organization (per collection and per tenant table: row
count and a hash of the ids; for memberships, roles and status), checks the holding tenants, and
fingerprints one unrelated customer organization. It deletes the visibility snapshot at the end.

## Fixture

`scripts/seedTenancyRehearsalFixture.ts` builds one shared organization (`dxg`) shaped like
production before Organization Accounts. Every name and email is generated
(`@rehearsal.example.test`). Per customer: a user, settings, a refresh session, three
notifications, and 0 to 12 RFPs (average about 4.4; one heavy customer has 150). RFPs carry
vendor responses, submissions and versions, public access grants, canonical snapshots and an
email campaign; one customer in six has a support ticket with messages. Four customers in five
are projected into Postgres with proposal references, conversations and messages, guidance
reports, source extraction runs, audit events and published outbox events.

About one projected customer in seven has acted on another customer's proposal: a guidance
report and a historical insight report (with its outbox event) under the other customer's
reference (finding 9). The counts and timings below were measured before these rows were added.

Legacy shapes included on purpose: memberships carrying a DXG role (1 in 10), suspended
memberships (1 in 40), accounts with no membership at all (1 in 25), customers with no RFPs, and
customers never projected into Postgres. Three DXG staff accounts stay in the shared
organization with audit events, expert rules and regional pricing factors. A second, ordinary
customer organization with three members must come through untouched.

| | 50 customers | 150 customers |
|---|---|---|
| RFPs | 366 | 803 |
| MongoDB documents in the shared organization | 1,635 | 3,992 |
| Postgres rows in the shared organization | 1,821 | 3,908 |

Counts are for the shared organization before the run, staff included (MongoDB counts include
memberships). At 150 customers: MongoDB vendorresponses 866, proposals 803, notifications 450, publicaccessgrants 433, proposalcanonicalsnapshots 249, vendorsubmissions 194, vendorsubmissionversions 194, users 153, settings 150, refreshsessions 150, emailcampaigns 128, supportmessages 50, supporttickets 25, memberships 147;
Postgres conversation_messages 1,444, proposal_references 672, audit_events 366, conversations 361, outbox_events 361, guidance_reports 311, source_extraction_runs 252, users 123, governed_asset_events 6, governed_assets 6, expert_rules 3, pricing_regional_factors 3.

## Timings

Wall clock per step, in seconds, on an 8 GB laptop shared with three other agents' builds and
test runs (load average 12 to 35 during these runs, swap nearly full). **Every figure here was
measured on 2026-11-11, after the machine restarted.** Runs made on 2026-11-10 were lost with the
restart, before anything was written down, and none of their numbers are used.

Four complete runs exist, in this order: 50 customers (10:51–11:15 BDT, the machine at its
busiest), 150 customers (12:36–13:07), 50 customers again (13:08–13:15) and 50 customers once
more with the final version of the runner (13:53–13:57, the quietest). The table shows the
second and third, which ran back to back. On identical 50-customer data the dry run took 604,
126 and 50 s and the apply 320, 67 and 38 s across the three runs, so read every figure as
good to a factor of two or three either way, and the per-customer column as the useful part:
0.75 to 6 s per customer for an apply on this machine.

The larger size was meant to be 500. It was cut to 150 because the machine could not carry
more: a 200-customer attempt died in its dry run when Postgres restarted under load (finding 6),
and Docker then took several minutes to answer a single command.

| Step | 50 customers | 150 customers | Seconds per customer (50 / 150) |
|---|---|---|---|
| 00 start-up (process only) | 27 | 5 | – |
| 01 snapshot | 6 | 6 | – |
| 02 dry run | 126 | 416 | 2.5 / 2.8 |
| 03 apply | 67 | 604 | 1.3 / 4.0 |
| 04 verify | 4 | 42 | – |
| 05 rollback dry run | 36 | 146 | 0.7 / 1.0 |
| 06 rollback | 33 | 172 | 0.7 / 1.1 |
| 07 verify (exits 1 by design) | 3 | 6 | – |
| 08 apply again | 48 | 366 | 1.0 / 2.4 |
| 09 verify | 5 | 23 | – |
| 10 apply once more (nothing to do) | 4 | 29 | – |
| 11 verify | 6 | 26 | – |
| **Forward path** (01–04) | **3 min** | **18 min** | |
| **Backing out** (05–07) | **1.2 min** | **5.4 min** | |

### What dominates

**The number of customers, far more than the number of rows.** From 50 to 150 customers the
customer count tripled and the rows grew 2.3 times (one heavy customer holds 150 of the RFPs at
both sizes). The dry run grew 3.3 times, tracking customers. Apply and rollback grew 5 to 9
times, but the machine was busier during the 150 run, so these runs cannot say whether the cost
per customer also rises with the size of the shared organization. It may: every update filters
the shared organization's rows. The snapshot rehearsal has to answer that. What is certain is
where the time goes, which is Postgres, and that most of it is fixed per customer:

- Each customer is one Postgres transaction that first lifts and then restores the protections
  on every tenant table: forced row-level security on 124 tables, 60 append-only triggers, and
  87 composite foreign keys made deferrable. That is 542 `ALTER TABLE` statements per customer
  whether they own one row or ten thousand. Measured on its own, with no rows moved, that
  transaction took 0.75 to 1.3 s (six samples, 13:15 BDT).
- Inside it, the move walks all 179 foreign-key edges between tenant tables, twice or more
  (until a pass moves nothing), plus two id-reference sweeps across about 100 tables: at least
  540 `UPDATE` statements per customer, most of which match nothing.
- MongoDB is a small part: one transaction per customer with about 20 `updateMany` calls.
- The verifier is cheap (3 to 45 s) and grows with members and RFPs. Process start-up
  (npm + ts-node) is 5 to 30 s per command here and is included in every step.

The dry run does the same Postgres work as the apply and rolls it back, so it is not a quick
check: it took about as long as the apply (longer in three of four runs). Rollback is cheaper,
about 1 s per customer, because it moves each holding tenant whole without walking the edges.

For the window: budget dry run + apply as roughly 2 × customers × (seconds per customer), and
take the seconds per customer from the snapshot rehearsal, not from this laptop.

## Verifier results

The same in all four runs, at both sizes (`summary.json` of each run):

These runs predate the fourth check, `proposalDataFollowsProposal` (finding 9), and the
cross-acting customers in the fixture; they have not been repeated locally since.

| After | `visibilityUnchanged` | `noCustomerRecordsInSharedOrganization` | `everyProposalHasAnActiveOwner` | Exit |
|---|---|---|---|---|
| apply (04) | true | true (no leftovers in MongoDB or Postgres) | true (0 orphans) | 0 |
| rollback (07) | true | false, as it must be: every customer record is back | false, as before the run | 1 |
| apply again (09) | true | true | true | 0 |
| idempotent re-run (11) | true | true | true | 0 |

- **Dry run changed nothing**: the shared organization's fingerprint was identical before and
  after it.
- **Apply**: 0 failed; `remainingInSharedOrganization` was 0 customers, 0 RFPs, 0 vendor
  responses; only the three staff accounts and their records, DXG's expert rules and regional
  factors stayed.
- **Rollback restored the shared organization exactly**: 0 failed, and the fingerprint after
  rollback equalled the one before the run in every collection and tenant table (same counts,
  same ids), with the same roles and status on every membership and no holding tenant left.
  This is with the rollback fix below; before it, memberships differed (finding 2).
- **The verifier exits 1 after a rollback by design.** Its second check asks whether customers
  have left the shared organization. The third fails here only because the fixture starts with
  orphans (RFPs owned by suspended or membership-less accounts), which rollback faithfully
  puts back. After a rollback the pass criteria are `visibilityUnchanged: true` and an
  unchanged fingerprint, not exit 0.
- **Apply again** produced the same state as the first apply; **applying once more** considered
  0 customers and changed nothing.
- **Holding tenants** (50 and 150): every one is `kind: legacy_holding`, active, with exactly
  one active Planner and no Owner. All are exempt from plan limits (ORG-601): no RFP limit,
  both features on, and the query that takes an RFP slot accepted a holding tenant holding 150
  RFPs against a free-trial limit of 2 (in a transaction that was aborted).
- **The unrelated customer organization** was untouched throughout.

## Findings

| # | Severity | Finding | State |
|---|---|---|---|
| 1 | High | The verifier's Postgres leftover check passed without reading a row when run as the production migration role | Fixed here, with a test |
| 2 | Medium | Rollback left a previously suspended membership active | Fixed here, with a test |
| 3 | Medium | Apply turns a suspended or removed customer into an active Planner, and the verifier cannot see it | Open: owner's decision |
| 4 | High for the cutover plan | Every customer costs 542 `ALTER TABLE` statements under exclusive locks, dry run included, with no lock timeout | Open: for ORG-502 |
| 5 | Low | The scripts' stdout is not pure JSON | Open |
| 6 | Low | A lost Postgres connection crashes the script instead of recording a failed customer | Open |
| 7 | Info | The verifier exits 1 after a successful rollback | For ORG-502 |
| 8 | Medium | The verifier still reports `postgres: "checked"` when the shared organization has no row in Postgres | Open |
| 9 | Critical | A customer who had acted on another customer's proposal took that proposal's Postgres reference and all its AI data into their own holding tenant; the dry run counted the rows twice and the verifier passed | Fixed, with tests. **The production-copy rehearsal has to be repeated with the fix** |

1. **Verifier blind in Postgres (high, fixed).** `findCustomerLeftovers` looked up the shared
   organization in `rfpilot.organizations` before naming an organization for the session. That
   table is under forced row-level security, so the table-owner role production uses (no
   superuser) got no row, the function skipped every Postgres table, and the report still said
   `"postgres": "checked"` with no leftovers. The integration suite connects as a superuser, so
   it never saw this. First seen on 2026-11-10 as `leftovers.postgres: {}` after a rollback (that
   run's output was lost in the restart); with the fix, the same step lists the rows that came
   back (3,881 across eight tables at 150 customers). Fix: set `app.organization_mongo_id` before the lookup
   (`src/modules/tenancy/migrationVerification.ts`). ORG-110's post-placement check uses the
   same function and had the same gap. Test: "the Postgres check sees customer rows as a role
   bound by row-level security". Still true after the fix: if the organization has no Postgres
   row at all, the check has nothing to read and says nothing about it.
2. **Rollback did not restore membership status (medium, fixed).** Apply sets every moved
   membership to `active`; rollback restored roles and organization but not status, so a
   membership that was `suspended` came back `active`. The journal now records the previous
   status and rollback restores it (`mongoTenantMove.ts`, `customerOrganizationMigration.ts`).
   A run journaled before this fix has no status recorded and rolls back as it used to. Test:
   "rollback restores the shared organization exactly" now includes a suspended member.
3. **Apply activates suspended and removed customers (medium, open).** The same line: a customer
   whose membership was suspended or removed becomes an active Planner in their holding tenant.
   They still cannot sign in until placed, but placement (ORG-110) then treats them as any other
   customer. The verifier does not notice, because the snapshot records active members only. If
   production has such memberships, decide before cutover whether they should stay suspended.
   Not changed here: it is ORG-107's stated behaviour, not a slip.
4. **Per-customer DDL and locks (high for planning, open).** See "What dominates". Three
   consequences. The run time is set by the customer count. Each `ALTER TABLE` takes an
   `ACCESS EXCLUSIVE` lock on a tenant table, so with the API, worker or dispatcher connected
   the migration queues behind any open query and blocks everything behind itself, once per
   customer; this applies to the dry run and to both rollback modes too, so none of them is
   safe outside the window. And nothing sets `lock_timeout`, so a forgotten connection holding
   a lock stalls the run silently. Doing the lift and restore once per run instead of once per
   customer would remove most of the cost, but it changes ORG-107's transaction design (one
   customer, one atomic transaction) and was not attempted here.
5. **Stdout is not pure JSON (low).** `MongoDB connection established` and
   `⚠️  MongoDB disconnected` are printed around the report, so piping to `jq` fails. The
   rehearsal runner strips them.
6. **Lost connection (low).** When Postgres restarted under load during a 200-customer dry run,
   `migrate:customer-organizations` died with an unhandled `Connection terminated unexpectedly`
   and a stack trace, exit 1, rather than reporting that customer as failed. It was a dry run,
   so nothing had changed. In an apply the customer in flight would be left journaled as
   `started`, which a re-run or rollback is written to pick up; that was not exercised.
7. **Exit code after rollback (info).** See "Verifier results".
8. **No Postgres row, no warning (medium, open).** The remainder of finding 1: if the shared
   organization was never projected into Postgres, or the verifier is pointed at the wrong
   database, it reads nothing there and still prints `"postgres": "checked"` with no leftovers.
   Before trusting that line at cutover, confirm the organization exists in
   `rfpilot.organizations` (the dry run's per-customer Postgres counts being non-empty shows it
   does). Fixing it means changing a return shape that ORG-110 also uses, so it is left for a
   follow-up.

9. **A proposal's Postgres data went with whoever acted on it (critical, fixed).** Found on
   2026-11-23, on the first rehearsal against a copy of production; the fixture had no customer
   acting on another's proposal, so the local rehearsal could not see it. For each customer the
   move took their `users` row, the proposal references they own, every row a "doer" column
   (actor, initiator, created by, …) names them in, and then everything connected by foreign
   keys in both directions. Customer A had acted on customer B's proposal. A was processed
   first: A's row under B's proposal pulled in the parent it is tied to through
   `organization_id`, up to B's `proposal_references` row, and then every row under that. After
   an apply that reported no failure:
   - B's proposal (MongoDB) was in B's holding tenant; its Postgres reference and all its AI
     data (about 730 requirements, 23 vendor evaluation runs, 6 comparison runs, 13 `ai_jobs`,
     …) were in A's. B had lost the data and A's tenant held another customer's.
   - The dry run counted those rows for both A and B, so its per-customer numbers did not add up
     to what the apply moved.
   - The verifier passed, `visibilityUnchanged` included: it compared what members see in
     MongoDB and looked for leftovers, not where Postgres rows went. The reference's
     `owner_user_id` foreign key is one column, so no constraint broke either.
   - Which customer got the data depended on the order they were processed in.

   **The rule now** (`DECISIONS.md`, 2026-11-23): a proposal's Postgres data follows the
   proposal's owner. `moveCustomerRows` (`src/modules/tenancy/postgresTenantMove.ts`) works in
   three steps. (1) The customer's `users` row, the references they own, and each reference's
   unit: the rows tied to it through `organization_id`, which the database will not let live
   apart from it. (2) Everything still in the shared organization that belongs with a reference
   somebody else owns is set aside for this move: those references, every row pointing at a
   set-aside row by any foreign key or by id, and every parent a set-aside row is tied to
   through `organization_id`. (3) The rows the customer did and everything reachable from what
   has moved, as before, except that a set-aside row never moves. A reference is never moved as
   some row's parent, only by its owner. So a row A did under B's proposal stays in the shared
   organization until B moves and goes with B; if the proposal's owner never moves (DXG staff),
   it stays with that proposal. What is set aside depends only on who owns each reference, so
   the result is the same in any order, and the dry run (each customer in a rolled-back
   transaction against unmoved data) counts each row once.

   **The verifier has a fourth check, `proposalDataFollowsProposal`**: it fails when a proposal
   that exists in MongoDB has its `proposal_references` row in another organization, when a
   reference's owner (`rfpilot.users`) is in another organization than the reference, or when
   a row with a `proposal_reference_id` names a reference outside its own organization. It
   reads every organization in turn, naming each to row-level security as the leftover check
   does, and reports what it read under `misplacedProposalData.checked`. The report lists up to
   50 of each kind with the proposal id and both organizations.

   Tests: `tests-integration/customer-organization-owner-wins.test.ts` (both processing orders,
   as the table-owner role) and `tests/migration-verification.test.js`. The fixture now has
   customers acting on another customer's proposal (about one in seven), and `rehearsal:run`
   records `dryRunDiffersFromApply`.

   Still to know after the fix:
   - **Not run against production data.** Everything above was proven on the integration
     database only. The rehearsal on the production copy must be run again from the start.
   - The set-aside list is built once per customer from every other owner's proposal data in
     the shared organization, in a temporary table (`tenant_move_pinned`, dropped with the
     transaction). That adds Postgres work per customer that grows with the size of the shared
     organization; take the timings from the repeated rehearsal, not from the tables above.
     The migration role needs `TEMPORARY` on the database (PostgreSQL grants it to everyone by
     default); the dry run fails at once if it is missing.
   - A row tied through `organization_id` to two owners' references cannot be placed at all.
     Both customers then fail with a foreign-key error and stay in the shared organization
     (nothing is moved wrongly); no such row was in the integration data.
   - A row that hangs off two owners' proposals by plain foreign keys only stays in the shared
     organization and is reported by `noCustomerRecordsInSharedOrganization`.
   - A historical insight report on A's proposal that cites B's proposal: the citation row is
     tied to B's reference and goes to B's tenant; the report stays with A.
   - Not changed: rows a customer did that are under nobody's proposal (assistant threads,
     audit events, knowledge retrieval queries) still move with whoever did them, and a parent
     tied to such a row still moves with it. A customer who wrote into another customer's
     assistant thread would still take the thread. Assistant threads are personal, so this is
     not expected, but the repeated rehearsal should look for it.
   - MongoDB was not changed and has no such chain: documents move by `userId` or by the
     owner's proposals. One collection follows the doer: `emailcampaigns` move with the user
     who sent them, even when the campaign is for another customer's proposal.

Environment, not the migration: the local stacks probe their containers every 2 s. Under load a
timed-out probe killed a Postgres backend, and Postgres restarted itself in the middle of a
run. The rehearsal stack probes every 15 s for that reason.

## What production will differ in

- **Size and shape.** Unknown until the snapshot is restored: the number of customers in the
  shared organization, RFPs per customer, and which of the 99 movable Postgres tables hold rows.
  The fixture fills 8 of them. AI runs, evidence, vendor evaluations, comparison runs, jobs and
  attempts are empty here and are where production rows will be.
- **Admins in the shared organization.** A customer holding `owner` or `organization_admin`
  there sees every customer's RFPs in the snapshot and only their own afterwards, so the
  visibility check reports them. `PRODUCTION.md` step 3 says to resolve these first; the fixture
  has none.
- **RFPs owned by DXG staff in the shared organization.** The verifier counts every RFP left
  there as a leftover, staff-owned or not. If staff own RFPs in production, the check fails
  until that is decided. Not in the fixture.
- **Locks.** Each customer's Postgres move is one transaction that alters every tenant table
  (see findings). On an idle local database that costs time only. With the API serving, each
  one waits for, and then blocks, every query on those tables. This includes the dry run.
- **The worker, dispatcher and outbox** were not running. Published outbox history moved with
  its customer and came back on rollback. Nothing was pending, publishing or in Redis.
- **Connections.** The migration uses two Postgres connections and one MongoDB connection; the
  verifier one of each. RDS and Atlas limits were not exercised, nor was network latency: every
  statement here was a loopback round trip, and the run is a few thousand statements per customer.
- **Indexes.** The fixture creates the indexes the models declare. Production may carry extra
  or missing ones; a missing `organizationId` index on a large collection slows every step.
- **Managed services.** MongoDB transactions on Atlas (60 s default transaction limit) and RDS
  parameter settings (`lock_timeout`, `statement_timeout`, `idle_in_transaction_session_timeout`
  for the migration role) were not exercised.

## Not rehearsed

- Production data, production scale, and the restore itself.
- Pausing the worker and dispatcher, draining the outbox, resuming them, and the smoke test.
- A failure in the middle of a run (process killed between the Postgres commit and the MongoDB
  commit of one customer). The code journals this as `started` and both a re-run and a rollback
  pick it up; that path was read, not run.
- Sign-in after migration through the HTTP API. The integration suite covers it
  (`customer-organization-migration.test.ts`: a migrated customer is refused with
  `ORGANIZATION_SETUP_REQUIRED`).
- Placing customers (ORG-110) after the migration.

## Repeating it on the production snapshot

For cutover day, before the real run. It needs an isolated restore that nothing else uses.

1. Restore the MongoDB and Postgres snapshots into isolated instances that production traffic
   and the production worker cannot reach. Give the restore its own secret in Secrets Manager
   (for example `rfpilot/rehearsal/app`) holding `MONGODB_URL`, `MONGODB_DB_NAME`,
   `POSTGRES_MIGRATION_URL` (the table-owner role, not a superuser) and `POSTGRES_SSL=true`.
2. Credentials come only through Secrets Manager with `asm-exec`, which resolves
   `{{resolve:secretsmanager:<secret-id>:SecretString:<key>}}` references at run time. Never
   call `get-secret-value`, never paste a connection string into a shell, file, log or chat,
   and do not create an env file for the restore. `rehearsal:run` prints only host, database
   and role.
3. Do not set `RFPILOT_ENV_FILE`, and run from a checkout with no `.env` or `.env.local`
   (`config/env.ts` loads them otherwise).
4. Check the targets. `rehearsal:run` refuses anything but the local rehearsal stack unless
   both targets it printed are repeated back:
   `--confirm-target=<mongo-host>/<database>,<postgres-host>/<database>`. Read both hosts and
   confirm each is the restore, not production, before adding the flag.
5. Mark the platform organization if the snapshot predates it
   (`npm run platform:mark-organization -- --slug=dxg`, then `--apply`).
6. Run it, with every environment variable supplied by `asm-exec` (see the `aws-secrets-manager`
   skill for the exact invocation):
   `npm run rehearsal:run -- --run-id=prod-rehearsal-<date> --out=<private dir> --confirm-target=<mongo-host>/<db>,<postgres-host>/<db>`.
   It stops at the first step that exits unexpectedly and says which.
7. Read `<out>/summary.json`. It passes when: `unchangedByDryRun`, `dryRunDiffersFromApply`,
   `restoredByRollback`, `sameAsFirstApply` and `bystanderUntouched` are all `[]`; every verify
   report shows `proposalDataFollowsProposal: true` with `misplacedProposalData.checked.references`
   above 0; steps 04, 09 and 11 exit 0; step 07
   exits 1 with `visibilityUnchanged: true` (the runner stops if it does not); `customersConsideredOnRerun` is 0; and
   `holdingTenantsFinal` shows as many holding tenants as customers, each with exactly one
   active Planner, none with an Owner, none inactive, none `notExemptFromPlanLimits`.
8. Take the maintenance window from the step times: snapshot + dry run + apply + verify, plus
   rollback dry run + rollback + verify as the reserve for backing out.
9. Delete the output directory (it holds user and RFP ids) and the restore.

The fixture builder is not used for this and cannot be: it refuses anything but the local
rehearsal stack.

`rehearsal:run` starts the migration and verifier through `npm run` and ts-node, so it needs a
checkout with dev dependencies and network reach to the restore. The production image ships
without ts-node and gives an operator no shell, so the cutover itself runs the built scripts as
one-off tasks (`ORG_TENANCY_CUTOVER.md`).
