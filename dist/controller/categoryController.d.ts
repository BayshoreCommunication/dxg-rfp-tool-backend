import { Request, Response } from "express";
export declare const getCategories: (req: Request, res: Response) => Promise<void>;
export declare const getCategory: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const createCategory: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateCategory: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const deleteCategory: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getCategoryTree: (_req: Request, res: Response) => Promise<void>;
//# sourceMappingURL=categoryController.d.ts.map