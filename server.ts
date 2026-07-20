import "./config/env"; // must be first — loads .env before any module reads process.env
import "./config/observability";
import cors from "cors";
import express, { Application, NextFunction, Request, Response } from "express";
import http from "http";
import mongoose from "mongoose";
import morgan from "morgan";
import connectDB from "./config/db";
import { checkPostgres, postgresEnabled } from "./config/postgres";
import authRoutes from "./routes/authRoute";
import adminRoutes from "./routes/adminRoute";
import adminUserRoutes from "./routes/adminUserRoute";
import allClientsRoutes from "./routes/allClientsRoute";
import dashboardRoutes from "./routes/dashboardRoute";
import emailRoutes from "./routes/emailRoute";
import extractRoutes from "./routes/extractRoute";
import notificationRoutes from "./routes/notificationRoute";
import proposalRoutes from "./routes/proposalsRoute";
import publicAccessRoutes from "./routes/publicAccessRoute";
import settingsRoutes from "./routes/settingsRoute";
import userRoutes from "./routes/usersRoute";
import vendorResponseRoutes from "./routes/vendorResponseRoute";
import documentSourcesRoutes from "./routes/documentSourcesRoute";
import jobsRoutes from "./routes/jobsRoute";
import aiGatewayRoutes from "./routes/aiGatewayRoute";
import knowledgeImportRoutes from "./routes/knowledgeImportRoute";
import knowledgeReviewRoutes from "./routes/knowledgeReviewRoute";
import knowledgeRetrievalRoutes from "./routes/knowledgeRetrievalRoute";
import proposalContextRoutes from "./routes/proposalContextRoute";
import candidateApplicationRoutes from "./routes/candidateApplicationRoute";
import proposalDraftRoutes from "./routes/proposalDraftRoute";
import proposalWorkflowRoutes from "./routes/proposalWorkflowRoute";
import { startCronJobs } from "./utils/cronJobs";
import { initializeNotificationWebSocketServer } from "./utils/notificationService";
import { getUploadsDir } from "./utils/paths";
import { checkQueue } from "./src/modules/durableJobs/queue";
import {correlationMiddleware} from "./middleware/observability";

console.log("Loaded SMTP_MAIL:", process.env.SMTP_MAIL ? "***" : "UNDEFINED");
console.log(
  "Loaded SMTP_PASSWORD:",
  process.env.SMTP_PASSWORD ? "***" : "UNDEFINED",
);

const app: Application = express();
const PORT = process.env.PORT || 8000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
if(process.env.OBSERVABILITY_ENABLED!=="true")app.use(morgan("dev"));
app.use(correlationMiddleware);

// Prevent any proxy / CDN / browser from caching API responses
app.use((_req: Request, res: Response, next: NextFunction) => {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  next();
});

// Database connection middleware for serverless environments
app.use(async (_req: Request, _res: Response, next: NextFunction) => {
  try {
    // Ensure database is connected before handling requests
    // This is important for serverless/Vercel where connections may be dropped
    if (mongoose.connection.readyState !== 1) {
      await connectDB();
    }
    next();
  } catch (error) {
    console.error("Database connection middleware error:", error);
    next(error);
  }
});

// Serve static files from uploads directory

// Note: In serverless environments, static file serving may not work
// Consider using cloud storage (S3, Cloudinary, etc.) for production
try {
  const uploadsDir = getUploadsDir();
  app.use("/uploads", express.static(uploadsDir));
} catch (error) {
  console.warn(
    "Warning: Could not set up static file serving for uploads:",
    error,
  );
}

// Root route
app.get("/", (_req: Request, res: Response) => {
  res.json({
    success: true,
    message: "DXG RFP Tool - API is running!",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
  });
});

// Health check with database status
app.get("/health", async (_req: Request, res: Response) => {
  const dbStatus =
    mongoose.connection.readyState === 1 ? "connected" : "disconnected";
  let postgres: Awaited<ReturnType<typeof checkPostgres>> | { enabled: true; ready: false; migrationVersion: null; error: string } = {
    enabled: false, ready: false, migrationVersion: null,
  };
  if (postgresEnabled()) {
    try { postgres = await checkPostgres(); }
    catch { postgres = { enabled: true, ready: false, migrationVersion: null, error: "unavailable" }; }
  }
  const queue = await checkQueue();
  const isHealthy = mongoose.connection.readyState === 1 && (!postgres.enabled || postgres.ready) && (!queue.enabled || queue.ready);

  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? "OK" : "ERROR",
    timestamp: new Date().toISOString(),
    database: dbStatus,
    postgres,
    queue,
    observability: { enabled: process.env.OBSERVABILITY_ENABLED === "true", exporter: process.env.OBSERVABILITY_ENABLED === "true" ? "local_otlp" : "disabled" },
    environment: process.env.NODE_ENV || "development",
  });
});

// API welcome route
app.get("/api", (_req: Request, res: Response) => {
  res.json({
    success: true,
    message: "Welcome to Yunlai Porcelain Art Co. API",
    timestamp: new Date().toISOString(),
  });
});

// Auth routes
app.use("/api/auth", authRoutes);

// Admin routes
app.use("/api/admin", adminRoutes);
app.use("/api/admin-user", adminUserRoutes);

// Admin clients route
app.use("/api/all-clients", allClientsRoutes);

// User management routes
app.use("/api/users", userRoutes);

// Proposal routes
app.use("/api/proposals", proposalRoutes);
app.use("/api/public-access", publicAccessRoutes);
app.use("/api/v1", documentSourcesRoutes);
app.use("/api/v1", jobsRoutes);
app.use("/api/v1", aiGatewayRoutes);
app.use("/api/v1", knowledgeImportRoutes);
app.use("/api/v1", knowledgeReviewRoutes);
app.use("/api/v1", knowledgeRetrievalRoutes);
app.use("/api/v1", proposalContextRoutes);
app.use("/api/v1", candidateApplicationRoutes);
app.use("/api/v1", proposalDraftRoutes);
app.use("/api/v1", proposalWorkflowRoutes);

// Email campaign routes
app.use("/api/emails", emailRoutes);

// Notification routes
app.use("/api/notifications", notificationRoutes);

// Document extraction / AI auto-fill route
app.use("/api/extract-proposal", extractRoutes);

// Settings routes
app.use("/api/settings", settingsRoutes);

// Dashboard routes
app.use("/api/dashboard", dashboardRoutes);

// Vendor response routes
app.use("/api/vendor-responses", vendorResponseRoutes);

// 404 Handler
app.use((_req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    message: "Route not found",
  });
});

// Global Error Handler
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Global Error Handler:", err);
  res.status(err.status || 500).json({
    success: false,
    message: err.message || "Internal Server Error",
    error: process.env.NODE_ENV === "development" ? err : undefined,
  });
});

// Start server only if this file is run directly
if (require.main === module) {
  const startServer = async (): Promise<void> => {
    try {
      // Connect to database first
      await connectDB();
      
      // Initialize background workers
      startCronJobs();

      const server = http.createServer(app);
      initializeNotificationWebSocketServer(server);

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
    } catch (error) {
      console.error("Failed to start server:", error);
      process.exit(1);
    }
  };

  // Handle unhandled promise rejections
  process.on("unhandledRejection", (err: Error) => {
    console.error("Unhandled Rejection:", err);
    process.exit(1);
  });

  // Start the server
  startServer();
}

// Export the Express app for Vercel serverless
export default app;
