import jwt, { SignOptions } from "jsonwebtoken";

const DEFAULT_JWT_SECRET = "your-secret-key-change-in-production";

const JWT_SECRET =
  process.env.JWT_SECRET || process.env.SECRET_KEY || DEFAULT_JWT_SECRET;

const JWT_EXPIRE =
  process.env.JWT_EXPIRE ||
  (process.env.ACCESS_TOKEN_EXPIRE_MINUTES
    ? `${process.env.ACCESS_TOKEN_EXPIRE_MINUTES}m`
    : "30d"); // 30 days

if (process.env.NODE_ENV === "production" && JWT_SECRET === DEFAULT_JWT_SECRET) {
  throw new Error("JWT_SECRET must be set in production");
}

// 30 days in milliseconds
export const TOKEN_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

export interface TokenPayload {
  userId: string;
  email: string;
  role: string;
}

export interface TokenResponse {
  accessToken: string;
  expiresAt: number; // Unix timestamp when token expires
  expiresIn: number; // Seconds until expiration
}

// Generate access token (30 days validity)
export const generateAccessToken = (payload: TokenPayload): TokenResponse => {
  const accessToken = jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRE,
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
    return jwt.verify(token, JWT_SECRET) as TokenPayload;
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
