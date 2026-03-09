import { NextFunction, Request, Response } from "express";
import { TokenPayload } from "../config/jwt";
export interface AuthRequest extends Request {
    user?: TokenPayload;
}
export declare const authenticate: (req: AuthRequest, res: Response, next: NextFunction) => void;
export declare const authorize: (...roles: string[]) => (req: AuthRequest, res: Response, next: NextFunction) => void;
//# sourceMappingURL=auth.d.ts.map