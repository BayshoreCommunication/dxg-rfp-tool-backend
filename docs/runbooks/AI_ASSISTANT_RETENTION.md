# AI Assistant retention runbook

## Safety boundary

The command is dry-run by default and requires one explicit organization:

```sh
npm run retention:assistant -- --organization=<24-character-mongo-id>
```

Dry-run reports approved policy metadata and eligible counts. It makes no data
changes.

Execution is rejected unless all of these are true:

- the organization has an approved `assistant_retention_policies` row;
- `AI_RETENTION_PURGE_ENABLED=true`;
- `AI_RETENTION_POLICY_APPROVED=true`;
- the operator supplies `--execute`;
- in production only,
  `AI_RETENTION_PRODUCTION_EXECUTION_APPROVED=true`.

No repository or environment enables these flags by default.

## Approval and execution

1. Name the privacy/data owner and production operator.
2. Review provider-storage terms and the policy periods.
3. Check active organization, thread, proposal, and audit legal holds.
4. Apply database migration `043_assistant_retention_privacy`.
5. Insert or update the organization policy in `draft`.
6. Review the dry-run output and dependent record counts.
7. Record approval identity/time and set the policy to `approved`.
8. Take the required backup or point-in-time recovery checkpoint.
9. Run another dry-run and compare the result.
10. Set execution gates only for the bounded maintenance window.
11. Run:

```sh
npm run retention:assistant -- \
  --organization=<24-character-mongo-id> \
  --execute
```

12. Clear the execution environment gates immediately.
13. Re-run dry-run, confirm eligible conversation/event counts are zero, and
    attach the content-free result to the change record.

## What the initial job deletes

- expired, user-deleted Assistant threads not covered by a legal hold;
- their feedback, messages, and citations in dependency order;
- expired content-free Assistant product analytics.

It retains the deletion request as content-free evidence and marks it purged.
It does not delete audit records, proposal analyses, findings, historical
insights, proposal-context evidence, or field-change applications.

## Recovery and incident response

Before purge, the user can restore a conversation through the product and the
request is audited. After purge, recovery depends on the approved backup/PITR
policy and must be handled as a privacy incident/change request; the product
does not promise self-service recovery.

If counts, tenant scope, policy state, or holds are unexpected, stop. Do not set
execution gates. Keep the dry-run output and escalate to the release and privacy
owners.
