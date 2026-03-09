import { Request, Response } from "express";
export declare const getCustomers: (req: Request, res: Response) => Promise<void>;
export declare const getCustomer: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const createCustomer: (req: Request, res: Response) => Promise<void>;
export declare const updateCustomer: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const deleteCustomer: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const getCustomerStats: (_req: Request, res: Response) => Promise<void>;
export declare const getCustomerOrders: (req: Request, res: Response) => Promise<void>;
export declare const addCustomerAddress: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const updateCustomerAddress: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
export declare const deleteCustomerAddress: (req: Request, res: Response) => Promise<Response<any, Record<string, any>>>;
//# sourceMappingURL=customerController.d.ts.map