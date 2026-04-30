import { Router } from "express";
import {
  blockClient,
  getAdminClientsList,
} from "../controller/allClientsController";
import { authenticate, authorize } from "../middleware/auth";

const router = Router();

const adminGuard = [authenticate, authorize("admin", "super_admin", "superadmin")];

router.get("/", ...adminGuard, getAdminClientsList);

router.patch("/:id/block", ...adminGuard, blockClient);

export default router;
