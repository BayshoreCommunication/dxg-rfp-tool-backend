"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const express_1 = __importDefault(require("express"));
const mongoose_1 = __importDefault(require("mongoose"));
const morgan_1 = __importDefault(require("morgan"));
const db_1 = __importDefault(require("./config/db"));
const auth_1 = __importDefault(require("./routes/auth"));
const blog_1 = __importDefault(require("./routes/blog"));
const category_1 = __importDefault(require("./routes/category"));
const dashboard_1 = __importDefault(require("./routes/dashboard"));
const product_1 = __importDefault(require("./routes/product"));
const users_1 = __importDefault(require("./routes/users"));
const paths_1 = require("./utils/paths");
// Load environment variables
dotenv_1.default.config();
const app = (0, express_1.default)();
const PORT = process.env.PORT || 5000;
// Middleware
app.use((0, cors_1.default)());
app.use(express_1.default.json());
app.use(express_1.default.urlencoded({ extended: true }));
app.use((0, morgan_1.default)("dev"));
// Database connection middleware for serverless environments
app.use(async (_req, _res, next) => {
    try {
        // Ensure database is connected before handling requests
        // This is important for serverless/Vercel where connections may be dropped
        if (mongoose_1.default.connection.readyState !== 1) {
            await (0, db_1.default)();
        }
        next();
    }
    catch (error) {
        console.error("Database connection middleware error:", error);
        next(error);
    }
});
// Serve static files from uploads directory
// Note: In serverless environments, static file serving may not work
// Consider using cloud storage (S3, Cloudinary, etc.) for production
try {
    const uploadsDir = (0, paths_1.getUploadsDir)();
    app.use("/uploads", express_1.default.static(uploadsDir));
}
catch (error) {
    console.warn("Warning: Could not set up static file serving for uploads:", error);
}
// Root route
app.get("/", (_req, res) => {
    res.json({
        success: true,
        message: "Yunlai Porcelain Art Co. API is running!",
        version: "1.0.0",
        timestamp: new Date().toISOString(),
    });
});
// Health check with database status
app.get("/health", (_req, res) => {
    const dbStatus = mongoose_1.default.connection.readyState === 1 ? "connected" : "disconnected";
    const isHealthy = mongoose_1.default.connection.readyState === 1;
    res.status(isHealthy ? 200 : 503).json({
        status: isHealthy ? "OK" : "ERROR",
        timestamp: new Date().toISOString(),
        database: dbStatus,
        environment: process.env.NODE_ENV || "development",
    });
});
// API welcome route
app.get("/api", (_req, res) => {
    res.json({
        success: true,
        message: "Welcome to Yunlai Porcelain Art Co. API",
        timestamp: new Date().toISOString(),
    });
});
// Auth routes
app.use("/api/auth", auth_1.default);
// User management routes
app.use("/api/users", users_1.default);
// E-commerce routes
app.use("/api/products", product_1.default);
app.use("/api/categories", category_1.default);
app.use("/api/blogs", blog_1.default);
app.use("/api/dashboard", dashboard_1.default);
// 404 Handler
app.use((_req, res) => {
    res.status(404).json({
        success: false,
        message: "Route not found",
    });
});
// Global Error Handler
app.use((err, _req, res, _next) => {
    console.error("Global Error Handler:", err);
    res.status(err.status || 500).json({
        success: false,
        message: err.message || "Internal Server Error",
        error: process.env.NODE_ENV === "development" ? err : undefined,
    });
});
// Start server only if this file is run directly
if (require.main === module) {
    const startServer = async () => {
        try {
            // Connect to database first
            await (0, db_1.default)();
            // Start listening after database connection
            app.listen(PORT, () => {
                console.log("========================================");
                console.log("🚀 Server Started Successfully!");
                console.log("========================================");
                console.log(`🌐 Environment: ${process.env.NODE_ENV || "development"}`);
                console.log(`🔗 Server URL: http://localhost:${PORT}`);
                console.log(`📡 API Health: http://localhost:${PORT}/api/health`);
                console.log(`⏰ Started At: ${new Date().toLocaleString()}`);
                console.log("========================================\n");
            });
        }
        catch (error) {
            console.error("Failed to start server:", error);
            process.exit(1);
        }
    };
    // Handle unhandled promise rejections
    process.on("unhandledRejection", (err) => {
        console.error("Unhandled Rejection:", err);
        process.exit(1);
    });
    // Start the server
    startServer();
}
// Export the Express app for Vercel serverless
exports.default = app;
//# sourceMappingURL=server.js.map