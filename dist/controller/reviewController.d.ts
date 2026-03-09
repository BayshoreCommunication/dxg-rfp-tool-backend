import { Request, Response } from "express";
import { AuthRequest } from "../middleware/auth";
export declare const getReviews: (req: Request, res: Response) => Promise<void>;
export declare const createReview: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateReviewStatus: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const deleteReview: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const replyToReview: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
//# sourceMappingURL=reviewController.d.ts.map