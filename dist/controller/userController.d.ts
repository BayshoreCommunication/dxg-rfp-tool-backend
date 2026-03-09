import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
export declare const getSubUsers: (req: AuthRequest, res: Response) => Promise<void>;
export declare const createSubUser: (req: AuthRequest, res: Response) => Promise<void>;
export declare const updateSubUser: (req: AuthRequest, res: Response) => Promise<void>;
export declare const deleteSubUser: (req: AuthRequest, res: Response) => Promise<void>;
export declare const updateUserPermissions: (req: AuthRequest, res: Response) => Promise<void>;
//# sourceMappingURL=userController.d.ts.map