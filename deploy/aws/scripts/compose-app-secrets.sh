#!/usr/bin/env bash
# Fill the rfpilot/<env>/app secret's derivable keys without displaying any
# secret value:
#   - POSTGRES_URL / POSTGRES_MIGRATION_URL  composed from the RDS-generated
#     master secret + the Data stack's DatabaseEndpoint output
#   - REDIS_URL                              composed from the Redis AUTH
#     secret + the RedisPrimaryEndpoint output (rediss://)
#   - JWT_SECRET, OTP_PEPPER, BFF_SHARED_SECRET, ADMIN_SIGNUP_SECRET,
#     AI_SAFETY_IDENTIFIER_SECRET, TELEMETRY_PSEUDONYM_KEY,
#     TWO_FACTOR_ENCRYPTION_KEY, SSO_SECRET_KEY  generated fresh (64 hex chars)
#     when missing or still REPLACE_ME. The last two are encryption keys: once
#     data is sealed under them, never regenerate them (rotate via *_PREVIOUS_KEYS).
#
# Keys that reference external services (MONGODB_URL, OPENAI_API_KEY,
# GOOGLE_CLIENT_ID, SMTP_*) are left alone and listed at the end for the
# operator to fill in the Secrets Manager console. So are MICROSOFT_CLIENT_ID
# and MICROSOFT_CLIENT_SECRET (Microsoft sign-in, docs/SSO_SETUP.md): the Data
# stack's template does not seed them, the API task maps them, so they are
# listed while they are absent or empty. This script never writes them.
#
# Usage:
#   AWS_PROFILE=rfpilot ./compose-app-secrets.sh [production]
set -euo pipefail

ENV_NAME="${1:-production}"
REGION="${AWS_REGION:-us-east-2}"
STACK="Rfpilot-${ENV_NAME}-Data"

stack_output() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

DB_ENDPOINT=$(stack_output DatabaseEndpoint)
REDIS_ENDPOINT=$(stack_output RedisPrimaryEndpoint)
DB_SECRET_ARN=$(stack_output DatabaseSecretArn)
REDIS_AUTH_ARN=$(stack_output RedisAuthSecretArn)
APP_SECRET_ARN=$(stack_output AppSecretArn)

for v in DB_ENDPOINT REDIS_ENDPOINT DB_SECRET_ARN REDIS_AUTH_ARN APP_SECRET_ARN; do
  if [ -z "${!v}" ] || [ "${!v}" = "None" ]; then
    echo "Missing stack output for $v — is $STACK deployed with the latest template?" >&2
    exit 1
  fi
done

export DB_ENDPOINT REDIS_ENDPOINT
export DB_SECRET_JSON=$(aws secretsmanager get-secret-value --region "$REGION" \
  --secret-id "$DB_SECRET_ARN" --query SecretString --output text)
export REDIS_TOKEN=$(aws secretsmanager get-secret-value --region "$REGION" \
  --secret-id "$REDIS_AUTH_ARN" --query SecretString --output text)
export APP_SECRET_JSON=$(aws secretsmanager get-secret-value --region "$REGION" \
  --secret-id "$APP_SECRET_ARN" --query SecretString --output text)

NEW_JSON=$(python3 <<'PY'
import json, os, secrets
from urllib.parse import quote

db = json.loads(os.environ["DB_SECRET_JSON"])
app = json.loads(os.environ["APP_SECRET_JSON"])

pg = "postgresql://{}:{}@{}/rfpilot".format(
    quote(db["username"], safe=""), quote(db["password"], safe=""),
    os.environ["DB_ENDPOINT"])
app["POSTGRES_URL"] = pg
app["POSTGRES_MIGRATION_URL"] = pg
app["REDIS_URL"] = "rediss://:{}@{}".format(
    quote(os.environ["REDIS_TOKEN"], safe=""), os.environ["REDIS_ENDPOINT"])

generated = []
for key in ("JWT_SECRET", "OTP_PEPPER", "BFF_SHARED_SECRET",
            "ADMIN_SIGNUP_SECRET", "AI_SAFETY_IDENTIFIER_SECRET",
            "TELEMETRY_PSEUDONYM_KEY", "TWO_FACTOR_ENCRYPTION_KEY",
            "SSO_SECRET_KEY"):
    if app.get(key, "REPLACE_ME") == "REPLACE_ME":
        app[key] = secrets.token_hex(32)
        generated.append(key)

remaining = {k for k, v in app.items() if v == "REPLACE_ME"}
# Operator-supplied keys the API task maps that the secret template does not
# seed: report them while absent or empty (the API tasks can't start without
# them), but never write them.
for key in ("MICROSOFT_CLIENT_ID", "MICROSOFT_CLIENT_SECRET"):
    if not app.get(key):
        remaining.add(key)
remaining = sorted(remaining)
print(json.dumps({"secret": app, "generated": generated, "remaining": remaining}))
PY
)

python3 -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1])["secret"]))' "$NEW_JSON" | \
  aws secretsmanager put-secret-value --region "$REGION" \
    --secret-id "$APP_SECRET_ARN" --secret-string file:///dev/stdin > /dev/null

echo "Updated $APP_SECRET_ARN (no values displayed)."
echo "Composed: POSTGRES_URL, POSTGRES_MIGRATION_URL, REDIS_URL"
python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print("Generated:", ", ".join(d["generated"]) or "(none — already set)"); print("Still REPLACE_ME or missing (fill in the console):", ", ".join(d["remaining"]) or "(none)")' "$NEW_JSON"
