# Incident Response Checklist

> The 60-second triage path. Deep-dive procedures live in
> [Troubleshooting](troubleshooting.md); undo lives in [Rollback](rollback.md).
> Assume `export AWS_PROFILE=rfpilot AWS_REGION=us-east-2`.

```
Production incident reported
        ↓
1. Is the API reachable?
   curl -s https://api.dxg-agency.com/health | jq
        ↓  (timeout → DNS/ALB/SG path in Troubleshooting §"API is down")
2. What does /health say?
   database?  postgres.ready?  queue.ready?  migrationVersion?
        ↓  (a "false" here names the failing dependency)
3. Was there a deploy just now?
   gh run list --repo BayshoreCommunication/dxg-rfp-tool-backend \
     --workflow "Deploy to AWS" --limit 3
   → API blips 30–60s on EVERY deploy (stop-then-start). That's normal.
        ↓
4. Are all services running?
   aws ecs describe-services --cluster rfpilot-production \
     --services api worker dispatcher clamav ai-gateway \
     --query 'services[].{n:serviceName,run:runningCount,state:deployments[0].rolloutState}'
        ↓
5. Which alarms are firing?
   CloudWatch → Alarms → filter "rfpilot-production"
   (No email subscriptions exist yet — you must look.)
        ↓
6. Read the newest api log stream
   aws logs tail /rfpilot/production/api --since 15m
   → boot banner names bad dependencies; stack traces sit next to
     the 500 request lines; search any client "Reference:" uuid.
        ↓
7. Dependency triage (Troubleshooting has the detail)
   Mongo → Atlas status + NAT EIP allowlist (13.58.171.171)
   Postgres → RDS console + connections alarm
   Redis → ElastiCache console (queue work self-heals from the outbox)
   SES → sandbox limits (only verified recipients receive mail!)
   OpenAI → status page / usage limits (AI features degrade, API stays up)
        ↓
8. Caused by the last deploy and not trivially fixable?
   → ROLLBACK (rollback.md): cdk deploy App with the previous sha- tag
        ↓
9. Verify recovery
   /health OK · 5xx alarm green · broken flow re-tested
        ↓
10. Write it down
    Root cause → team channel + docs/operations/ or deploy/aws/STATE.md
    (STATE.md is the living gotcha log — future-you reads it first)
```

## Do-not-do list under pressure

- Don't restart RDS/Redis on a hunch — check logs and alarms first; most
  incidents are app-level or secret-level.
- Don't scale the API service to "help it" — 1 task is a hard invariant
  (crons + in-process fan-out).
- Don't redeploy the Data stack — see the secret-wipe footgun in
  [Secrets](secrets.md#the-secret-wipe-footgun-critical).
- Don't bypass ClamAV fail-closed behavior.
- Don't hand-edit task definitions in the console — every change flows
  through CDK, or it will be silently reverted on the next deploy.

## Escalation

Infrastructure owner/operator: Travis (Bayshore). If AWS itself is
suspected: check the AWS Health Dashboard for us-east-2 before debugging
further.
