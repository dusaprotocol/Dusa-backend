import type { Express, Request } from "express";
import rateLimit, {
  type Options,
  type RateLimitInfo,
} from "express-rate-limit";
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

const ONE_MINUTE_MS = 60 * 1000;
const envNumber = (key: string, fallback: number) => {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

// Procedures that write to the database: much lower limit than reads
const WRITE_PROCEDURES = ["beReferred", "registerDiscord", "getCode"];
const isWriteRequest = (req: Request) =>
  WRITE_PROCEDURES.some((name) => req.path.includes(name));

const limiter = (name: string, limit: number, opts: Partial<Options> = {}) =>
  rateLimit({
    windowMs: ONE_MINUTE_MS,
    limit,
    standardHeaders: mode === "enforce" ? "draft-7" : false,
    legacyHeaders: false,
    handler: (req, res, next, options) => {
      // log once per client and window, not on every request over the limit
      const info = (req as typeof req & { rateLimit?: RateLimitInfo })
        .rateLimit;
      if (info && info.used === info.limit + 1)
        logger.warn(
          `rate limit ${name}: ${req.ip} went over ${info.limit} req/min` +
            (mode === "log" ? " (log only, not blocked)" : "")
        );
      if (mode === "log") return next();
      res.status(options.statusCode).send(options.message);
    },
    ...opts,
  });

/**
 * Per-IP rate limits for the API. Counters live in memory, so each instance
 * (e.g. two deployments behind different URLs) counts separately.
 */
export const applyRateLimits = (app: Express) => {
  // Behind a hosting proxy (Railway, Render...), the client IP is in X-Forwarded-For:
  // trust exactly that many proxies, otherwise every request has the proxy's IP.
  app.set("trust proxy", envNumber("TRUST_PROXY_HOPS", 1));
  if (mode === "off") return;

  logger.info(`Rate limiting: ${mode}`);
  app.use(limiter("all", envNumber("RATE_LIMIT_PER_MINUTE", 600)));
  app.use(
    limiter("writes", envNumber("RATE_LIMIT_WRITES_PER_MINUTE", 10), {
      skip: (req) => !isWriteRequest(req),
    })
  );
};
