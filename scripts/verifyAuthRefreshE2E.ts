import "../config/env";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import mongoose from "mongoose";
import Organization from "../modal/organizationModel";
import OrganizationMembership from "../modal/organizationMembershipModel";
import Otp from "../modal/otpModel";
import Proposal from "../modal/proposalsModel";
import RefreshSession from "../modal/refreshSessionModel";
import User from "../modal/userModel";

const databaseName = process.env.MONGODB_DB_NAME ?? "";
const mongoUrl = process.env.MONGODB_URL ?? process.env.MONGO_URL ?? "";
const baseUrl = (
  process.env.AUTH_E2E_BASE_URL ?? "http://127.0.0.1:8100"
).replace(/\/+$/, "");
const bffSharedSecret = process.env.BFF_SHARED_SECRET?.trim() ?? "";

if (
  process.env.NODE_ENV !== "test" ||
  !databaseName.startsWith("rfpilot_auth_e2e") ||
  !mongoUrl ||
  !bffSharedSecret
) {
  throw new Error(
    "Auth refresh E2E requires NODE_ENV=test, an rfpilot_auth_e2e* Mongo database, and BFF_SHARED_SECRET",
  );
}

const jsonRequest = async (
  path: string,
  body: Record<string, unknown>,
  options: { accessToken?: string; bff?: boolean } = {},
) => {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options.accessToken) {
    headers.set("Authorization", `Bearer ${options.accessToken}`);
  }
  if (options.bff) {
    headers.set("x-rfpilot-bff-key", bffSharedSecret);
  }
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  return { response, payload };
};

const requireString = (
  value: unknown,
  name: string,
): string => {
  assert.equal(typeof value, "string", `${name} must be a string`);
  return value as string;
};

const run = async () => {
  await mongoose.connect(mongoUrl, { dbName: databaseName });

  try {
    const marker = crypto.randomUUID();
    const email = `auth-e2e-${marker}@example.test`;
    const password = `Auth-e2e-${marker}`;
    const organization = await Organization.create({
      name: `Auth E2E ${marker}`,
      slug: "dxg",
      status: "active",
    });
    const user = await User.create({
      organizationId: organization._id,
      name: "Auth E2E User",
      email,
      password,
      role: "customer",
      isBlocked: false,
    });
    await OrganizationMembership.create({
      organizationId: organization._id,
      userId: user._id,
      roles: ["planner"],
      status: "active",
      version: 1,
      activatedAt: new Date(),
    });

    const loginStartedAt = Date.now();
    const login = await jsonRequest(
      "/api/auth/login",
      { email, password },
      { bff: true },
    );
    assert.equal(login.response.status, 200);
    const firstAccessToken = requireString(
      login.payload.accessToken,
      "login access token",
    );
    const firstRefreshToken = requireString(
      login.payload.refreshToken,
      "login refresh token",
    );
    const sessionId = requireString(login.payload.sessionId, "session id");
    assert.equal(
      await RefreshSession.countDocuments({
        userId: user._id,
        sessionId,
        status: "active",
      }),
      1,
    );

    const configuredLifetimeMs =
      Number(process.env.ACCESS_TOKEN_EXPIRE_MINUTES ?? "15") * 60_000;
    assert.ok(
      Math.abs(
        Number(login.payload.tokenExpiresAt) -
          loginStartedAt -
          configuredLifetimeMs,
      ) < 5_000,
      "login must use the configured access-token lifetime",
    );

    const meResponse = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${firstAccessToken}` },
    });
    assert.equal(meResponse.status, 200);

    const proposalPayload = {
      status: "submitted",
      isDraft: false,
      event: {
        eventName: `Expired-token proposal ${marker}`,
        eventFormat: "Virtual",
        eventObjectives:
          "Verify that filled proposal input survives access-token expiry.",
      },
      contact: {
        contactFirstName: "Refresh",
        contactLastName: "Tester",
        contactEmail: email,
        contactPhone: "+15555550123",
      },
    };
    const expiredSubmitAt = Number(login.payload.tokenExpiresAt) + 1_500;
    const waitMs = expiredSubmitAt - Date.now();
    if (waitMs > 0) {
      console.log(
        JSON.stringify({
          waitingForAccessTokenExpiryMs: waitMs,
          accessTokenExpireMinutes: Number(
            process.env.ACCESS_TOKEN_EXPIRE_MINUTES,
          ),
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }

    const expiredSubmit = await jsonRequest(
      "/api/proposals",
      proposalPayload,
      { accessToken: firstAccessToken },
    );
    assert.equal(
      expiredSubmit.response.status,
      401,
      "the filled proposal must first encounter an expired-token 401",
    );
    assert.equal(
      await Proposal.countDocuments({ userId: user._id }),
      0,
      "the rejected request must not partially create a proposal",
    );

    const refresh = await jsonRequest(
      "/api/auth/refresh",
      { refreshToken: firstRefreshToken },
      { bff: true },
    );
    assert.equal(refresh.response.status, 200);
    const secondAccessToken = requireString(
      refresh.payload.accessToken,
      "refreshed access token",
    );
    const secondRefreshToken = requireString(
      refresh.payload.refreshToken,
      "rotated refresh token",
    );
    assert.notEqual(secondRefreshToken, firstRefreshToken);

    const retriedSubmit = await jsonRequest(
      "/api/proposals",
      proposalPayload,
      { accessToken: secondAccessToken },
    );
    assert.equal(
      retriedSubmit.response.status,
      201,
      "the same filled proposal must succeed after refresh",
    );
    assert.equal(
      await Proposal.countDocuments({ userId: user._id }),
      1,
      "the refresh retry must create the proposal exactly once",
    );
    assert.equal(
      (
        await Proposal.findOne({ userId: user._id })
          .select("event.eventName")
          .lean()
      )?.event.eventName,
      proposalPayload.event.eventName,
      "the retried submit must preserve the filled proposal input",
    );

    const logout = await jsonRequest(
      "/api/auth/logout-session",
      { refreshToken: secondRefreshToken },
      { bff: true },
    );
    assert.equal(logout.response.status, 200);
    assert.equal(
      await RefreshSession.countDocuments({
        userId: user._id,
        sessionId,
        status: "active",
      }),
      0,
    );

    const afterLogout = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${secondAccessToken}` },
    });
    assert.ok([401, 403].includes(afterLogout.status));

    const rejectedRefresh = await jsonRequest(
      "/api/auth/refresh",
      { refreshToken: secondRefreshToken },
      { bff: true },
    );
    assert.equal(rejectedRefresh.response.status, 401);

    const signupEmail = `signup-e2e-${marker}@example.test`;
    await Otp.create({
      email: signupEmail,
      codeHash: "e2e-verified-placeholder",
      type: "signup",
      expiresAt: new Date(Date.now() + 60_000),
      verified: true,
      attempts: 0,
      maxAttempts: 5,
    });
    const signup = await jsonRequest(
      "/api/auth/register",
      {
        name: "Signup E2E User",
        email: signupEmail,
        password,
        createSession: false,
      },
      { bff: true },
    );
    assert.equal(signup.response.status, 201);
    assert.equal(signup.payload.accessToken, undefined);
    assert.equal(signup.payload.refreshToken, undefined);
    assert.equal(signup.payload.sessionId, undefined);
    const signupUser = await User.findOne({ email: signupEmail }).lean();
    assert.ok(signupUser);
    assert.equal(
      await RefreshSession.countDocuments({ userId: signupUser._id }),
      0,
    );

    console.log(
      JSON.stringify({
        success: true,
        login: "issued_one_session",
        expiredProposalSubmit: "rejected_without_partial_write",
        refresh: "rotated",
        proposalRetry: "created_exactly_once_with_preserved_input",
        logout: "revoked_without_access_token",
        signup: "created_without_orphan_session",
        accessTokenExpireMinutes: Number(
          process.env.ACCESS_TOKEN_EXPIRE_MINUTES,
        ),
      }),
    );
  } finally {
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
};

void run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
