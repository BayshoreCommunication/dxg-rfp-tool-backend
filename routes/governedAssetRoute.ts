import { Router } from "express";
import {
  activateGovernedAssetReplacement,
  listGovernedAssetEvents,
  listGovernedAssets,
  updateGovernedAsset,
} from "../controller/governedAssetController";
import { authenticate, authorizeAction } from "../middleware/auth";

const router = Router();

router.get(
  "/governance/assets",
  authenticate,
  authorizeAction("security:admin"),
  listGovernedAssets,
);
router.get(
  "/governance/assets/:governedAssetId/events",
  authenticate,
  authorizeAction("security:admin"),
  listGovernedAssetEvents,
);
router.patch(
  "/governance/assets/:governedAssetId",
  authenticate,
  authorizeAction("security:admin"),
  updateGovernedAsset,
);
router.post(
  "/governance/assets/:governedAssetId/activate-replacement",
  authenticate,
  authorizeAction("security:admin"),
  activateGovernedAssetReplacement,
);

export default router;
