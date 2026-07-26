# DXG RFP Tool — Project Architecture

The DXG RFP Tool is a SaaS platform for creating, distributing, and managing **RFPs (Requests for Proposal) for live / hybrid / virtual event AV production**. Event planners build detailed structured proposals (venue, room-by-room AV specs, budget, etc.), email them to vendors via tracked campaigns, share public links, and collect vendor responses — with AI-assisted extraction of proposal data from uploaded documents.

The platform is split across **three repositories**:

| Repo | Role | Stack | Default port / host |
|---|---|---|---|
| [`dxg-rfp-tool-backend`](dxg-rfp-tool-backend/) | REST API + WebSocket + cron jobs | Node.js, Express 4, TypeScript, MongoDB (Mongoose 8) | `:8000` → `api.dxg-agency.com` |
| [`dxg-rfp-tool-dashboard`](dxg-rfp-tool-dashboard/) | Customer-facing app (proposal authors + public vendor pages) | Next.js 16 (App Router), React 19, NextAuth v5, Tailwind v4 | `:3000` → `dxg-rfp-tool-dashboard.vercel.app` |
| [`dxg-rfp-tool-admin`](dxg-rfp-tool-admin/) | Internal admin / back-office panel | Next.js 16 (App Router), React 19, NextAuth v5, Tailwind v4 | `:3000` → `dxg-rfp-tool-admin.vercel.app` |

## System Overview

```
                                ┌──────────────────────────────┐
   Proposal owners (customers)  │  dxg-rfp-tool-dashboard      │
   Public vendors (no login) ──▶│  Next.js 16 · NextAuth v5    │
                                │  Server Actions as API layer │
                                └───────────────┬──────────────┘
                                                │  REST (Bearer JWT)
                                                │  + WebSocket (notifications)
                                                ▼
   Admins / super admins        ┌──────────────────────────────┐      ┌─────────────────────┐
        │                       │  dxg-rfp-tool-backend        │─────▶│ MongoDB             │
        ▼                       │  Express · TypeScript        │      │ (dxg_rfp_tool_db)   │
   ┌───────────────────────┐    │  JWT auth · cron · WS        │      └─────────────────────┘
   │ dxg-rfp-tool-admin    │───▶│                              │─────▶ OpenAI (gpt-4o)  — AI extraction
   │ Next.js 16 · NextAuth │    │                              │─────▶ Resend / SMTP    — tracked email
   └───────────────────────┘    │                              │─────▶ DO Spaces (S3)   — file storage
                                └──────────────────────────────┘─────▶ ImgBB            — image fallback
```

Both frontends deploy to **Vercel**; the backend runs as a long-lived Node process on a **DigitalOcean droplet** (PM2 + Nginx, `deploy/` folder) — it also has a Vercel serverless config, but **WebSockets and cron jobs only run in the long-lived deployment**.

## Core Domain Model (MongoDB)

All data lives in the backend's MongoDB (`dxg_rfp_tool_db`). Models are in `dxg-rfp-tool-backend/modal/` (note: directory name is a misspelling of "model").

- **User** — `name`, `email`, bcrypt `password`, `googleId`, `role` (`customer | admin | super_admin`), `isBlocked`. Customers use the dashboard; admins use the admin panel.
- **Proposal** — the central entity. Owned by a `userId`; `status` (`unsubmitted → submitted → reviewed → approved/rejected`), lifecycle flags (`isDraft`, `isFavorite`, `isArchived`, `isCopy`, `isActive`, `isOpen`), `viewsCount`, and a large embedded structured document mirroring the 10-step wizard: `event`, `venueSchedule`, `roomByRoom[]`, `production`, `hybridVirtual`, `contentCreative`, `videoRecordingStep`, `venue`, `uploads`, `budget`, `contact`.
- **EmailCampaign** — a proposal email blast: `recipients[]` each with a unique `trackingId` and `sentAt/openedAt/clickedAt` timestamps, plus aggregate counters (`sentCount`, `openedCount`, `clickedCount`, `vendorResponseClickCount`).
- **VendorResponse** — a vendor's public reply to a proposal: `vendorName`, `email`, `message`, `documents[]`, `isRead`. Unique per `{proposalId, email}`.
- **Notification** — per-user notifications (`proposal_view`, `proposal_expiring_soon`, `proposal_expired`, `vendor_response`) with a `dedupeKey` unique index to prevent duplicates; delivered live over WebSocket.
- **Settings** — per-user branding (logo, colors, fonts), proposal defaults (currency, language, **expiryDate** — drives the expiration cron), and signatures.
- **Otp** — email OTPs for signup / password reset, auto-deleted via TTL index.

Relationships: User 1—N Proposal / EmailCampaign / VendorResponse / Notification / Settings; Proposal 1—N EmailCampaign / VendorResponse.

## Key Flows

### Authentication
- **Backend** issues stateless **JWTs** (30-day expiry, payload `{userId, email, role}`); `authenticate` + `authorize(...roles)` middleware guard routes.
- **Dashboard** (customers): NextAuth v5 with Credentials (`POST /api/auth/login`) and Google OAuth providers. The backend `accessToken` is stored in the NextAuth JWT session and forwarded as `Authorization: Bearer` by every server action. Signup and password reset are **email-OTP based** (send → verify → register/reset). ⚠️ The backend's `POST /api/auth/google` trusts client-supplied Google profile fields — it does not verify the Google ID token server-side.
- **Admin panel**: NextAuth v5 Credentials only, against `POST /api/auth/admin/signin`. Middleware requires an admin/super_admin role for every route. Destructive actions (delete/block clients, admin-user CRUD) are additionally **super-admin gated** server-side.

### Proposal creation (dashboard)
1. Owner runs the **10-step wizard** (`components/proposals/AddNewProposal.tsx` orchestrating step components): Event Overview → Venue & Schedule → Room-by-Room AV → Hybrid/Virtual → Content & Creative → Video Recording → Venue & Technical → Budget → Uploads & Co-Vendors → Contact & Submit.
2. Optionally, the owner uploads an existing RFP document (PDF/DOCX/CSV) and the backend's **AI extraction** endpoint (`POST /api/extract-proposal`) parses it (`pdf-parse` / `mammoth`) and sends the text to **OpenAI gpt-4o** (JSON mode) to pre-fill the wizard.
3. Files (support docs, AV quotes, logos) upload to **DigitalOcean Spaces** via the backend.

### Distribution & tracking
1. Owner sends the proposal to vendor emails (`POST /api/emails/send`) — delivered via **Resend** (primary) or SMTP fallback.
2. Each recipient gets a unique `trackingId`; public backend endpoints (`GET /api/emails/open/:trackingId`, `/click/:trackingId`, `/vendor-click/:trackingId`) serve tracking pixels / redirects and update campaign stats.
3. Recipients view the proposal via public dashboard routes (`/proposal-view/[slug]`, `/proposal/[slug]`) — no login required. The dashboard proxies these public reads through its own route handlers (using a server-only `BACKEND_API_KEY`).

### Vendor responses
Vendors submit a response (name, message, documents) on the public `/vendor-response/[slug]` page — no account needed. One response per email per proposal (enforced by a unique index). The proposal owner gets a real-time notification and reviews responses in their inbox.

### Real-time notifications
The backend runs a **hand-rolled RFC6455 WebSocket server** (no socket.io/ws library) at `/api/notifications/ws?token=<JWT>`. The dashboard sidebar keeps a connection open for live `notification:new` / unread-count events. Notifications are also persisted and paginated over REST.

### Background jobs (backend, `setInterval`-based)
- **Expiration check** (every 12h): marks proposals past each user's configured expiry as inactive/rejected and emits expiring-soon/expired notifications.
- **Archive purge** (every 24h): hard-deletes proposals archived more than 30 days ago.

## Backend API Surface

All routes mounted under `/api/*` in `server.ts`:

| Base path | Purpose | Auth |
|---|---|---|
| `/api/auth` | OTP signup, login, Google, admin signin, password reset, `/me` | mostly public |
| `/api/proposals` | Proposal CRUD, copy, status/meta patches, restore, file upload, view counting | protected; `GET /:id` uses optional-auth for public sharing |
| `/api/emails` | Send campaigns, list, stats; open/click tracking endpoints | tracking public, rest protected |
| `/api/vendor-responses` | Public submit + duplicate check; owner inbox reads | submit public, reads protected |
| `/api/notifications` | List, unread count, mark read; WS at `/ws` | protected |
| `/api/extract-proposal` | AI document → proposal extraction (gpt-4o) | protected |
| `/api/settings` | Branding / proposals / signatures settings | protected |
| `/api/dashboard` | Customer dashboard KPIs | protected |
| `/api/admin`, `/api/admin-user`, `/api/all-clients` | Admin overview, admin-user CRUD, client management (block/delete) | admin / super_admin |
| `/api/users` | Current-user profile | protected |

## Frontend Architecture (both Next.js apps)

The dashboard and admin panel share the same architectural pattern:

- **App Router with route groups**: `(auth)` for public auth pages, `(page)` for the authenticated shell; the dashboard additionally has `(proposals-public)` and `(proposals-user)` groups for no-login vendor/recipient pages.
- **Server Actions as the API layer** (`app/actions/*.ts`): each domain file wraps `fetch(${BACKEND_URL}/api/...)` with the session's Bearer token, `cache: "no-store"`, and a normalized result shape. There is no axios/shared client and **no client-state library** (no Redux/Zustand/React Query) — Server Components await actions directly; mutations call `revalidatePath()`.
- **Middleware-based route protection**: `middleware.ts` runs NextAuth's `auth()` per request, redirects unauthenticated users to `/sign-in` with a sanitized `callbackUrl`.
- **Styling**: Tailwind CSS v4 (CSS-first config in `globals.css`), `lucide-react` icons, `react-toastify` toasts, per-route `loading.tsx` skeletons.
- **Testing**: the dashboard has Jest + Testing Library with co-located `*.test.tsx` files; the admin panel has no test setup.

Dashboard-specific highlights: the 10-step wizard (`AddNewProposal.tsx`, ~2000 lines), the RFP template renderer (`proposalTemplate/ProposalRfpTemplate.tsx`, two templates), client-side PDF generation (`jspdf`), the AI-extraction upload UI, the email campaign dashboard, and the WebSocket notification client in the sidebar.

## External Services

| Service | Used by | Purpose |
|---|---|---|
| **MongoDB** (Atlas) | backend | Primary datastore |
| **OpenAI** (`gpt-4o`) | backend | Extract proposal fields from uploaded RFP documents |
| **Resend** | backend | Transactional + campaign email (primary; DO blocks SMTP ports) |
| **SMTP / Nodemailer** | backend | Email fallback |
| **DigitalOcean Spaces** (S3 API) | backend | File/document/logo storage (`bayshore.nyc3.digitaloceanspaces.com`) |
| **ImgBB** | backend | Image upload fallback |
| **Google OAuth** | dashboard | Social sign-in |

## Environment Variables

No repo ships a `.env.example`; the backend README documents its variables.

**Backend** (core): `PORT` (8000), `MONGODB_URL`, `JWT_SECRET`, `JWT_EXPIRE`, `FRONTEND_URL`, `BACKEND_URL`, `ADMIN_SIGNUP_SECRET`, `OPENAI_API_KEY`, `RESEND_API_KEY`, `RESEND_FROM`, `SMTP_*` (fallback), `DO_SPACES_BUCKET/REGION/KEY/SECRET`, `DO_FOLDER_NAME`, `IMAGEBB_API_KEY`, `SUPER_USER_*` (for `npm run create-super-user`).

**Dashboard**: `NEXT_PUBLIC_API_URL` or `BACKEND_URL` (backend base, defaults to `https://api.dxg-agency.com`), `NEXT_PUBLIC_FRONTEND_URL`, `NEXTAUTH_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `BACKEND_API_KEY` (server-only, for the public proposal proxy).

**Admin**: `BACKEND_URL` or `NEXT_PUBLIC_API_URL`, `AUTH_SECRET` (or `NEXTAUTH_SECRET`).

## Running Locally

Run all three side by side (backend first):

```bash
# 1. Backend — http://localhost:8000
cd dxg-rfp-tool-backend
npm install
npm run dev                      # nodemon + ts-node
# one-time: npm run create-super-user

# 2. Dashboard — http://localhost:3000
cd dxg-rfp-tool-dashboard
npm install
# .env.local: BACKEND_URL=http://localhost:8000, NEXTAUTH_SECRET=..., GOOGLE_CLIENT_ID/SECRET
npm run dev

# 3. Admin — run on a different port since dashboard uses 3000
cd dxg-rfp-tool-admin
npm install
# .env.local: BACKEND_URL=http://localhost:8000, AUTH_SECRET=...
npm run dev -- -p 3001
```

Backend build/deploy: `npm run build` → `node dist/server.js`, managed by PM2 (`ecosystem.config.js`) behind Nginx on DigitalOcean (`deploy/DIGITALOCEAN.md`). Frontends deploy to Vercel.

## Known Quirks & Caveats

- The backend appears to be a **rebrand of an earlier codebase**: the models directory is named `modal/`, there's an unused Bangladesh SMS gateway (`utils/smsService.ts`) with hardcoded credentials, and a stray "Yunlai Porcelain Art Co." string in `server.ts`.
- `langchain` / `@langchain/*` are declared backend dependencies but unused; the actual LLM call uses the `openai` SDK directly — which is **not** declared in `package.json` (works only transitively).
- Google sign-in is **not verified server-side** — the backend trusts client-supplied Google profile fields.
- WebSocket notifications and cron jobs **do not run on Vercel serverless**; they require the long-lived PM2 deployment.
- Both frontends' `package.json` names are still the scaffold default (`my-app`).
- Assorted leftover stubs/typos: admin `forgot-password` page is a stub, `ClientDetilas.tsx` / `TopHeaser.tsx` misspellings, dashboard wizard directory is literally named `ProposalsProcess.tsx/`.
