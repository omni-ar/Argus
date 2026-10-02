import "dotenv/config";
import express from "express";
import cors from "cors";
import { logger } from "./utils/logger.js";
import { register } from "./monitoring/metrics.js";
import { validatorRouter } from "./routes/validatorRoutes.js";
import {
  initRedis,
  closeRedis,
  isRedisHealthy,
  getCacheStats,
} from "./cache/redisClient.js";
import { PORT } from "../constants.js";

const app = express();
const port = PORT || "3000";

// ─── Initialize Redis ─────────────────────────────────────────────────────────
initRedis();

app.use(cors());
app.use(express.json());

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/api/validators", validatorRouter);

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/health", async (_req, res) => {
  const redisHealthy = await isRedisHealthy();
  const cacheStats = await getCacheStats();

  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    redis: {
      connected: redisHealthy,
      ...(cacheStats && {
        keys: cacheStats.keys,
        memoryUsed: cacheStats.memoryUsed,
      }),
    },
  });
});

// ─── Metrics ──────────────────────────────────────────────────────────────────
app.get("/metrics", async (_req, res) => {
  try {
    res.set("Content-Type", register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    logger.error("Failed to serialize metrics", {
      code: "METRICS_SERIALIZE_ERROR",
      message: String(err),
    });
    res.status(500).end();
  }
});

// ─── Graceful shutdown ────────────────────────────────────────────────────────
const shutdown = async () => {
  logger.info("Shutting down gracefully...");
  await closeRedis();
  process.exit(0);
};

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(port, () => {
  logger.info(`Backend running`, {
    port,
    health: `http://localhost:${port}/health`,
    metrics: `http://localhost:${port}/metrics`,
  });
});
