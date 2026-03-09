import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
export declare const getProducts: (req: AuthRequest, res: Response) => Promise<void>;
export declare const getProduct: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const createProduct: (req: AuthRequest, res: Response) => Promise<void>;
export declare const updateProduct: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const deleteProduct: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const bulkUpdateProducts: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getLowStockProducts: (_req: AuthRequest, res: Response) => Promise<void>;
export declare const updateProductStock: (req: AuthRequest, res: Response) => Promise<Response<any, Record<string, any>>>;
//# sourceMappingURL=productController.d.ts.map