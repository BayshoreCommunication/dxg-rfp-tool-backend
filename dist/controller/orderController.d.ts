import { Request, Response } from "express";
import { AuthRequest } from "../middleware/auth";
export declare const getOrders: (req: Request, res: Response) => Promise<void>;
export declare const getMyOrders: (req: AuthRequest, res: Response) => Promise<void>;
export declare const getOrder: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const createOrder: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateOrder: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const deleteOrder: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateOrderStatus: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updatePaymentStatus: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const refundOrder: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getOrderStats: (req: Request, res: Response) => Promise<void>;
export declare const getRecentOrders: (req: Request, res: Response) => Promise<void>;
//# sourceMappingURL=orderController.d.ts.map