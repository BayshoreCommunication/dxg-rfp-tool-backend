import "./config/env"; // must be first — loads .env before any module reads process.env
import "./config/observability";
import cors from "cors";
import helmet from "helmet";
import express, { Application, NextFunction, Request, Response } from "express";
import http from "http";
import mongoose from "mongoose";
import morgan from "morgan";
import connectDB from "./config/db";
import { checkPostgres, closePostgres, postgresEnabled } from "./config/postgres";
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
import conversationsRoutes from "./routes/conversationsRoute";
import guidanceRoutes from "./routes/guidanceRoute";
import roomRecommendationRoutes from "./routes/roomRecommendationRoute";
import pricingRoutes from "./routes/pricingRoute";
import investmentRoutes from "./routes/investmentRoute";
import vendorAnalysisRoutes from "./routes/vendorAnalysisRoute";
import requirementRegistryRoutes from "./routes/requirementRegistryRoute";
import evidenceExtractionRoutes from "./routes/evidenceExtractionRoute";
import vendorIntelligenceRoutes from "./routes/vendorIntelligenceRoute";
import evaluationEngineRoutes from "./routes/evaluationEngineRoute";
import candidateApplicationRoutes from "./routes/candidateApplicationRoute";
import proposalDraftRoutes from "./routes/proposalDraftRoute";
import proposalWorkflowRoutes from "./routes/proposalWorkflowRoute";
import platformAssistantRoutes from "./routes/platformAssistantRoute";
import historicalInsightsRoutes from "./routes/historicalInsightsRoute";
import governedAssetRoutes from "./routes/governedAssetRoute";
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

// Production terminates TLS at nginx and proxies from loopback, so without this
// every request reports req.ip === "127.0.0.1" and each IP-keyed rate limiter
// collapses into one global bucket shared by all callers. One hop only —
// trusting more would let a client forge X-Forwarded-For and evade limits.
app.set("trust proxy", 1);

// Middleware
app.use(helmet());

// CORS allowlist: configured app origins only. Tracking pixels/redirects are
// plain GETs and remain unaffected; server-to-server calls have no Origin.
const corsAllowlist = [
  process.env.FRONTEND_URL,
  process.env.ADMIN_URL,
  ...(process.env.CORS_ALLOWED_ORIGINS || "").split(","),
  ...(process.env.NODE_ENV !== "production" ? ["http://localhost:3000", "http://localhost:3001"] : []),
].map((value) => (value || "").trim().replace(/\/$/, "")).filter(Boolean);
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || corsAllowlist.includes(origin)) return callback(null, true);
    callback(null, false);
  },
}));
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
app.use("/api/v1", conversationsRoutes);
app.use("/api/v1", guidanceRoutes);
app.use("/api/v1", roomRecommendationRoutes);
app.use("/api/v1", pricingRoutes);
app.use("/api/v1", investmentRoutes);
app.use("/api/v1", vendorAnalysisRoutes);
app.use("/api/v1", requirementRegistryRoutes);
app.use("/api/v1", evidenceExtractionRoutes);
app.use("/api/v1", vendorIntelligenceRoutes);
app.use("/api/v1", evaluationEngineRoutes);
app.use("/api/v1", candidateApplicationRoutes);
app.use("/api/v1", proposalDraftRoutes);
app.use("/api/v1", proposalWorkflowRoutes);
app.use("/api/v1", platformAssistantRoutes);
app.use("/api/v1", historicalInsightsRoutes);
app.use("/api/v1", governedAssetRoutes);

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

      // The cron jobs mutate and purge proposals with no cross-replica
      // locking, and two of them run immediately at startup. When the API
      // runs as more than one instance, exactly one may keep crons on;
      // the rest must set CRON_ENABLED=false. Default preserves the
      // single-instance behavior.
      if (process.env.CRON_ENABLED !== "false") {
        startCronJobs();
      } else {
        console.log("⏭  Cron jobs disabled on this instance (CRON_ENABLED=false)");
      }

      const server = http.createServer(app);
      initializeNotificationWebSocketServer(server);

      // A load balancer reuses idle keep-alive connections; Node's 5s default
      // closes them first, which surfaces as intermittent 502s at the LB.
      // Keep-alive must outlive the LB idle timeout (60s), and headersTimeout
      // must exceed keepAliveTimeout.
      server.keepAliveTimeout = 65_000;
      server.headersTimeout = 66_000;

      // Drain on SIGTERM/SIGINT: stop accepting connections, let in-flight
      // requests finish, then force-close whatever remains (long-lived SSE
      // and WebSocket connections never end on their own) inside the
      // orchestrator's stop grace period.
      let shuttingDown = false;
      const shutdown = (signal: string): void => {
        if (shuttingDown) return;
        shuttingDown = true;
        console.log(`${signal} received — draining connections before exit`);
        setTimeout(() => {
          server.closeAllConnections();
        }, 20_000).unref();
        setTimeout(() => {
          console.error("Shutdown grace period elapsed — exiting");
          process.exit(0);
        }, 25_000).unref();
        server.close(() => {
          void (async () => {
            try {
              await closePostgres();
              if (mongoose.connection.readyState !== 0) {
                await mongoose.disconnect();
              }
            } catch (error) {
              console.error("Shutdown cleanup error:", error);
            } finally {
              process.exit(0);
            }
          })();
        });
      };
      process.on("SIGTERM", () => shutdown("SIGTERM"));
      process.on("SIGINT", () => shutdown("SIGINT"));

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
