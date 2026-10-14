import { initTRPC } from "@trpc/server";
import NodeCache from "node-cache";
import {
  secondsUntilNextTick as _secondsUntilNextTick,
  secondsUntilNextFriday,
} from "../../common/utils";
import logger from "../../common/logger";

// =====================================================================================================
// Adapted from https://stackoverflow.com/questions/77512021/implementing-server-side-caching-middleware-in-trpc-10
// (Stack Overflow content, licensed under CC BY-SA 4.0)
// =====================================================================================================

// Constants (in s)
const ONE_MINUTE = 60;
const ONE_HOUR = 60 * ONE_MINUTE;
const ONE_DAY = 24 * ONE_HOUR;

const stdTTL = 5 * ONE_MINUTE;
// Every query input gets its own cache entry: cap the number of entries so varying
// inputs cannot grow the cache without bound. When full, responses are just not cached.
const maxKeys = 50_000;
const cacheSingleton = new NodeCache({ stdTTL, maxKeys });

const cacheSet = (key: string, value: unknown, ttl?: number) => {
  try {
    if (ttl === undefined) cacheSingleton.set(key, value);
    else cacheSingleton.set(key, value, ttl);
  } catch {
    // ECACHEFULL: serve the response without caching it
  }
};

const secondsUntilNextTick = () => _secondsUntilNextTick() + 30; // 30s buffer to account for cron job delay
// A map of cached procedure names to a callable that gives a TTL in seconds
// Names not defined will use `stdTTL`
const cachedProcedures: Map<string, (() => number) | undefined> = new Map();
cachedProcedures.set("getMasCirculatingSupply", () => ONE_DAY);
cachedProcedures.set("getVolume", secondsUntilNextTick);
cachedProcedures.set("getTVL", secondsUntilNextTick);
cachedProcedures.set("get24H", secondsUntilNextTick);
cachedProcedures.set("getProBanner24H", secondsUntilNextTick);
cachedProcedures.set("getPrice", secondsUntilNextTick);
cachedProcedures.set("getGlobalVolume", secondsUntilNextTick);
cachedProcedures.set("getGlobalTVL", () => ONE_HOUR);
cachedProcedures.set("getTokenValue", () => ONE_MINUTE);
cachedProcedures.set("getGlobalLeaderboard", () => ONE_DAY);
cachedProcedures.set("getGlobalLeaderboardLength", () => ONE_DAY);
cachedProcedures.set("getGlobalLeaderboardUser", () => ONE_DAY);
cachedProcedures.set("getGlobalLeaderboardUserDetails", () => ONE_DAY);
cachedProcedures.set("getPointsAPR", () => ONE_HOUR);
cachedProcedures.set("getPointsAPR2", secondsUntilNextFriday);
cachedProcedures.set("getPointsAPR2Batch", secondsUntilNextFriday);
cachedProcedures.set("get2024Wrapped", () => ONE_DAY);
cachedProcedures.set("get2024WrappedGlobal", () => ONE_DAY);
cachedProcedures.set("getDelegatees", () => ONE_DAY);
cachedProcedures.set("getEmissions", () => ONE_DAY);

const t = initTRPC.create();
const middlewareMarker = "middlewareMarker" as "middlewareMarker" & {
  __brand: "middlewareMarker";
};

const cacheMiddleware = t.middleware(
  async ({ ctx, next, path, type, rawInput }) => {
    if (type !== "query") {
      return next();
    }
    let key = path.toLowerCase();
    if (rawInput) {
      key += JSON.stringify(rawInput).replace(/\"/g, "'");
    }
    const cachedData = cacheSingleton.get(key);
    if (cachedData) {
      // logger.silly("Cache hit: " + key);
      return {
        ok: true,
        data: cachedData,
        ctx,
        marker: middlewareMarker,
      };
    }
    const result = await next();

    // @ts-ignore
    // data is not defined in the type MiddlewareResult
    const dataCopy = structuredClone(result.data);

    const ttlSecondsCallable = cachedProcedures.get(path);
    if (ttlSecondsCallable) {
      // logger.silly(`Cache miss: ${key}, ${ttlSecondsCallable()}`);
      cacheSet(key, dataCopy, ttlSecondsCallable());
    } else {
      cacheSet(key, dataCopy);
    }
    return result;
  }
);
export default cacheMiddleware;
