# DXG RFP Tool Backend

Express + TypeScript + MongoDB API for the DXG RFP platform. This service handles authentication, admin/user profile management, proposal CRUD, AI-assisted proposal extraction, email campaign tracking, settings, and dashboard summaries.

## Tech Stack

- Node.js
- Express
- TypeScript
- MongoDB with Mongoose
- JWT authentication
- Nodemailer for OTP and campaign email delivery
- Multer for uploads
- OpenAI for proposal field extraction
- DigitalOcean Spaces via S3-compatible SDK for asset storage

## What This Backend Does

- Supports email OTP signup and forgot-password flows
- Supports user login, Google login, and admin sign-in/signup
- Stores and manages proposals, proposal metadata, and proposal status
- Uploads proposal support documents and AV quote files
- Extracts proposal data from PDF, DOC, DOCX, TXT, and CSV files with OpenAI
- Sends proposal email campaigns and tracks opens/clicks
- Manages dashboard overview data and app settings
- Exposes admin-only overview and client listing endpoints
- Runs a background expiration check for proposals based on settings

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Create your environment file

Create `backend/.env` and add the variables your environment needs.

Example:

```env
PORT=8000
NODE_ENV=development

MONGODB_URL=mongodb://127.0.0.1:27017/dxg_rfp_tool_db
JWT_SECRET=replace-with-a-strong-secret
JWT_EXPIRE=30d

SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_MAIL=no-reply@example.com
SMTP_PASSWORD=your-smtp-password

OPENAI_API_KEY=your-openai-api-key

DO_SPACES_BUCKET=your-bucket
DO_SPACES_REGION=your-region
DO_SPACES_KEY=your-key
DO_SPACES_SECRET=your-secret
DO_FOLDER_NAME=DXG-RFP-Tool

FRONTEND_URL=http://localhost:3000
BACKEND_URL=http://localhost:8000
ADMIN_SIGNUP_SECRET=your-admin-signup-secret
SUPER_USER_EMAIL=admin@example.com
```

### 3. Start the development server

```bash
npm run dev
```

The API starts on `http://localhost:8000` by default.

## Available Scripts

- `npm run dev` starts the backend with `nodemon`
- `npm run build` compiles TypeScript into `dist/`
- `npm start` runs the compiled server from `dist/server.js`
- `npm run type-check` runs TypeScript without emitting files
- `npm run create-super-user` creates the configured super user
- `npm run test-image-upload` runs the upload test helper

## Health and Base Routes

- `GET /` returns a simple API status response
- `GET /health` returns service and database health
- `GET /api` returns an API welcome response

## Main API Routes

### Auth

Base path: `/api/auth`

- `POST /send-otp`
- `POST /verify-otp`
- `POST /register`
- `POST /login`
- `POST /google`
- `POST /admin/signup`
- `POST /admin/signin`
- `POST /forgot-password/send-otp`
- `POST /forgot-password/verify-otp`
- `POST /forgot-password/reset`
- `GET /me`
- `POST /logout`

### Users

Base path: `/api/users`

- `GET /`
- `GET /me`
- `PUT /me`
- `GET /admin/profile`
- `PUT /admin/profile`
- `GET /:id`
- `PUT /:id`
- `DELETE /:id`

### Signed-in Admin Profile

Base path: `/api/admin-user`

- `GET /me`
- `PUT /me`

### Admin Overview

Base path: `/api/admin`

- `GET /overview`

### Admin Client List

Base path: `/api/all-clients`

- `GET /`

### Proposals

Base path: `/api/proposals`

- `POST /upload-files`
- `POST /`
- `GET /`
- `GET /:id`
- `PUT /:id`
- `PATCH /:id/status`
- `PATCH /:id/meta`
- `PATCH /:id/views`
- `DELETE /:id`

### Emails

Base path: `/api/emails`

Public tracking:

- `GET /open/:trackingId`
- `GET /click/:trackingId`

Protected:

- `POST /send`
- `GET /`
- `GET /stats`
- `DELETE /proposal/:proposalId`
- `DELETE /:campaignId`

### AI Proposal Extraction

Base path: `/api/extract-proposal`

- `POST /`

Upload the file under the form field name `file`.

Supported file types:

- PDF
- DOC
- DOCX
- TXT
- CSV

### Settings

Base path: `/api/settings`

- `GET /`
- `PUT /`
- `DELETE /`

### Dashboard

Base path: `/api/dashboard`

- `GET /overview`

## Authentication

Protected routes expect a Bearer token:

```http
Authorization: Bearer <accessToken>
```

JWT generation and verification live in [config/jwt.ts](d:/Dxg-rfp-tool/backend/config/jwt.ts).

## Uploads

This backend supports:

- Image uploads up to 10 MB
- Proposal/support document uploads up to 50 MB
- Temporary local storage via `multer`
- Optional upload-to-cloud flow using DigitalOcean Spaces

Important upload-related files:

- [middleware/upload.ts](d:/Dxg-rfp-tool/backend/middleware/upload.ts)
- [utils/uploadToSpaces.ts](d:/Dxg-rfp-tool/backend/utils/uploadToSpaces.ts)

## AI Extraction

The extraction endpoint uses OpenAI to parse uploaded files into structured proposal data. PDF uploads use the Responses API, while DOC/DOCX/TXT/CSV content is converted to text first and then parsed.

Implementation:

- [controller/extractController.ts](d:/Dxg-rfp-tool/backend/controller/extractController.ts)

## Email Delivery

This backend uses Nodemailer for:

- Signup OTP emails
- Forgot-password OTP emails
- Campaign email sends
- Open and click tracking

If SMTP settings are not configured, the service can fall back to an Ethereal test account for development.

Implementation:

- [utils/emailService.ts](d:/Dxg-rfp-tool/backend/utils/emailService.ts)
- [routes/emailRoute.ts](d:/Dxg-rfp-tool/backend/routes/emailRoute.ts)

## Background Jobs

On startup, the backend begins a recurring proposal expiration check. The current implementation runs once immediately and then every 12 hours.

Implementation:

- [utils/cronJobs.ts](d:/Dxg-rfp-tool/backend/utils/cronJobs.ts)

## Project Structure

```text
backend/
|-- config/           # Database and JWT configuration
|-- controller/       # Route handlers and business logic
|-- middleware/       # Auth and upload middleware
|-- modal/            # Mongoose models
|-- routes/           # Express route modules
|-- scripts/          # Utility scripts
|-- uploads/          # Local uploads
|-- utils/            # Email, path, cron, and storage helpers
|-- dist/             # Compiled output
|-- server.ts         # Express entry point
|-- package.json
|-- tsconfig.json
|-- vercel.json
```

## Deployment Notes

- The codebase is written to work in both long-running Node environments and serverless-style deployments
- MongoDB connections are cached to reduce reconnection overhead
- Local `/uploads` serving may be limited in serverless environments
- For production file storage, prefer DigitalOcean Spaces or another external object store
- For a DigitalOcean droplet deployment (including hosting as a second project behind Nginx), see [deploy/DIGITALOCEAN.md](deploy/DIGITALOCEAN.md).

## Notes

- The package name and some older strings in the codebase still reference a previous project name; the active backend behavior and routes in this repository are for DXG RFP Tool
- If you update routes or environment variables, keep this README in sync so the frontend teams can integrate confidently
