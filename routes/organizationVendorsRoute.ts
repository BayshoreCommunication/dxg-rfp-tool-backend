import { Router } from "express";
import { authenticate, authorizeAction } from "../middleware/auth";
import { organizationVendorsController as controller } from "../controller/organizationVendorsController";

// ORG-606: the organization's shared vendor list. Every route needs a signed-in member; none
// accepts a public access grant, so a vendor's submission link never reaches the list.
const router = Router();
const read = [authenticate, authorizeAction("vendor-list:read")];
const write = [authenticate, authorizeAction("vendor-list:write")];

router.get("/vendor-list", ...read, controller.list);
router.get("/vendor-list/categories", ...read, controller.categories);
router.post("/vendor-list", ...write, controller.create);
router.get("/vendor-list/:vendorId", ...read, controller.get);
router.patch("/vendor-list/:vendorId", ...write, controller.update);
router.post("/vendor-list/:vendorId/archive", ...write, controller.archive);
router.post("/vendor-list/:vendorId/restore", ...write, controller.restore);

export default router;
