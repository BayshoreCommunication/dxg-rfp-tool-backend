import { Request, Response } from "express";
import { AuthRequest } from "../middleware/auth";
export declare const createExam: (req: AuthRequest, res: Response) => Promise<void>;
export declare const getExams: (req: Request, res: Response) => Promise<void>;
export declare const getExamById: (req: Request, res: Response) => Promise<void>;
export declare const updateExam: (req: AuthRequest, res: Response) => Promise<void>;
export declare const deleteExam: (req: Request, res: Response) => Promise<void>;
export declare const sendExamScheduleSMS: (req: AuthRequest, res: Response) => Promise<void>;
export declare const createExamResult: (req: AuthRequest, res: Response) => Promise<void>;
export declare const createBatchExamResults: (req: AuthRequest, res: Response) => Promise<void>;
export declare const getExamResults: (req: Request, res: Response) => Promise<void>;
export declare const sendExamResultSMS: (req: AuthRequest, res: Response) => Promise<void>;
export declare const getExamStats: (req: Request, res: Response) => Promise<void>;
//# sourceMappingURL=examController.d.ts.map