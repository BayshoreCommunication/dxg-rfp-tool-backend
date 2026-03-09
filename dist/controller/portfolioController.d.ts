import { Request, Response } from "express";
import { AuthRequest } from "../middleware/auth";
export declare const getPortfolio: (_req: Request, res: Response) => Promise<void>;
export declare const updatePortfolio: (req: AuthRequest, res: Response) => Promise<void>;
export declare const createPortfolio: (req: AuthRequest, res: Response) => Promise<void>;
//# sourceMappingURL=portfolioController.d.ts.map