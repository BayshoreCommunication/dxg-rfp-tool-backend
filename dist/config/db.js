"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const mongoose_1 = __importDefault(require("mongoose"));
// Mongoose connection caching for serverless
let isConnected = false;
let connectionPromise = null;
const connectDB = async () => {
    // If already connected, reuse connection
    if (isConnected && mongoose_1.default.connection.readyState === 1) {
        console.log("✅ Using existing MongoDB connection");
        return;
    }
    // If connection is in progress, wait for it
    if (connectionPromise) {
        console.log("⏳ Waiting for existing connection attempt...");
        return connectionPromise;
    }
    // Create connection promise to prevent multiple simultaneous connection attempts
    connectionPromise = (async () => {
        try {
            // Support both variable names for flexibility
            const mongoURI = process.env.MONGODB_URL || process.env.MONGO_URL;
            if (!mongoURI) {
                throw new Error("MONGODB_URL environment variable is not defined");
            }
            console.log("🔄 Attempting to connect to MongoDB...");
            const conn = await mongoose_1.default.connect(mongoURI, {
                // Database name
                dbName: "dxg_rfp_tool_db",
                // Optimized for serverless/Vercel deployment
                bufferCommands: false, // Disable buffering to fail fast if not connected
                serverSelectionTimeoutMS: 30000, // Increased to 30s (was 10s - causing timeouts)
                socketTimeoutMS: 45000, // Close sockets after 45s of inactivity
                connectTimeoutMS: 30000, // Connection timeout set to 30s
                maxPoolSize: 10, // Maintain up to 10 socket connections
                minPoolSize: 0, // Changed from 1 to 0 for serverless (don't keep connections idle)
                maxIdleTimeMS: 10000, // Reduced to 10s (was 30s) to release unused connections faster
                heartbeatFrequencyMS: 10000, // Send heartbeat every 10s to keep connection alive
                retryWrites: true,
                w: "majority",
            });
            isConnected = true;
            console.log("========================================");
            console.log("✅ Database Connected Successfully!");
            console.log("========================================");
            console.log(`🔗 Host: ${conn.connection.host}`);
            console.log(`📊 Database: ${conn.connection.name}`);
            console.log(`⏰ Connected At: ${new Date().toLocaleString()}`);
            console.log("========================================\n");
            connectionPromise = null; // Reset connection promise on success
        }
        catch (error) {
            console.error("========================================");
            console.error("❌ Database Connection Error:");
            console.error("========================================");
            console.error(error instanceof Error ? error.message : "Unknown error");
            console.error("Full error:", error);
            console.error("========================================\n");
            isConnected = false;
            connectionPromise = null; // Reset connection promise on error
            // Don't exit in production (serverless can't handle process.exit)
            if (process.env.NODE_ENV !== "production") {
                process.exit(1);
            }
            else {
                // In production, throw the error so the serverless function can report it
                throw error;
            }
        }
    })();
    return connectionPromise;
};
// Handle connection events
mongoose_1.default.connection.on("connected", () => {
    isConnected = true;
    console.log("MongoDB connection established");
});
mongoose_1.default.connection.on("disconnected", () => {
    isConnected = false;
    console.log("⚠️  MongoDB disconnected");
});
mongoose_1.default.connection.on("error", (err) => {
    isConnected = false;
    console.error("❌ MongoDB connection error:", err);
});
exports.default = connectDB;
//# sourceMappingURL=db.js.map