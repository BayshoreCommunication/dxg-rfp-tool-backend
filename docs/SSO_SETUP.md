# Single sign-on setup

Customers sign in with **Google**, **Microsoft** or **their company's OpenID Connect provider**. There is no customer email/password and no emailed code: someone without a Google, Microsoft or company account can't sign in. Endpoint reference: [API.md](API.md#sign-in-google-microsoft-and-company-sso).

## Backend environment

| Variable | Purpose |
| --- | --- |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` | The multi-tenant Entra app (below). Unset turns Microsoft sign-in off. |
| `SSO_SECRET_KEY` | 32 bytes (hex or base64) that seal each organization's client secret. **Required in production**; keep it in Secrets Manager. Rotate by moving the old key to `SSO_SECRET_PREVIOUS_KEYS`. |
| `SSO_CALLBACK_URL` | The redirect URI registered with every IdP. Defaults to `${BACKEND_URL}/api/auth/sso/callback`. |
| `FRONTEND_URL` | Where the callback sends the browser (`/sso/complete`, `/sign-in`). |
| `REDIS_URL` | Holds the 10-minute sign-in state and 60-second handoffs across workers. Without it they live in process memory (single process only). |
| `PASSWORD_SIGN_IN_ENABLED` | Leave unset: customers can also sign up with email, password and an emailed code. `false` turns the password routes off (410) for an SSO-only deployment. |

## Microsoft (one-time, by DXG)

1. Entra admin center → App registrations → New registration.
   - Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**.
   - Redirect URI (Web): the `SSO_CALLBACK_URL` value, e.g. `https://api.av-rfpilot.com/api/auth/sso/callback`.
2. Certificates & secrets → New client secret → put it in `MICROSOFT_CLIENT_SECRET` (note its expiry; rotate before it lapses).
3. Token configuration → Add optional claim → ID token → **`email`** and **`xms_edov`**. Without `xms_edov`, work-account sign-ins are refused with `MICROSOFT_EMAIL_UNVERIFIED` (we don't trust unverified tenant emails, see nOAuth).
4. API permissions: the default `openid`, `email`, `profile` (delegated) are enough. No admin consent is needed for these.
5. Copy the Application (client) ID into `MICROSOFT_CLIENT_ID`.

## Company SSO (per customer, by the customer's Owner or Admin)

Prerequisite: the organization has verified its email domain (Settings → Security → Domains).

1. In the company IdP, create an **OpenID Connect web application**:
   - Sign-in redirect URI: the value shown on the RFPilot Single sign-on card (the backend's `SSO_CALLBACK_URL`).
   - Grant type: authorization code (PKCE is used). Scopes: `openid email profile`.
   - Assign the people or groups who should use RFPilot.
2. In RFPilot → Settings → Security → Single sign-on, enter:
   - **Issuer URL**: Okta `https://<org>.okta.com/oauth2/default` (or the org issuer); Entra `https://login.microsoftonline.com/<tenant-id>/v2.0`; Google Workspace `https://accounts.google.com`; Auth0 `https://<tenant>.auth0.com/`; Keycloak `https://<host>/realms/<realm>`.
   - **Client ID** and **client secret** from step 1.
   - **Domains**: the verified domains whose people sign in here.
3. **Check settings**, then **Turn on**. Try **Sign in with your company** with your own work email.
4. Optional: **Require SSO**. People on those domains can then no longer use Google or Microsoft, and their current sessions end. The Owner is exempt so a broken IdP can't lock the organization out.

What happens at sign-in:
- First sign-in of someone on the domain → joins the organization as **Planner** (an Admin can change the role). Signing in from an invitation gives the invited role instead.
- An existing member is linked to the company identity on first use.
- Company sign-ins skip RFPilot's own 2FA (the company IdP enforces MFA).
- The IdP may only sign in emails on the connection's domains that the organization still has verified.

## Local testing with a mock IdP

```bash
docker run --rm -p 8080:8080 ghcr.io/navikt/mock-oauth2-server:2.1.10
```

Issuer `http://localhost:8080/default` (http is allowed for localhost outside production), any client ID/secret. Its login page lets you type any `sub` and claims JSON, e.g. `{"email":"pat@acme.test","name":"Pat"}`, for an organization that has `acme.test` verified.
