import { Request, Response } from "express";
import { AuthRequest } from "../middleware/auth";
export declare const markAttendance: (req: AuthRequest, res: Response) => Promise<void>;
export declare const markBatchAttendance: (req: AuthRequest, res: Response) => Promise<void>;
export declare const getAttendances: (req: Request, res: Response) => Promise<void>;
export declare const getAttendanceStats: (req: Request, res: Response) => Promise<void>;
export declare const getStudentAttendanceReport: (req: Request, res: Response) => Promise<void>;
export declare const sendAttendanceReportSMS: (req: AuthRequest, res: Response) => Promise<void>;
export declare const deleteAttendance: (req: Request, res: Response) => Promise<void>;
//# sourceMappingURL=attendanceController.d.ts.map