import { Request, Response } from "express";
import { AuthRequest } from "../middleware/auth";
export declare const sendSingleSMS: (req: AuthRequest, res: Response) => Promise<void>;
export declare const sendBulkSMSSameMessage: (req: AuthRequest, res: Response) => Promise<void>;
export declare const sendBulkSMSDifferentMessages: (req: AuthRequest, res: Response) => Promise<void>;
export declare const getSMSHistory: (req: Request, res: Response) => Promise<void>;
export declare const getSMSById: (req: Request, res: Response) => Promise<void>;
export declare const sendSMSToStudents: (req: AuthRequest, res: Response) => Promise<void>;
export declare const getSMSStats: (req: Request, res: Response) => Promise<void>;
//# sourceMappingURL=smsController.d.ts.map