import { Request, Response } from "express";
import { AuthRequest } from "../middleware/auth";
export declare const signUp: (req: Request, res: Response) => Promise<void>;
export declare const signInWithCredentials: (req: Request, res: Response) => Promise<void>;
export declare const signInWithSocial: (req: Request, res: Response) => Promise<void>;
export declare const getCurrentUser: (req: AuthRequest, res: Response) => Promise<void>;
export declare const signOut: (_req: AuthRequest, res: Response) => Promise<void>;
//# sourceMappingURL=authController.d.ts.map