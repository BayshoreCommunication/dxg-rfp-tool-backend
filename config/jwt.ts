import jwt, { SignOptions } from "jsonwebtoken";
import crypto from "node:crypto";

const DEFAULT_JWT_SECRET = "your-secret-key-change-in-production";

const JWT_SECRET =
  process.env.JWT_SECRET || process.env.SECRET_KEY || DEFAULT_JWT_SECRET;

const ACCESS_TOKEN_EXPIRE_MINUTES = Math.max(
  1,
  Number.parseInt(process.env.ACCESS_TOKEN_EXPIRE_MINUTES || "15", 10) || 15,
);
const JWT_EXPIRE = `${ACCESS_TOKEN_EXPIRE_MINUTES}m`;
const JWT_ISSUER = process.env.JWT_ISSUER || "rfpilot-api";
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || "rfpilot-web";

if (process.env.NODE_ENV === "production" && JWT_SECRET === DEFAULT_JWT_SECRET) {
  throw new Error("JWT_SECRET must be set in production");
}

export const TOKEN_EXPIRY_MS = ACCESS_TOKEN_EXPIRE_MINUTES * 60 * 1000;

export interface TokenPayload {
  userId: string;
  email: string;
  role: string;
  organizationId?: string;
  sessionId?: string;
  roles?: string[];
  rolesVersion?: number;
}

export interface TokenResponse {
  accessToken: string;
  expiresAt: number; // Unix timestamp when token expires
  expiresIn: number; // Seconds until expiration
}

// Generate access token (30 days validity)
export const generateAccessToken = (payload: TokenPayload): TokenResponse => {
  const accessToken = jwt.sign({
    email: payload.email,
    role: payload.role,
    organizationId: payload.organizationId,
    sessionId: payload.sessionId,
    roles: payload.roles,
    rolesVersion: payload.rolesVersion,
  }, JWT_SECRET, {
    expiresIn: JWT_EXPIRE,
    algorithm: "HS256",
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    subject: payload.userId,
    jwtid: crypto.randomUUID(),
  } as SignOptions);

  const expiresAt = Date.now() + TOKEN_EXPIRY_MS;
  const expiresIn = Math.floor(TOKEN_EXPIRY_MS / 1000); // Convert to seconds

  return {
    accessToken,
    expiresAt,
    expiresIn,
  };
};

// Verify access token
export const verifyAccessToken = (token: string): TokenPayload => {
  try {
    const decoded = jwt.verify(token, JWT_SECRET, {
      algorithms: ["HS256"],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }) as jwt.JwtPayload;
    if (!decoded.sub || typeof decoded.email !== "string" || typeof decoded.role !== "string") {
      throw new Error("Required access-token claims are missing");
    }
    return {
      userId: decoded.sub,
      email: decoded.email,
      role: decoded.role,
      organizationId: typeof decoded.organizationId === "string" ? decoded.organizationId : undefined,
      sessionId: typeof decoded.sessionId === "string" ? decoded.sessionId : undefined,
      roles: Array.isArray(decoded.roles) ? decoded.roles.filter((role): role is string => typeof role === "string") : undefined,
      rolesVersion: typeof decoded.rolesVersion === "number" ? decoded.rolesVersion : undefined,
    };
  } catch (error) {
    throw new Error("Invalid or expired token");
  }
};

// Decode token without verification (to check expiry)
export const decodeToken = (token: string): jwt.JwtPayload | null => {
  try {
    return jwt.decode(token) as jwt.JwtPayload;
  } catch {
    return null;
  }
};
