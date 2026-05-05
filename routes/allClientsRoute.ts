import { Router } from "express";
import {
  blockClient,
  deleteClient,
  getAdminClientsList,
} from "../controller/allClientsController";
import { authenticate, authorize } from "../middleware/auth";

const router = Router();

const adminGuard = [authenticate, authorize("admin", "super_admin", "superadmin")];
const superAdminGuard = [authenticate, authorize("super_admin", "superadmin")];

router.get("/", ...adminGuard, getAdminClientsList);

router.patch("/:id/block", ...superAdminGuard, blockClient);

router.delete("/:id", ...superAdminGuard, deleteClient);

export default router;
