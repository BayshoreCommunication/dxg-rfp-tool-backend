import { Request, Response } from "express";
import { AuthRequest } from "../middleware/auth";
export declare const createAdmission: (req: AuthRequest, res: Response) => Promise<void>;
export declare const getAdmissions: (req: Request, res: Response) => Promise<void>;
export declare const getAdmissionById: (req: Request, res: Response) => Promise<void>;
export declare const updateAdmission: (req: AuthRequest, res: Response) => Promise<void>;
export declare const deleteAdmission: (req: AuthRequest, res: Response) => Promise<void>;
export declare const getAdmissionStats: (_req: Request, res: Response) => Promise<void>;
//# sourceMappingURL=admissionController.d.ts.map