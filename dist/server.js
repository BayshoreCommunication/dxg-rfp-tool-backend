"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const cors_1 = __importDefault(require("cors"));
const dotenv_1 = __importDefault(require("dotenv"));
const express_1 = __importDefault(require("express"));
const http_1 = __importDefault(require("http"));
const mongoose_1 = __importDefault(require("mongoose"));
const morgan_1 = __importDefault(require("morgan"));
const db_1 = __importDefault(require("./config/db"));
const authRoute_1 = __importDefault(require("./routes/authRoute"));
const adminRoute_1 = __importDefault(require("./routes/adminRoute"));
const adminUserRoute_1 = __importDefault(require("./routes/adminUserRoute"));
const allClientsRoute_1 = __importDefault(require("./routes/allClientsRoute"));
const dashboardRoute_1 = __importDefault(require("./routes/dashboardRoute"));
const emailRoute_1 = __importDefault(require("./routes/emailRoute"));
const extractRoute_1 = __importDefault(require("./routes/extractRoute"));
const notificationRoute_1 = __importDefault(require("./routes/notificationRoute"));
const proposalsRoute_1 = __importDefault(require("./routes/proposalsRoute"));
const settingsRoute_1 = __importDefault(require("./routes/settingsRoute"));
const usersRoute_1 = __importDefault(require("./routes/usersRoute"));
const cronJobs_1 = require("./utils/cronJobs");
const notificationService_1 = require("./utils/notificationService");
const paths_1 = require("./utils/paths");
// Load environment variables
dotenv_1.default.config();
console.log("Loaded SMTP_MAIL:", process.env.SMTP_MAIL ? "***" : "UNDEFINED");
console.log("Loaded SMTP_PASSWORD:", process.env.SMTP_PASSWORD ? "***" : "UNDEFINED");
const app = (0, express_1.default)();
const PORT = process.env.PORT || 8000;
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
        message: "DXG RFP Tool - API is running!",
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
app.use("/api/auth", authRoute_1.default);
// Admin routes
app.use("/api/admin", adminRoute_1.default);
app.use("/api/admin-user", adminUserRoute_1.default);
// Admin clients route
app.use("/api/all-clients", allClientsRoute_1.default);
// User management routes
app.use("/api/users", usersRoute_1.default);
// Proposal routes
app.use("/api/proposals", proposalsRoute_1.default);
// Email campaign routes
app.use("/api/emails", emailRoute_1.default);
// Notification routes
app.use("/api/notifications", notificationRoute_1.default);
// Document extraction / AI auto-fill route
app.use("/api/extract-proposal", extractRoute_1.default);
// Settings routes
app.use("/api/settings", settingsRoute_1.default);
// Dashboard routes
app.use("/api/dashboard", dashboardRoute_1.default);
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
            // Initialize background workers
            (0, cronJobs_1.startCronJobs)();
            const server = http_1.default.createServer(app);
            (0, notificationService_1.initializeNotificationWebSocketServer)(server);
            // Start listening after database connection
            server.listen(PORT, () => {
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