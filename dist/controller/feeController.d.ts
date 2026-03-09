import { Request, Response } from "express";
import { AuthRequest } from "../middleware/auth";
export declare const createFee: (req: AuthRequest, res: Response) => Promise<void>;
export declare const getFees: (req: Request, res: Response) => Promise<void>;
export declare const getFeeById: (req: Request, res: Response) => Promise<void>;
export declare const updateFee: (req: AuthRequest, res: Response) => Promise<void>;
export declare const deleteFee: (req: Request, res: Response) => Promise<void>;
export declare const sendPaymentReminderSMS: (req: AuthRequest, res: Response) => Promise<void>;
export declare const sendOverdueSMS: (req: AuthRequest, res: Response) => Promise<void>;
export declare const sendPaymentConfirmationSMS: (req: AuthRequest, res: Response) => Promise<void>;
export declare const getFeeStats: (req: Request, res: Response) => Promise<void>;
export declare const createBulkFees: (req: AuthRequest, res: Response) => Promise<void>;
//# sourceMappingURL=feeController.d.ts.map