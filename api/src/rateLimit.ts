import type { Express, NextFunction, Request, Response } from "express";
import logger from "../../common/logger";

// RATE_LIMIT_MODE:
// - "log" (default): count requests per IP and log the clients that go over the limit,
//   without blocking them. Use it to tune the limits against real traffic first.
// - "enforce": reply 429 (with a Retry-After header) once the limit is reached.
// - "off": no rate limiting.
type Mode = "off" | "log" | "enforce";
const mode: Mode = ["off", "log", "enforce"].includes(
  process.env.RATE_LIMIT_MODE ?? ""
)
  ? (process.env.RATE_LIMIT_MODE as Mode)
  : "log";

const WINDOW_MS = 60 * 1000;
const envNumber = (key: string, fallback: number) => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const TRPC_PREFIX = "/trpc/";
// Procedures that write to the database: much lower limit than reads
const WRITE_PROCEDURES = new Set(["beReferred", "registerDiscord", "getCode"]);

/**
 * Procedures called by a request. tRPC batches several calls in one HTTP request
 * (`/trpc/a,b,c?batch=1`) and URL-decodes their names, so limits must count each
 * decoded call, not the request.
 */
export const calledProcedures = (req: Request): string[] => {
  if (!req.path.startsWith(TRPC_PREFIX)) return [];
  try {
    return decodeURIComponent(req.path.slice(TRPC_PREFIX.length)).split(",");
  } catch {
    return [req.path]; // malformed encoding: tRPC rejects it, count it once
  }
};

/**
 * Fixed-window counter per client IP, where one request can weigh several units.
 * Counters are kept in memory (per instance) and dropped at the end of each window.
 */
const weightedLimiter = (
  name: string,
  limit: number,
  weight: (req: Request) => number
) => {
  let windowStart = Date.now();
  let counts = new Map<string, number>();

  return (req: Request, res: Response, next: NextFunction) => {
    const units = weight(req);
    if (units === 0) return next();

    const now = Date.now();
    if (now - windowStart >= WINDOW_MS) {
      windowStart = now;
      counts = new Map();
    }
    const key = req.ip ?? "unknown";
    const before = counts.get(key) ?? 0;
    const used = before + units;
    counts.set(key, used);
    if (used <= limit) return next();

    // log once per client and window, not on every request over the limit
    if (before <= limit)
      logger.warn(
        `rate limit ${name}: ${key} went over ${limit} per minute` +
          (mode === "log" ? " (log only, not blocked)" : "")
      );
    if (mode === "log") return next();

    const retryAfter = Math.ceil((windowStart + WINDOW_MS - now) / 1000);
    res.set("Retry-After", String(retryAfter));
    res.status(429).send("Too many requests, please try again later.");
  };
};

/**
 * Per-IP rate limits for the API. Each call of a tRPC batch counts as one unit.
 * Counters live in memory, so each instance (e.g. two deployments behind different
 * URLs) counts separately.
 */
export const applyRateLimits = (app: Express) => {
  // Behind a hosting proxy (Railway, Render...), the client IP is in X-Forwarded-For:
  // trust exactly that many proxies, otherwise every request has the proxy's IP.
  app.set("trust proxy", envNumber("TRUST_PROXY_HOPS", 1));
  if (mode === "off") return;

  const maxBatch = envNumber("RATE_LIMIT_MAX_BATCH", 100);
  logger.info(`Rate limiting: ${mode}`);

  // A single request can't carry an unbounded number of calls
  app.use((req, res, next) => {
    const calls = calledProcedures(req).length;
    if (calls <= maxBatch) return next();
    logger.warn(
      `rate limit batch: ${req.ip} sent ${calls} calls in one request`
    );
    if (mode === "log") return next();
    res.status(413).send(`Too many calls in one request (max ${maxBatch})`);
  });
  app.use(
    weightedLimiter(
      "all",
      envNumber("RATE_LIMIT_PER_MINUTE", 600),
      (req) => calledProcedures(req).length || 1
    )
  );
  app.use(
    weightedLimiter(
      "writes",
      envNumber("RATE_LIMIT_WRITES_PER_MINUTE", 10),
      (req) =>
        calledProcedures(req).filter((p) => WRITE_PROCEDURES.has(p)).length
    )
  );
};
