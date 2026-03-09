import jwt from "jsonwebtoken";
export declare const TOKEN_EXPIRY_MS: number;
export interface TokenPayload {
    userId: string;
    email: string;
    role: string;
}
export interface TokenResponse {
    accessToken: string;
    expiresAt: number;
    expiresIn: number;
}
export declare const generateAccessToken: (payload: TokenPayload) => TokenResponse;
export declare const verifyAccessToken: (token: string) => TokenPayload;
export declare const decodeToken: (token: string) => jwt.JwtPayload | null;
//# sourceMappingURL=jwt.d.ts.map