import { Request, Response } from "express";
import { AuthRequest } from "../middleware/auth";
export declare const createQRCode: (req: AuthRequest, res: Response) => Promise<void>;
export declare const getQRCodes: (req: Request, res: Response) => Promise<void>;
export declare const getQRCodeById: (req: Request, res: Response) => Promise<void>;
export declare const updateQRCode: (req: AuthRequest, res: Response) => Promise<void>;
export declare const deleteQRCode: (req: AuthRequest, res: Response) => Promise<void>;
export declare const bulkGenerateQRCodes: (req: AuthRequest, res: Response) => Promise<void>;
export declare const verifyQRCode: (req: Request, res: Response) => Promise<void>;
//# sourceMappingURL=qrcodeController.d.ts.map