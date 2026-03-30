import { Router } from "express";
import { getDashboardOverview } from "../controller/dashboardController";
import { authenticate } from "../middleware/auth";

const router = Router();

router.get("/overview", authenticate, getDashboardOverview);

export default router;
