import type { Express } from "express";
import rateLimit, { type RateLimitInfo } from "express-rate-limit";
import logger from "../../common/logger";

// Same modes as the API (see api/src/rateLimit.ts): "log" (default), "enforce", "off"
type Mode = "off" | "log" | "enforce";
const mode: Mode = ["off", "log", "enforce"].includes(
  process.env.RATE_LIMIT_MODE ?? ""
)
  ? (process.env.RATE_LIMIT_MODE as Mode)
  : "log";

const envNumber = (key: string, fallback: number) => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

/**
 * Per-IP rate limit on the routes that query the Massa node (they cost a node call
 * each). Counters live in memory, per instance.
 */
export const applyRateLimits = (app: Express) => {
  // Behind a hosting proxy, the client IP is in X-Forwarded-For
  app.set("trust proxy", envNumber("TRUST_PROXY_HOPS", 1));
  if (mode === "off") return;

  logger.info(`Rate limiting: ${mode}`);
  app.use(
    ["/datastore-keys", "/datastore-entries", "/bytecode-exports"],
    rateLimit({
      windowMs: 60 * 1000,
      limit: envNumber("RATE_LIMIT_NODE_PER_MINUTE", 60),
      standardHeaders: mode === "enforce" ? "draft-7" : false,
      legacyHeaders: false,
      handler: (req, res, next, options) => {
        const info = (req as typeof req & { rateLimit?: RateLimitInfo })
          .rateLimit;
        if (info && info.used === info.limit + 1)
          logger.warn(
            `rate limit: ${req.ip} went over ${info.limit} req/min` +
              (mode === "log" ? " (log only, not blocked)" : "")
          );
        if (mode === "log") return next();
        res.status(options.statusCode).send(options.message);
      },
    })
  );
};
