"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPortfolio = exports.updatePortfolio = exports.getPortfolio = void 0;
const portfolio_1 = __importDefault(require("../modal/portfolio"));
const imageProcessor_1 = require("../utils/imageProcessor");
const paths_1 = require("../utils/paths");
// Helper function to process uploaded image
async function processUploadedImage(file, folder = "portfolio") {
    try {
        const uploadsDir = (0, paths_1.getUploadPath)(folder);
        const filename = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
        // Convert to WebP
        const webpPath = await (0, imageProcessor_1.convertToWebP)(file.path, uploadsDir, filename, {
            width: 800,
            height: 800,
            quality: 85,
        });
        // Return relative URL path
        return (0, paths_1.getUploadUrl)(webpPath);
    }
    catch (error) {
        console.error("Error processing uploaded image:", error);
        throw error;
    }
}
// Get portfolio settings
const getPortfolio = async (_req, res) => {
    try {
        let portfolio = await portfolio_1.default.findOne();
        // If no portfolio exists, create a default one
        if (!portfolio) {
            portfolio = await portfolio_1.default.create({
                appTitle: "Coaching Center",
                appLogo: "",
                createdBy: new (require("mongoose").Types.ObjectId)(),
            });
        }
        res.status(200).json({
            success: true,
            data: portfolio,
        });
    }
    catch (error) {
        console.error("Get portfolio error:", error);
        res.status(500).json({
            success: false,
            message: "Error fetching portfolio settings",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.getPortfolio = getPortfolio;
// Update portfolio settings
const updatePortfolio = async (req, res) => {
    try {
        const updateData = { ...req.body };
        // Process uploaded images if present
        const files = req.files;
        if (files) {
            if (files.appLogo && files.appLogo[0]) {
                updateData.appLogo = await processUploadedImage(files.appLogo[0], "portfolio/logos");
            }
            if (files.favicon && files.favicon[0]) {
                updateData.favicon = await processUploadedImage(files.favicon[0], "portfolio/favicons");
            }
        }
        // Find existing portfolio or create new one
        let portfolio = await portfolio_1.default.findOne();
        if (!portfolio) {
            portfolio = await portfolio_1.default.create({
                ...updateData,
                createdBy: req.user?.userId,
            });
        }
        else {
            // Delete old images if new ones are uploaded
            if (updateData.appLogo && portfolio.appLogo) {
                const oldLogoPath = (0, paths_1.getUploadFilePath)(portfolio.appLogo);
                try {
                    await (0, imageProcessor_1.deleteImage)(oldLogoPath);
                }
                catch (error) {
                    console.error("Error deleting old logo:", error);
                }
            }
            if (updateData.favicon && portfolio.favicon) {
                const oldFaviconPath = (0, paths_1.getUploadFilePath)(portfolio.favicon);
                try {
                    await (0, imageProcessor_1.deleteImage)(oldFaviconPath);
                }
                catch (error) {
                    console.error("Error deleting old favicon:", error);
                }
            }
            // Update existing portfolio
            Object.assign(portfolio, {
                ...updateData,
                updatedBy: req.user?.userId,
            });
            await portfolio.save();
        }
        res.status(200).json({
            success: true,
            message: "Portfolio settings updated successfully",
            data: portfolio,
        });
    }
    catch (error) {
        console.error("Update portfolio error:", error);
        res.status(500).json({
            success: false,
            message: "Error updating portfolio settings",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.updatePortfolio = updatePortfolio;
// Create portfolio settings (if needed)
const createPortfolio = async (req, res) => {
    try {
        // Check if portfolio already exists
        const existingPortfolio = await portfolio_1.default.findOne();
        if (existingPortfolio) {
            res.status(400).json({
                success: false,
                message: "Portfolio settings already exist. Use update endpoint instead.",
            });
            return;
        }
        const portfolioData = { ...req.body };
        // Process uploaded images if present
        const files = req.files;
        if (files) {
            if (files.appLogo && files.appLogo[0]) {
                portfolioData.appLogo = await processUploadedImage(files.appLogo[0], "portfolio/logos");
            }
            if (files.favicon && files.favicon[0]) {
                portfolioData.favicon = await processUploadedImage(files.favicon[0], "portfolio/favicons");
            }
        }
        // Set defaults
        const portfolio = await portfolio_1.default.create({
            appTitle: portfolioData.appTitle || "Coaching Center",
            appLogo: portfolioData.appLogo || "",
            appDescription: portfolioData.appDescription,
            appTagline: portfolioData.appTagline,
            favicon: portfolioData.favicon,
            primaryColor: portfolioData.primaryColor || "#3B82F6",
            secondaryColor: portfolioData.secondaryColor || "#8B5CF6",
            accentColor: portfolioData.accentColor || "#10B981",
            email: portfolioData.email,
            phone: portfolioData.phone,
            address: portfolioData.address,
            website: portfolioData.website,
            socialMedia: portfolioData.socialMedia || {},
            metaKeywords: portfolioData.metaKeywords,
            metaDescription: portfolioData.metaDescription,
            copyrightText: portfolioData.copyrightText ||
                "© 2024 Coaching Center. All rights reserved.",
            createdBy: req.user?.userId,
        });
        res.status(201).json({
            success: true,
            message: "Portfolio settings created successfully",
            data: portfolio,
        });
    }
    catch (error) {
        console.error("Create portfolio error:", error);
        res.status(500).json({
            success: false,
            message: "Error creating portfolio settings",
            error: error instanceof Error ? error.message : "Unknown error",
        });
    }
};
exports.createPortfolio = createPortfolio;
//# sourceMappingURL=portfolioController.js.map