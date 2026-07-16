import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import {
  deleteOwnedSettings,
  getOwnedSettings,
  updateOwnedSettings,
} from "../src/modules/settings/composition";

export const getSettings = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    const settings = await getOwnedSettings(userId);

    res.status(200).json({
      success: true,
      data: settings,
    });
  } catch (error) {
    console.error("Get settings error:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching settings",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const updateSettings = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    const body =
      typeof req.body.settings === "string"
        ? JSON.parse(req.body.settings)
        : req.body;

    const settings = await updateOwnedSettings({
      userId,
      settings: body as Record<string, unknown>,
      logo: req.file
        ? { originalname: req.file.originalname, path: req.file.path }
        : undefined,
    });

    res.status(200).json({
      success: true,
      message: "Settings updated successfully",
      data: settings,
    });
  } catch (error: any) {
    console.error("Update settings error:", error);
    res.status(500).json({
      success: false,
      message: "Error updating settings",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};

export const deleteSettings = async (
  req: AuthRequest,
  res: Response
): Promise<void> => {
  try {
    const userId = req.user?.userId;
    if (!userId) {
      res.status(401).json({ success: false, message: "Unauthorized" });
      return;
    }

    const result = await deleteOwnedSettings(userId);

    if (!result) {
      res.status(404).json({
        success: false,
        message: "Settings not found",
      });
      return;
    }

    res.status(200).json({
      success: true,
      message: "Settings deleted successfully",
    });
  } catch (error) {
    console.error("Delete settings error:", error);
    res.status(500).json({
      success: false,
      message: "Error deleting settings",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
};
