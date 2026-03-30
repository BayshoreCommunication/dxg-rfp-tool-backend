import path from "path";
import { Response } from "express";
import { AuthRequest } from "../middleware/auth";
import Settings from "../modal/settingsModel";
import { uploadToSpaces } from "../utils/uploadToSpaces";

const buildSpacesKey = (userId: string, originalName: string) => {
  const folder = process.env.DO_FOLDER_NAME
    ? process.env.DO_FOLDER_NAME.replace(/^\/+|\/+$/g, "")
    : "";

  const ext = path.extname(originalName).toLowerCase() || ".png";
  const filename = `logo-${Date.now()}${ext}`;
  const basePath = `settings/${userId}`;

  return folder ? `${folder}/${basePath}/${filename}` : `${basePath}/${filename}`;
};

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

    let settings = await Settings.findOne({ userId });
    if (!settings) {
      settings = await Settings.create({ userId });
    }

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

    const updates = { ...body };
    delete updates._id;
    delete updates.userId;
    delete updates.createdAt;
    delete updates.updatedAt;

    if (req.file) {
      const objectKey = buildSpacesKey(userId, req.file.originalname);
      const logoUrl = await uploadToSpaces(req.file.path, objectKey);
      updates.branding = {
        ...(updates.branding || {}),
        logoFile: logoUrl,
      };
    }

    const settings = await Settings.findOneAndUpdate(
      { userId },
      { $set: updates, $setOnInsert: { userId } },
      { new: true, runValidators: true, upsert: true, setDefaultsOnInsert: true }
    );

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

    const result = await Settings.findOneAndDelete({ userId });

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
