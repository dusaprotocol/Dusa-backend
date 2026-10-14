import * as trpcExpress from "@trpc/server/adapters/express";
import { TRPCError, inferAsyncReturnType, initTRPC } from "@trpc/server";
import { z } from "zod";
import { FullSwap, type Points, type Prisma, type Swap } from "@prisma/client";
import {
  handlePrismaError,
  prisma,
  getWhitelistedPools,
} from "../../common/db";
import logger from "../../common/logger";
import {
  getDailyTick,
  launchTimestamp,
  ONE_DAY,
  ONE_HOUR,
  ONE_MINUTE,
  ONE_WEEK,
  TICKS_PER_DAY,
} from "../../common/utils/date";
import {
  cache,
  calculateWeeklyStreak,
  isAddressValid,
  round,
  toToken,
} from "../../common/methods";
import { getDatastoreKeys, getTokenValue } from "../../common/datastoreFetcher";
import { web3Client } from "../../common/client";
import { FEE_WEIGHT, WEEKLY_POINTS } from "../../common/config";
import { OpenApiMeta } from "trpc-openapi";
import { fetchTokenValue } from "./coingecko";
import {
  Account,
  Args,
  PublicKey,
  Signature,
  strToBytes,
  U256,
  U64,
  Web3Provider,
} from "@massalabs/massa-web3";
import cacheMiddleware from "./middlewares";
import { getRoles, getUser } from "./discord";
import { normalize } from "./tradingview";
import {
  JELLY,
  multicallSC,
  TOKENS,
  votingEscrowSC,
} from "../../common/contracts";
import { IBaseContract, IMulticall, Tx } from "@dusalabs/sdk";

// Upper bounds for list inputs, so one request cannot make the API load unbounded data
const MAX_ARRAY_INPUT = 1000;
const MAX_HOPS = 3; // swap routes in the interface use at most 3 pools
const MAX_LEDGER_KEYS = 1000; // keys per ledger history request

// Discord IDs are snowflakes (digits only). They are put in Discord API URLs sent with
// the bot token, so anything else (e.g. "../channels/...") must be rejected.
const discordIdSchema = z.string().regex(/^\d{17,20}$/, "Invalid Discord ID");

const addressSchema = z
  .string()
  .refine(isAddressValid, { message: "Invalid address format" });

const DayWindow = z.union([
  z.literal(7),
  z.literal(30),
  z.literal(90),
  z.literal(180),
]);

const recentSwapsTokensSchema = z.object({
  userAddress: addressSchema.optional(),
  token0Address: addressSchema,
  token1Address: addressSchema,
  take: z.number().lte(100),
  skip: z.number().min(0).default(0),
});
const recentSwapsSchema = z.object({
  poolAddress: addressSchema,
  take: z.number().lte(100),
  skip: z.number().min(0).default(0),
});

type Volume = Prisma.AnalyticsGetPayload<{
  select: { volume: true; date: true };
}>;

type TVL = Prisma.AnalyticsGetPayload<{
  select: { usdLocked: true; date: true };
}>;

const selectPrice = {
  open: true,
  close: true,
  high: true,
  low: true,
  date: true,
};
type Price = Prisma.AnalyticsGetPayload<{ select: typeof selectPrice }>;

type Leaderboard = Prisma.MakerGetPayload<{
  select: {
    address: true;
    accruedFeesUsd: true;
    volume: true;
  };
}> & { feesPct: number };

type UserLeaderboard = {
  userAddress: string;
  userRank: number;
  score: number;
};

export const createContext = ({
  req,
  res,
}: trpcExpress.CreateExpressContextOptions) => ({
  req,
  res,
  prisma,
});
export type Context = inferAsyncReturnType<typeof createContext>;

export const t = initTRPC.meta<OpenApiMeta>().context<Context>().create();

const router = t.router;

// by default, all routes are cached
// use `t.procedure` instead of `procedure` to bypass
const procedure = t.procedure.use(cacheMiddleware);

export const appRouter = router({
  // ------------
  //    DUSA
  // ------------

  // user portfolio
  getOperationsMeta: t.procedure
    .input(
      z.object({
        address: addressSchema,
        take: z.number().max(100).default(50),
        skip: z.number().min(0).default(0),
      })
    )
    .output(
      z.object({
        swapTxs: z.array(z.any()),
        liquidityTxs: z.array(z.any()),
      })
    )
    .meta({ openapi: { method: "GET", path: "/operations" } })
    .query(async ({ ctx, input }) => {
      return getOperations(input);
    }),
  getOperations: t.procedure
    .input(
      z.object({
        address: addressSchema,
        take: z.number().max(100).default(50),
        skip: z.number().min(0).default(0),
      })
    )
    .query(async ({ ctx, input }) => {
      return getOperations(input);
    }),
  // CEDE campaign
  getUserLiqOps: procedure
    .input(
      z.object({
        address: addressSchema,
      })
    )
    .output(
      z.array(
        z.object({
          usdValue: z.number(),
          timestamp: z.date(),
          userAddress: addressSchema,
        })
      )
    )
    .meta({ openapi: { method: "GET", path: "/deposits" } })
    .query(async ({ input }) => {
      const { address } = input;
      const res = await prisma.user.findUnique({
        include: { liquidityTxs: { orderBy: { timestamp: "desc" } } },
        where: { address },
      });
      if (!res || !res.liquidityTxs) return [];
      return res.liquidityTxs;
    }),
  // pro chart
  getMasCirculatingSupply: procedure
    .input(z.object({}).optional())
    .output(z.number())
    .query(async () => {
      const api = process.env.CIRCULATING_SUPPLY_API;
      if (!api)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "api url not defined",
        });

      return fetch(api).then((res) => res.json());
    }),
  getMasTotalSupply: procedure
    .input(z.object({}).optional())
    .output(z.number())
    .query(async () => {
      const api = "https://stats.massa.foundation/grs/api.dws?q=totalcoins";
      if (!api)
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "api url not defined",
        });

      return fetch(api).then((res) => res.json());
    }),
  // pool volume chart
  getVolume: procedure
    .input(z.object({ address: addressSchema, take: DayWindow }))
    .query(async ({ input, ctx }) => {
      const { address, take } = input;
      return ctx.prisma.dailyAnalytics.findMany({
        select: { volume: true, date: true },
        where: {
          poolAddress: address,
          date: { gt: new Date(Date.now() - ONE_DAY * take) },
        },
        orderBy: { date: "asc" },
        take,
      });
    }),
  // pool TVL chart
  getTVL: procedure
    .input(z.object({ address: addressSchema, take: DayWindow }))
    .query(async ({ input, ctx }) => {
      const { address, take } = input;
      return ctx.prisma.dailyAnalytics.findMany({
        select: { usdLocked: true, date: true },
        where: {
          poolAddress: address,
          date: { gt: new Date(Date.now() - ONE_DAY * take) },
        },
        orderBy: { date: "asc" },
        take,
      });
    }),
  // pool bins traded chart
  getBinsTraded: procedure
    .input(
      z.object({
        address: addressSchema,
        take: DayWindow.or(z.literal(1)),
      })
    )
    .query(async ({ input, ctx }) => {
      const { address, take } = input;
      return ctx.prisma.bin
        .groupBy({
          by: ["binId"],
          where: {
            poolAddress: address,
            date: { gt: new Date(Date.now() - ONE_DAY * take) },
          },
          _sum: { volumeUsd: true },
        })
        .then((res) =>
          res.map((a) => ({
            binId: a.binId,
            volumeUsd: a._sum.volumeUsd || 0,
          }))
        );
    }),
  // pool volume/fees + change in the last 24h
  get24H: procedure.input(addressSchema).query(async ({ input, ctx }) => {
    return ctx.prisma.analytics
      .findMany({
        select: { volume: true, fees: true, date: true },
        where: {
          poolAddress: input,
          date: {
            gt: new Date(Date.now() - ONE_DAY * 2), // greater than 48h ago to calculate 24h change
          },
          volume: { gt: 0 },
        },
        orderBy: { date: "desc" },
      })
      .then((analytics) => {
        const _24hago = new Date(Date.now() - ONE_DAY);

        const changeIndex = analytics.findIndex(
          (analytic) => analytic.date.getTime() < _24hago.getTime()
        );
        const today = analytics.slice(0, changeIndex);
        const yesterday = analytics.slice(changeIndex);

        const reduce = (
          arr: (Volume & { fees: number })[],
          key: "volume" | "fees"
        ) => arr.reduce((acc, curr) => acc + Number(curr[key]), 0);

        const getChange = (today: number, yesterday: number) =>
          yesterday === 0 ? 0 : ((today - yesterday) / yesterday) * 100;

        const fees = reduce(today, "fees");
        const feesYesterday = reduce(yesterday, "fees");
        const volume = reduce(today, "volume");
        const volumeYesterday = reduce(yesterday, "volume");
        const feesPctChange = getChange(fees, feesYesterday);
        const volumePctChange = getChange(volume, volumeYesterday);

        return { fees, volume, feesPctChange, volumePctChange };
      })
      .catch((err) => {
        logger.error(err.message);
        return { fees: 0, volume: 0, feesPctChange: 0, volumePctChange: 0 };
      });
  }),
  // pool high/low/price/volume/fees + change in the last 24h
  getProBanner24H: procedure
    .input(
      z.object({
        poolAddress: addressSchema.optional(),
        poolAddresses: z.array(addressSchema).max(MAX_ARRAY_INPUT).optional(),
        token0Address: addressSchema,
        token1Address: addressSchema,
      })
    )
    .query(async ({ input, ctx }) => {
      const { poolAddress, poolAddresses, token0Address, token1Address } =
        input;
      if (!poolAddress && !poolAddresses)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "poolAddress or poolAddresses is required",
        });

      // Retrieve pools which include either token0 or token1
      const pools = await ctx.prisma.pool.findMany({
        select: { address: true, token0Address: true, token1Address: true },
        where: {
          OR: [
            { token0Address },
            { token1Address },
            { token1Address: token0Address },
            { token0Address: token1Address },
          ],
        },
      });

      const calculateVolume = async (tokenAddress: string) => {
        const relevantPools = pools.filter(
          (pool) =>
            pool.token0Address === tokenAddress ||
            pool.token1Address === tokenAddress
        );
        const volumes = await Promise.all(
          relevantPools.map(async (pool) => {
            const swaps = await ctx.prisma.swap.findMany({
              where: {
                poolAddress: pool.address,
                timestamp: {
                  gt: new Date(Date.now() - ONE_DAY * 2),
                },
              },
              orderBy: { timestamp: "desc" },
            });

            const _24hAgo = new Date(Date.now() - ONE_DAY);
            const changeIndex = swaps.findIndex(
              (swap) => swap.timestamp.getTime() < _24hAgo.getTime()
            );

            const today = swaps.slice(0, changeIndex);
            const yesterday = swaps.slice(changeIndex);

            return {
              usdVolumeToday: today.reduce(
                (acc, curr) => acc + curr.usdValue,
                0
              ),
              usdVolumeYesterday: yesterday.reduce(
                (acc, curr) => acc + curr.usdValue,
                0
              ),
            };
          })
        );

        const totalVolumeToday = volumes.reduce(
          (acc, curr) => acc + curr.usdVolumeToday,
          0
        );
        const totalVolumeYesterday = volumes.reduce(
          (acc, curr) => acc + curr.usdVolumeYesterday,
          0
        );

        const usdVolumePctChange =
          totalVolumeYesterday === 0
            ? 0
            : ((totalVolumeToday - totalVolumeYesterday) /
                totalVolumeYesterday) *
              100;

        return {
          usdVolume: totalVolumeToday,
          usdVolumePctChange,
        };
      };

      const [usdVolumeToken0, usdVolumeToken1, highLowPrice] =
        await Promise.all([
          calculateVolume(token0Address),
          calculateVolume(token1Address),
          ctx.prisma.analytics
            .findMany({
              select: { ...selectPrice, volume: true, poolAddress: true },
              where: {
                poolAddress: poolAddress ? poolAddress : { in: poolAddresses },
                date: { gt: new Date(Date.now() - ONE_DAY) },
              },
              orderBy: { date: "desc" },
            })
            .then((_analytics) => {
              const hops = poolAddresses?.length || 1;
              const analytics =
                hops > 1 ? normalize(_analytics, hops) : _analytics;
              const _24hAgo = new Date(Date.now() - ONE_DAY);
              const today = analytics.filter(
                (analytic) => analytic.date.getTime() >= _24hAgo.getTime()
              );

              const high = today.reduce(
                (acc, curr) => Math.max(curr.high, acc),
                -Infinity
              );
              const low = today.reduce(
                (acc, curr) => Math.min(curr.low, acc),
                Infinity
              );

              const priceChange = today.length
                ? (today[today.length - 1].close - today[0].open) * -1
                : 0;
              const pricePctChange =
                today.length && today[today.length - 1].close !== 0
                  ? priceChange / today[today.length - 1].close
                  : 0;

              return { high, low, priceChange, pricePctChange };
            })
            .catch((err) => {
              logger.error(err.toString());
              return { high: 0, low: 0, priceChange: 0, pricePctChange: 0 };
            }),
        ]);

      return {
        ...highLowPrice,
        usdVolumeToken0,
        usdVolumeToken1,
      };
    }),
  // pool most recent swaps
  getRecentSwapsMeta: procedure
    .input(recentSwapsSchema)
    .output(z.array(z.any()))
    .meta({ openapi: { method: "GET", path: "/swaps" } })
    .query(async ({ input, ctx }) => {
      const { poolAddress, take, skip } = input;
      const p = ctx ? ctx.prisma : prisma;
      return p.swap.findMany({
        where: { poolAddress },
        orderBy: { timestamp: "desc" },
        take,
        skip,
      });
    }),
  getRecentSwaps: procedure
    .input(recentSwapsSchema)
    .query(async ({ input, ctx }) => {
      const { poolAddress, take, skip } = input;
      const p = ctx ? ctx.prisma : prisma;
      return p.swap.findMany({
        where: { poolAddress },
        orderBy: { timestamp: "desc" },
        take,
        skip,
      });
    }),
  getRecentSwapsTokensMeta: procedure
    .input(recentSwapsTokensSchema)
    .output(z.array(z.any()))
    .meta({ openapi: { method: "GET", path: "/swaps-tokens" } })
    .query(async ({ input, ctx }) => {
      return getRecentSwapsTokens(input);
    }),
  getRecentSwapsTokens: procedure
    .input(recentSwapsTokensSchema)
    .query(async ({ input, ctx }) => {
      return getRecentSwapsTokens(input);
    }),
  // pool most recent deposits/withdrawals
  getRecentLiquidityMeta: procedure
    .input(recentSwapsSchema)
    .output(z.array(z.any()))
    .meta({ openapi: { method: "GET", path: "/liquidity" } })
    .query(async ({ input, ctx }) => {
      const { poolAddress, take, skip } = input;
      const p = ctx ? ctx.prisma : prisma;
      return p.liquidity.findMany({
        where: { poolAddress },
        orderBy: { timestamp: "desc" },
        take,
        skip,
      });
    }),
  getRecentLiquidity: t.procedure
    .input(recentSwapsSchema)
    .query(async ({ input, ctx }) => {
      const { poolAddress, take, skip } = input;
      const p = ctx ? ctx.prisma : prisma;
      return p.liquidity.findMany({
        where: { poolAddress },
        orderBy: { timestamp: "desc" },
        take,
        skip,
      });
    }),
  getSwapsFromHashes: procedure
    .input(z.object({ hashes: z.array(z.string()).max(MAX_ARRAY_INPUT) }))
    .query(async ({ input, ctx }) => {
      const { hashes } = input;
      return ctx.prisma.swap.findMany({
        where: { txHash: { in: hashes } },
        include: { pool: { select: { token0: true, token1: true } } },
      });
    }),
  getLiquiditiesFromHashes: procedure
    .input(z.object({ hashes: z.array(z.string()).max(MAX_ARRAY_INPUT) }))
    .query(async ({ input, ctx }) => {
      const { hashes } = input;
      return ctx.prisma.liquidity.findMany({
        where: { txHash: { in: hashes } },
        include: {
          pool: { select: { token0: true, token1: true, binStep: true } },
        },
      });
    }),
  getPriceOnDate: procedure
    .input(
      z.object({
        poolAddress: z.string(),
        dates: z.array(z.string()).max(MAX_ARRAY_INPUT),
      })
    )
    .query(async ({ input, ctx }) => {
      const { poolAddress, dates } = input;
      try {
        const results = await ctx.prisma.analytics.findMany({
          where: { poolAddress, date: { in: dates } },
        });

        const dateToLowMap = results.reduce(
          (acc, item) => {
            const dateKey = item.date.toISOString();
            acc[dateKey] = item.low;
            return acc;
          },
          {} as Record<string, number>
        );

        const lowPrices = dates.map((d) => dateToLowMap[d] ?? 0);

        return lowPrices;
      } catch (err) {
        logger.error(err);
        return dates.map(() => 0);
      }
    }),
  // pool simple price chart
  getPrice: procedure
    .input(
      z.object({
        poolAddress: addressSchema,
        take: z.union([z.literal(1), z.literal(7), z.literal(30)]),
      })
    )
    .query(async ({ input, ctx }) => {
      const { poolAddress, take } = input;
      const pool = await ctx.prisma.pool.findFirst({
        where: { address: poolAddress },
      });
      if (
        pool &&
        (pool.token0Address === JELLY.address ||
          pool.token1Address === JELLY.address)
      )
        return [];

      return ctx.prisma.analytics
        .findMany({
          select: selectPrice,
          where: { poolAddress },
          orderBy: { date: "desc" },
          take: take * TICKS_PER_DAY,
        })
        .then((prices) => {
          const res: Price[] = [];

          // if take is 1 day, we want 24 points per day (24 total)
          // if take is 7 days, we want 4 points per day (28 total)
          // if take is 30 days, we want 1 point per day (30 total)
          const threshold =
            take === 1
              ? TICKS_PER_DAY / 24
              : take === 7
                ? (7 * TICKS_PER_DAY) / 28
                : (30 * TICKS_PER_DAY) / 30;

          let date = prices[0].date;
          prices.forEach((price, i) => {
            if (i % threshold !== threshold - 1) return;
            const slice = prices.slice(i + 1 - threshold, i + 1);
            res.push({
              ...price,
              close: res.length > 0 ? res[res.length - 1].open : price.open,
              high: Math.max(...slice.map((p) => p.high)),
              low: Math.min(...slice.map((p) => p.low)),
              date,
            });
            date = price.date;
            return;
          });

          return res.reverse();
        })
        .catch((err): Price[] => {
          logger.error(err);
          return [];
        });
    }),
  // pool combined price chart
  getCombinedPrice: procedure
    .input(
      z.object({
        poolAddresses: z.array(addressSchema).min(1).max(MAX_HOPS),
        take: z.union([z.literal(1), z.literal(7), z.literal(30)]),
      })
    )
    .query(async ({ input, ctx }) => {
      const { take } = input;
      // duplicates would multiply the number of rows loaded without adding data
      const poolAddresses = [...new Set(input.poolAddresses)];
      const hops = poolAddresses.length;
      const pools = await ctx.prisma.pool.findMany({
        where: { address: { in: poolAddresses } },
      });
      if (
        pools.some(
          (p) =>
            p.token0Address === JELLY.address ||
            p.token1Address === JELLY.address
        )
      )
        return [];

      return ctx.prisma.analytics
        .findMany({
          select: { ...selectPrice, volume: true, poolAddress: true },
          where: { poolAddress: { in: poolAddresses } },
          orderBy: { date: "desc" },
          take: take * TICKS_PER_DAY * hops,
        })
        .then((prices) => {
          const res: Price[] = [];

          // if take is 1 day, we want 24 points per day (24 total)
          // if take is 7 days, we want 4 points per day (28 total)
          // if take is 30 days, we want 1 point per day (30 total)
          const threshold =
            (take === 1
              ? TICKS_PER_DAY / 24
              : take === 7
                ? (7 * TICKS_PER_DAY) / 28
                : (30 * TICKS_PER_DAY) / 30) * hops;

          // combine n and n+1 price points into a single point

          let date = prices[0].date;
          prices.forEach((price, i) => {
            if (i % threshold !== threshold - 1) return;
            const slice = prices.slice(i + 1 - threshold, i + 1);

            // normalize prices
            const norm = normalize(slice, hops);

            const open = norm[0].open;
            const close =
              res.length > 0 ? res[res.length - 1].open : norm[0].open;
            const high = Math.max(...norm.map((p) => p.high));
            const low = Math.min(...norm.map((p) => p.low));
            res.push({ ...price, open, close, high, low, date });
            date = price.date;
            return;
          });

          return res.reverse();
        })
        .catch((err): Price[] => {
          logger.error(err);
          return [];
        });
    }),
  // all DCAs
  getAllDCAs: t.procedure
    .input(z.object({ take: z.number().int().min(1).max(500).default(100) }))
    .query(async ({ input, ctx }) => {
      const { take } = input;
      return ctx.prisma.dCA
        .findMany({
          include: { execution: true },
          orderBy: { startTime: "desc" },
          take,
        })
        .catch((err) => {
          logger.error(err);
          return [];
        });
    }),
  // user DCAs
  getDCAs: t.procedure
    .input(z.object({ userAddress: addressSchema }))
    .query(async ({ input, ctx }) => {
      const { userAddress } = input;
      return ctx.prisma.dCA
        .findMany({
          where: { userAddress },
          include: { execution: true },
        })
        .catch((err) => {
          logger.error(err);
          return [];
        });
    }),
  // user orders
  getOrders: t.procedure
    .input(z.object({ userAddress: addressSchema }))
    .query(async ({ input, ctx }) => {
      const { userAddress } = input;
      return ctx.prisma.order
        .findMany({
          where: { userAddress },
          include: { orderExecution: true },
        })
        .catch((err) => {
          logger.error(err);
          return [];
        });
    }),
  // global volume defillama
  getVolumeDefiLlama: procedure
    .input(z.object({ take: z.number() }))
    .output(
      z.object({
        dailyVolume: z.any(),
        totalVolume: z.any(),
      })
    )
    .meta({ openapi: { method: "GET", path: "/volume" } })
    .query(async ({ input }) => {
      const take = input.take * 1000;

      const daily = await getVolumeFeesDefiLlama(take);
      const total = await getVolumeFeesDefiLlama();

      return { dailyVolume: daily, totalVolume: total };
    }),
  // global volume (whitelisted pools)
  getGlobalVolume: procedure
    .input(z.object({ take: DayWindow }))
    .query(async ({ input, ctx }) => {
      const { take } = input;
      return ctx.prisma.dailyAnalytics
        .groupBy({
          by: ["date"],
          where: {
            date: { gt: new Date(Date.now() - ONE_DAY * take) },
            poolAddress: { in: await getWhitelistedPools() },
          },
          _sum: { volume: true },
          orderBy: { date: "asc" },
        })
        .then((res) =>
          res.map((r) => ({
            date: r.date,
            volume: r._sum.volume || 0,
          }))
        );
    }),
  // 24h rolling global volume (whitelisted pools)
  get24hRollingGlobalVolume: t.procedure
    .input(z.object({}).optional())
    .query(async ({ input, ctx }) => {
      return ctx.prisma.analytics
        .groupBy({
          by: ["date"],
          where: {
            date: {
              gt: new Date(Date.now() - ONE_DAY * 1),
            },
            poolAddress: { in: await getWhitelistedPools() },
          },
          _sum: { volume: true },
          orderBy: { date: "asc" },
        })
        .then((res) => res.reduce((acc, r) => acc + (r._sum.volume || 0), 0));
    }),
  // global TVL (whitelisted pools)
  getGlobalTVL: procedure
    .input(z.object({ take: DayWindow }))
    .query(async ({ input, ctx }) => {
      const { take } = input;
      return ctx.prisma.dailyAnalytics
        .groupBy({
          by: ["date"],
          where: {
            date: { gt: new Date(Date.now() - ONE_DAY * take) },
            poolAddress: { in: await getWhitelistedPools() },
          },
          _sum: { usdLocked: true },
          orderBy: { date: "asc" },
        })
        .then((res) =>
          res.map((r) => ({
            date: r.date,
            usdLocked: r._sum.usdLocked || 0,
          }))
        );
    }),
  // dashboard (not public)
  getDashboard: procedure
    .input(z.object({}).optional())
    .query(async ({ ctx }) => {
      const day = Date.now() - ONE_DAY;
      const week = Date.now() - ONE_WEEK;

      // WALLETS
      const totalWallets = await getActiveUsers();
      const weeklyWallets = await getActiveUsers(week);
      const dailyWallets = await getActiveUsers(day);

      // VOLUME/FEES
      const total = await getVolumeFees();
      const weekly = await getVolumeFees(week);
      const daily = await getVolumeFees(day);

      // TVL
      const tvl = await getTotalTVL();
      const athTVL = await ctx.prisma.dailyAnalytics
        .groupBy({
          by: ["date"],
          _sum: { usdLocked: true },
          orderBy: { _sum: { usdLocked: "desc" } },
          take: 1,
        })
        .then((res) => res[0]._sum.usdLocked || 0);

      // RECENT TXS
      const include: Prisma.SwapFindManyArgs["include"] = {
        pool: { include: { token0: true, token1: true } },
      } as const;
      const orderBy: Prisma.SwapOrderByWithRelationInput[] = [
        { timestamp: "desc" },
        { indexInSlot: "desc" },
      ];
      const args = { include, orderBy, take: 10 };
      const recentSwaps = await ctx.prisma.swap.findMany(args);
      const recentLiq = await ctx.prisma.liquidity.findMany(args);

      return {
        total: {
          ...total,
          wallets: totalWallets,
          tvl,
          athTVL,
        },
        weekly: {
          ...weekly,
          wallets: weeklyWallets,
        },
        daily: {
          ...daily,
          wallets: dailyWallets,
        },
        recentSwaps,
        recentLiq,
      };
    }),
  // weekly DUSA emissions
  getEmissions: procedure
    .input(
      z.object({
        poolAddress: z.string(),
        epoch: z.number(),
        // date: z.string().transform((v) => new Date(v)),
      })
    )
    .query(async ({ ctx, input }) => {
      const { poolAddress, epoch } = input;
      const totalEmissions = await ctx.prisma.emissions.findFirst({
        where: { poolAddress, epoch },
      });
      return totalEmissions?.amount || 0;
    }),
  // 2024 user recaps
  get2024Wrapped: procedure.input(z.string()).query(async ({ ctx, input }) => {
    const userAddress = input;
    const include = {
      pool: { include: { token0: true, token1: true } },
    };
    const gte = new Date(2025, 0, 1);
    const where = { userAddress, timestamp: { gte } };
    const opts = { include, where };
    const _swaps = ctx.prisma.swap.findMany({
      ...opts,
    });
    const _liq = ctx.prisma.liquidity.findMany({
      ...opts,
    });
    const _maker = ctx.prisma.maker.findMany({
      where: { address: userAddress, date: { gte } },
    });
    const _rewards = ctx.prisma.rewards.groupBy({
      by: ["userAddress"],
      _sum: { makerRewardsWithStreak: true },
      where: { userAddress, rewardEpoch: { gte: 25 } },
    });
    const _ref = ctx.prisma.user.findUnique({
      include: { referred: true },
      where: { address: userAddress },
    });
    const [swaps, liq, maker, ref, rewards] = await Promise.all([
      _swaps,
      _liq,
      _maker,
      _ref,
      _rewards,
    ]);

    // swaps.forEach((s) => console.log(printOp(s, s.pool)));

    const volume = swaps.reduce((acc, curr) => acc + curr.usdValue, 0);
    const allPools = new Set(swaps.map((s) => s.pool));
    const volumeByPool = swaps.reduce(
      (acc, curr) => {
        acc[curr.poolAddress] = (acc[curr.poolAddress] || 0) + curr.usdValue;
        return acc;
      },
      {} as Record<string, number>
    );
    const favPoolAddress = Object.entries(volumeByPool).reduce(
      (acc, curr) => (curr[1] > acc[1] ? curr : acc),
      ["", 0]
    )[0];
    const favPool = Array.from(allPools).find(
      (p) => p.address === favPoolAddress
    );
    const fees = maker.reduce((acc, curr) => acc + curr.accruedFeesUsd, 0);
    const nbTxs = new Set(swaps.map((s) => s.txHash)).size + liq.length;
    const masRewards = rewards.length
      ? rewards[0]._sum.makerRewardsWithStreak || 0
      : 0;

    // daily streak (go through all swaps and liquidity txs)
    let biggestStreak = 0;
    const txs = [...swaps, ...liq].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime()
    );
    let streak = txs.length ? 1 : 0;
    let lastDate = getDailyTick(txs[0]?.timestamp).getTime();
    for (const tx of txs) {
      const sameDay = getDailyTick(tx.timestamp).getTime() === lastDate;
      const nextDay =
        getDailyTick(tx.timestamp).getTime() === lastDate + ONE_DAY;
      // console.log(lastDate, streak, biggestStreak, sameDay, nextDay);

      if (!sameDay && !nextDay) streak = 1;
      if (nextDay) {
        streak++;
        biggestStreak = Math.max(biggestStreak, streak);
        lastDate = getDailyTick(tx.timestamp).getTime();
      }
    }

    return {
      volume,
      favPool,
      fees,
      masRewards,
      nbTxs,
      biggestStreak,
      ref,
    };
  }),
  // 2024 user recaps
  get2024WrappedGlobal: procedure
    .input(z.object({}).optional())
    .query(async ({ ctx }) => {
      const gte = new Date(2025, 0, 1);
      const _swaps = ctx.prisma.swap.groupBy({
        by: ["userAddress"],
        _sum: { usdValue: true },
        orderBy: { _sum: { usdValue: "desc" } },
        where: { timestamp: { gte } },
      });
      const _maker = ctx.prisma.maker.groupBy({
        by: ["address"],
        _sum: { accruedFeesUsd: true },
        orderBy: { _sum: { accruedFeesUsd: "desc" } },
        where: { date: { gte } },
      });

      const [swaps, maker] = await Promise.all([_swaps, _maker]);

      function normalizeToPercentileBins(users: any[], key: string): number[] {
        // Calculate the size of each bin
        const binSize = Math.ceil(users.length / 100);

        // Create bins and calculate the representative value (e.g., average) for each bin
        const bins: number[] = [];
        for (let i = 0; i < 100; i++) {
          const start = i * binSize;
          const end = Math.min(start + binSize, users.length);
          const bin = users.slice(start, end);

          // Calculate the average value for the bin
          const binAverage =
            bin.reduce((sum, user) => sum + user["_sum"][key], 0) / bin.length;
          bins.push(binAverage);
        }

        return bins;
      }

      const normalizedFees = normalizeToPercentileBins(maker, "accruedFeesUsd");
      const normalizedVolume = normalizeToPercentileBins(swaps, "usdValue");

      // console.log("normalizedFees", normalizedFees);
      // console.log("normalizedVolume", normalizedVolume);

      return { volume: normalizedVolume, fees: normalizedFees };
    }),
  // @notice: unused (infer type purpose)
  getToken: procedure
    .input(z.object({ address: addressSchema }))
    .query(async ({ input, ctx }) => {
      return ctx.prisma.token.findUniqueOrThrow({
        // where: { address: input.address },
        where: { ...input },
      });
    }),
  // token value (in USD) based on pools state
  getTokenValue: procedure
    .meta({ openapi: { method: "GET", path: "/token-value" } })
    .input(z.object({ tokenAddress: addressSchema, tokenDecimals: z.number() }))
    .output(z.number())
    .query(async ({ input }) => {
      const { tokenAddress, tokenDecimals } = input;
      if (!tokenAddress || !TOKENS.includes(tokenAddress)) return 0;
      const token = toToken({ address: tokenAddress, decimals: tokenDecimals });
      return getTokenValue(token, (2.5 * ONE_MINUTE) / 1000).catch((err) => {
        logger.warn(
          `Failed to fetch token value for ${tokenAddress}: ` +
            JSON.stringify(err)
        );
        return 0;
      });
    }),
  // token value (in USD) based on coingecko API
  getCGTokenValue: procedure
    .meta({
      openapi: {
        method: "GET",
        path: "/cg-token-value",
        description:
          "Tokens value (in USD) based on coingecko API. `tokenAddresses` is an array of CA separated by a comma",
      },
    })
    .input(z.object({ tokenAddresses: addressSchema }))
    .output(z.array(z.number()))
    .query(async ({ input: { tokenAddresses } }) => {
      const tokens = tokenAddresses.split(",");
      return fetchTokenValue(tokens);
    }),
  // pool maker leaderboard
  getLeaderboard: procedure
    .input(
      z.object({
        from: z.string().transform((v) => new Date(v)),
        to: z.string().transform((v) => new Date(v)),
        poolAddress: addressSchema,
        take: z.number().min(1).max(100),
        skip: z.number().min(0).default(0),
      })
    )
    .query(async ({ input, ctx }) => {
      const { poolAddress, from, to, take, skip } = input;
      // const take = (limit || 20) + 1; // get an extra item at the end which we'll use as next cursor
      return ctx.prisma.$queryRaw<Leaderboard[]>`
        SELECT
            address,
            SUM(accruedFeesUsdEffective) as accruedFeesUsd,
            SUM(volume) as volume,
            CASE
                WHEN (SELECT SUM(accruedFeesUsdEffective) FROM Maker WHERE poolAddress = ${poolAddress} AND date BETWEEN ${from} AND ${to}) != 0
                THEN (
                  POWER(SUM(accruedFeesUsdEffective), ${FEE_WEIGHT}) /
                  (SELECT SUM(accruedFeesUsdWeighted) AS totalAccruedFeesUsdWeighted
                  FROM (
                      SELECT
                          SUM(accruedFeesUsdEffective) AS accruedFeesUsd,
                          POWER(SUM(accruedFeesUsdEffective), ${FEE_WEIGHT}) AS accruedFeesUsdWeighted
                      FROM
                          Maker
                      WHERE
                          poolAddress = ${poolAddress} AND date BETWEEN ${from} AND ${to}
                      GROUP BY address
                  ) AS subquery)
                ) * 100
                ELSE 0
            END as feesPct
        FROM Maker
        WHERE poolAddress = ${poolAddress}
        AND date BETWEEN ${from} AND ${to}
        GROUP BY address
        ORDER BY volume DESC
        LIMIT ${take}
        OFFSET ${skip};
      `.catch((err): Leaderboard[] => {
        logger.error(err);
        return [];
      });
      // TODO: pagination
      // ctx.prisma.swap.findMany({ cursor: { myCursor } });
      // let nextCursor: typeof cursor | undefined = undefined;
      // if (items.length > limit) {
      //   const nextItem = items.pop();
      //   nextCursor = nextItem!.myCursor;
      // }
    }),
  // user rewards for a pool/period
  getUserRewards: procedure
    .input(
      z.object({
        epoch: z.number(),
        poolAddress: addressSchema,
        userAddress: addressSchema,
      })
    )
    .query(async ({ input, ctx }) => {
      const { poolAddress, epoch, userAddress } = input;
      const res = await ctx.prisma.rewards.findUnique({
        where: {
          userAddress_rewardEpoch_poolAddress: {
            poolAddress,
            userAddress,
            rewardEpoch: epoch,
          },
        },
      });
      return res;
    }),
  getUserRewardsDetails: procedure
    .input(
      z.object({
        address: addressSchema,
      })
    )
    .query(async ({ input, ctx }) => {
      const { address } = input;
      const res = await ctx.prisma.rewards.findMany({
        where: {
          userAddress: address,
        },
        orderBy: { rewardEpoch: "desc" },
      });

      return res;
    }),
  // pool user fee % (reward prediction)
  getUserfeesPct: procedure
    .input(
      z.object({
        from: z.string().transform((v) => new Date(v)),
        to: z.string().transform((v) => new Date(v)),
        poolAddress: addressSchema,
        address: addressSchema,
      })
    )
    .query(async ({ input, ctx }) => {
      const { poolAddress, from, to, address } = input;

      return ctx.prisma.$queryRaw<{ feesPct: number }[]>`
        SELECT
            CASE
                WHEN (SELECT SUM(accruedFeesUsdEffective) FROM Maker WHERE poolAddress = ${poolAddress} AND date BETWEEN ${from} AND ${to}) != 0
                THEN (POWER(SUM(accruedFeesUsdEffective), ${FEE_WEIGHT}) /
                (SELECT SUM(accruedFeesUsdWeighted) AS totalAccruedFeesUsdWeighted
                  FROM (
                      SELECT
                          SUM(accruedFeesUsdEffective) AS accruedFeesUsd,
                          POWER(SUM(accruedFeesUsdEffective), ${FEE_WEIGHT}) AS accruedFeesUsdWeighted
                      FROM
                          Maker
                      WHERE
                          poolAddress = ${poolAddress} AND date BETWEEN ${from} AND ${to}
                      GROUP BY address
                  ) AS subquery)
                ) * 100
                ELSE 0
            END as feesPct
        FROM Maker
        WHERE poolAddress = ${poolAddress}
        AND address = ${address}
        AND date BETWEEN ${from} AND ${to};
      `.then((res) => res[0].feesPct);
    }),
  // user streak
  getStreak: procedure
    .input(z.object({ poolAddress: addressSchema, address: addressSchema }))
    .query(async ({ input, ctx }) => {
      const { poolAddress, address } = input;
      const res = await ctx.prisma.maker.findMany({
        where: { address, poolAddress },
        orderBy: { date: "desc" },
      });

      const timestamps = res
        .filter((r) => r.accruedFeesUsdEffective > 0)
        .map((r) => r.date);

      return {
        streak: calculateWeeklyStreak(timestamps),
        lastDate: res[0]?.date,
      };
    }),
  // pool reward data
  getRewardPool: procedure
    .input(z.object({ epoch: z.number(), poolAddress: addressSchema }))
    .query(async ({ input, ctx }) => {
      const { epoch, poolAddress } = input;
      const res = await ctx.prisma.rewardPool.findUnique({
        where: { poolAddress_epoch: { epoch, poolAddress } },
        include: { rewardTokens: { include: { token: true } } },
      });
      if (!res) return null;

      // TODO: fetch this in the UI?
      const rewardTokensWithValue = await Promise.all(
        res.rewardTokens.map(async (rewardToken) => ({
          ...rewardToken,
          dollarValue: await getTokenValue(toToken(rewardToken.token)),
        }))
      );

      return {
        ...res,
        rewardTokens: rewardTokensWithValue,
      };
    }),
  // governance
  getDelegatees: procedure
    .input(
      z
        .object({
          take: z.number().min(1).max(100).default(20),
          skip: z.number().min(0).default(0),
        })
        .optional()
    )
    .query(async ({ input }) => {
      // 1. Setup
      const take = input?.take || 20;
      const skip = input?.skip || 0;

      const res = await getDelegatees();
      return res.slice(skip, skip + take);
    }),
  // address-discord bind
  registerDiscord: procedure
    .input(
      z.object({
        userAddress: addressSchema,
        discordId: discordIdSchema,
        publicKey: z.string(),
        signature: z.string(),
        accessToken: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { publicKey, signature, discordId, userAddress, accessToken } =
        input;

      if (!isKeyOfAddress(publicKey, userAddress))
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Public key does not match address",
        });
      if ((await getDiscordIdFromToken(accessToken)) !== discordId)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Discord account could not be verified",
        });

      const isValid = await PublicKey.fromString(publicKey).verify(
        discordId,
        Signature.fromString(signature)
      );

      const discordIdExists = await ctx.prisma.user.findFirst({
        where: { discordId },
      });
      if (discordIdExists)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "DiscordId already registered",
        });

      const user = await ctx.prisma.user.findUnique({
        where: { address: userAddress },
      });
      if (user?.discordId)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "User already registered",
        });

      if (isValid) {
        await ctx.prisma.user.upsert({
          where: { address: userAddress },
          create: { discordId, address: userAddress },
          update: { discordId },
        });
      }

      return isValid;
    }),
  // discord binded to user
  // no cache
  getDiscordId: t.procedure
    .input(z.object({ userAddress: addressSchema }))
    .query(async ({ input, ctx }) => {
      const { userAddress } = input;

      const user = await ctx.prisma.user.findUnique({
        where: { address: userAddress },
        select: { discordId: true },
      });
      return user?.discordId;
    }),
  getDiscordUser: t.procedure
    .input(z.object({ discordId: discordIdSchema }))
    .query(async ({ input }) => {
      const { discordId } = input;
      return await getUser(discordId);
    }),
  getDiscordRoles: t.procedure
    .input(z.object({ discordId: discordIdSchema }))
    .query(async ({ input }) => {
      const { discordId } = input;
      return await getRoles(discordId);
    }),

  // points leaderboard
  getGlobalLeaderboard: procedure
    .input(
      z.object({
        take: z.number().min(1).max(100).default(50),
        skip: z.number().min(0).default(0),
      })
    )
    .query(async ({ input, ctx }) => {
      const { take, skip } = input;

      // Rank users by total points in SQL and only load the rows of the requested page
      // (loading the whole Points table on every cache miss is a DoS vector).
      const page = await ctx.prisma.points.groupBy({
        by: ["userAddress"],
        _sum: { points: true },
        orderBy: { _sum: { points: "desc" } },
        skip,
        take,
      });
      const rows = await ctx.prisma.points.findMany({
        where: { userAddress: { in: page.map((p) => p.userAddress) } },
        orderBy: { points: "desc" },
      });

      return page.map(({ userAddress }) => {
        const pointsByDate = rows
          .filter((r) => r.userAddress === userAddress)
          .map((r) => ({
            userAddress: r.userAddress,
            points: r.points,
            date: r.date,
          }));
        const totalPoints = pointsByDate.reduce((sum, r) => sum + r.points, 0);
        return { userAddress, pointsByDate, totalPoints };
      });
    }),
  // users in leaderboard
  getGlobalLeaderboardLength: procedure
    .input(z.object({}).optional())
    .query(async ({ ctx }) => {
      return ctx.prisma.points
        .groupBy({ by: ["userAddress"], _count: { userAddress: true } })
        .then((res) => res.length);
    }),
  // points leaderboard user score/rank
  getGlobalLeaderboardUser: procedure
    .input(z.object({ address: addressSchema }))
    .query(async ({ input, ctx }) => {
      const { address } = input;
      return ctx.prisma.$queryRaw<UserLeaderboard[]>`
      SELECT
        userAddress,
        score,
        userRank
      FROM (
          SELECT
              userAddress,
              SUM(points) AS score,
              RANK() OVER (ORDER BY SUM(points) DESC) AS userRank
          FROM
              Points
          GROUP BY
              userAddress
      ) AS ranked_users
      WHERE userAddress = ${address};`.then((res) =>
        res.length ? res[0] : null
      );
    }),
  // points leaderboard user details
  getGlobalLeaderboardUserDetails: procedure
    .input(z.object({ address: addressSchema }))
    .query(async ({ input, ctx }) => {
      const { address } = input;
      return ctx.prisma.points.findMany({
        where: { userAddress: address },
        orderBy: { date: "desc" },
      });

      // // fill res with void data on missing weeks
      // const res: Points[] = [];
      // let lastFriday = getDailyTick().getTime();
      // while (new Date(lastFriday).getDay() !== 5) {
      //   lastFriday = lastFriday - ONE_DAY;
      // }
      // const weeks = new Set(ress.map((r) => r.date.getTime()));
      // for (let date = lastFriday; date > launchTimestamp; date -= ONE_WEEK) {
      //   if (weeks.has(date))
      //     res.push(ress.find((r) => r.date.getTime() === date)!);
      //   else
      //     res.push({
      //       date: new Date(date),
      //       userAddress: address,
      //       discordScore: 0,
      //       referralScore: 0,
      //       totalScore: 0,
      //       makerScore: 0,
      //       swapScore: 0,
      //       points: 0,
      //     });
      // }

      // return res;
    }),
  // points leaderboard user details
  getGlobalLeaderboardWeeklyTotals: procedure
    .input(z.object({}).optional())
    .query(async ({ ctx }) => {
      return ctx.prisma.points.groupBy({
        by: ["date"],
        _sum: { totalScore: true },
        orderBy: { date: "desc" },
      });
    }),
  // enter referral code
  beReferred: procedure
    .input(
      z.object({
        userAddress: addressSchema,
        code: z.string(),
        signature: z.string(),
        publicKey: z.string(),
      })
    )
    .mutation(async ({ input, ctx }) => {
      const { userAddress, code, signature, publicKey } = input;

      if (!isKeyOfAddress(publicKey, userAddress))
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Public key does not match address",
        });

      const isValid = await PublicKey.fromString(publicKey).verify(
        code,
        Signature.fromString(signature)
      );
      if (!isValid)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "Invalid signature",
        });

      const referrer = await ctx.prisma.user.findUnique({
        where: { referralCode: code },
      });
      if (!referrer)
        throw new TRPCError({ code: "FORBIDDEN", message: "Code not found" });
      if (referrer.address === userAddress)
        throw new TRPCError({
          code: "FORBIDDEN",
          message: "You can't refer yourself",
        });

      await ctx.prisma.referral.create({
        data: { userAddress: userAddress, godfatherAddress: referrer.address },
      });
      return true;
    }),
  // user referral code
  // no cache
  getCode: t.procedure
    .input(z.object({ userAddress: addressSchema }))
    .query(async ({ input, ctx }) => {
      const { userAddress } = input;
      const user = await ctx.prisma.user.findUnique({
        where: { address: userAddress },
        select: { referralCode: true, swapTxs: { select: { usdValue: true } } },
      });
      if (user?.referralCode) return user.referralCode;

      const totalVolume =
        user?.swapTxs.reduce((acc, curr) => acc + curr.usdValue, 0) || 0;
      if (totalVolume < 1000) return totalVolume;

      let referralCode = "";
      let alreadyExists = true;
      while (alreadyExists) {
        referralCode = Math.random().toString(36).substring(2, 8);
        alreadyExists = await ctx.prisma.user
          .count({ where: { referralCode } })
          .then((count) => count > 0);
      }

      await ctx.prisma.user.update({
        where: { address: userAddress },
        data: { referralCode },
      });

      return referralCode;
    }),
  // user referrals
  // no cache
  getStats: t.procedure
    .input(z.object({ userAddress: addressSchema }))
    .query(async ({ input, ctx }) => {
      const { userAddress } = input;
      const user = await ctx.prisma.user.findUnique({
        where: { address: userAddress },
        select: { referralCode: true, _count: { select: { referred: true } } },
      });

      return {
        referred: user?._count.referred || 0,
      };
    }),
  // user referrer
  // no cache
  getGodfather: t.procedure
    .input(z.object({ userAddress: addressSchema }))
    .query(async ({ input, ctx }) => {
      const { userAddress } = input;
      return ctx.prisma.referral
        .findUnique({
          where: { userAddress },
          select: { godfather: true },
        })
        .then((r) => r?.godfather.address || "");
    }),
  getPointsAPR: procedure
    .input(z.object({}).optional())
    .query(async ({ ctx }) => {
      let date = getDailyTick().getTime();
      while (new Date(date).getDay() !== 5) {
        date = date - ONE_DAY;
      }

      const lastMetrics = await getVolumeFees(date - ONE_WEEK, date);
      const currentMetrics = await getVolumeFees(date);

      const lastAvgTVL = await getAvgTVL(date - ONE_WEEK, date);
      const currentAvgTVL = await getAvgTVL(date);

      const res = await ctx.prisma.points.groupBy({
        by: ["date"],
        _sum: {
          makerScore: true,
          swapScore: true,
          totalScore: true,
          points: true,
        },
        orderBy: { date: "desc" },
        take: 1,
      });
      if (res.length === 0) return null;

      const row = res[0];
      const totalScore = row._sum.totalScore || 1;

      return {
        lastMetrics,
        lastAvgTVL,
        currentMetrics,
        currentAvgTVL,
        date: row.date,
        makerPerc: (row._sum.makerScore || 0) / totalScore,
        swapPerc: (row._sum.swapScore || 0) / totalScore,
        points: row._sum.points || 0,
      };
    }),
  getPointsAPR2: procedure
    .input(z.object({ poolAddress: addressSchema }))
    .query(async ({ ctx, input }) => {
      const address = input.poolAddress;
      // console.time("getPointsAPR2");

      // set date to last friday
      let date = getDailyTick().getTime();
      while (new Date(date).getDay() !== 5) {
        date = date - ONE_DAY;
      }
      const from = date - ONE_WEEK;

      // TODO: handle missing points data

      const lastMetrics = await getPoolVolumeFees(address, from, date);
      // const currentMetrics = await getPoolVolumeFees(address, date);
      const lastMetricsGlobal = await getVolumeFees(date - ONE_WEEK, date);
      // const currentMetricsGlobal = await getVolumeFees(date);

      // const volumePct = lastMetrics.volume / lastMetricsGlobal.volume;
      const feesPct = lastMetrics.fees / lastMetricsGlobal.fees;

      const lastAvgTVL = await getPoolAvgTVL(address, from, date);
      // const currentAvgTVL = await getPoolAvgTVL(address, date);

      const res = await ctx.prisma.points.groupBy({
        by: ["date"],
        _sum: {
          makerScore: true,
          totalScore: true,
          points: true,
        },
        orderBy: { date: "desc" },
        take: 1,
      });
      if (res.length === 0) return null;

      const row = res[0];
      const totalScore = row._sum.totalScore || 1;
      const makerPct = (row._sum.makerScore || 0) / totalScore;

      const pointsDistributed = WEEKLY_POINTS * makerPct * feesPct;

      // console.timeEnd("getPointsAPR2");
      return {
        lastAvgTVL,
        pointsDistributed,
        date: row.date,
      };
    }),
  getPointsAPR2Batch: procedure
    .input(
      z.object({
        poolAddresses: z.array(addressSchema).max(MAX_ARRAY_INPUT).optional(),
      })
    )
    .query(async ({ ctx, input }) => {
      // console.time("getPointsAPR2Batch");
      const addresses = input.poolAddresses;

      // set date to last friday
      // TODO: handle missing points data
      let date = getDailyTick().getTime();
      while (new Date(date).getDay() !== 5) {
        date = date - ONE_DAY;
      }
      const from = date - ONE_WEEK;
      const to = date;
      console.log(new Date(from), new Date(date));

      // console.time("getVolumeFeesByPool");
      // const lastMetricsByPool = await getVolumeFeesByPool(from, date);
      // console.timeEnd("getVolumeFeesByPool");
      // // const currentMetrics = await getPoolVolumeFees(address, date);
      // console.time("getVolumeFees");
      // const lastMetricsGlobal = await getVolumeFees(date - ONE_WEEK, date);
      // console.timeEnd("getVolumeFees");
      // // const currentMetricsGlobal = await getVolumeFees(date);

      // console.time("getAvgTVLByPool");
      // const lastAvgTVLByPool = await getAvgTVLByPool(from, date);
      // console.timeEnd("getAvgTVLByPool");
      // // const currentAvgTVL = await getPoolAvgTVL(address, date);

      // console.time("prisma");
      // const pointsRes = await ctx.prisma.points.groupBy({
      //   by: ["date"],
      //   _sum: {
      //     makerScore: true,
      //     totalScore: true,
      //     points: true,
      //   },
      //   orderBy: { date: "desc" },
      //   take: 1,
      // });
      // console.timeEnd("prisma");

      const lastMetricsByPoolProm = getVolumeFeesByPool(from, to);
      // const currentMetricsProm = getPoolVolumeFees(address, to);
      const lastMetricsGlobalProm = getVolumeFees(from, to);
      // const currentMetricsGlobalProm = getVolumeFees(to);

      const lastAvgTVLByPoolProm = getAvgTVLByPool(from, to);
      // const currentAvgTVLProm = getPoolAvgTVL(address, to);

      const pointsResProm = ctx.prisma.points.groupBy({
        by: ["date"],
        _sum: { makerScore: true, totalScore: true },
        orderBy: { date: "desc" },
        take: 1,
      });

      const [
        lastMetricsByPool,
        lastMetricsGlobal,
        lastAvgTVLByPool,
        pointsRes,
      ] = await Promise.all([
        lastMetricsByPoolProm,
        lastMetricsGlobalProm,
        lastAvgTVLByPoolProm,
        pointsResProm,
      ]);

      if (pointsRes.length === 0) return null;

      const row = pointsRes[0];
      const totalScore = row._sum.totalScore || 1;
      const makerPct = (row._sum.makerScore || 0) / totalScore;

      const whitelistedPools = await getWhitelistedPools();
      const xxx = whitelistedPools.map((address, i) => {
        const lastMetrics = lastMetricsByPool.find(
          (m) => m.poolAddress === address
        );
        const feesPct = (lastMetrics?._sum.fees || 0) / lastMetricsGlobal.fees;
        const lastAvgTVL = lastAvgTVLByPool.find(
          (m) => m.poolAddress === address
        );
        const pointsDistributed = WEEKLY_POINTS * makerPct * feesPct;

        return {
          poolAddress: address,
          lastAvgTVL,
          pointsDistributed,
          date: row.date,
        };
      });
      // console.timeEnd("getPointsAPR2Batch");
      return xxx;
    }),

  getEpochFees: procedure
    .input(
      z.object({
        // epoch: z.number(),
        poolAddress: addressSchema,
        from: z.string().transform((v) => new Date(v)),
        to: z.string().transform((v) => new Date(v)),
      })
    )
    .query(async ({ input, ctx }) => {
      const { poolAddress } = input;
      const res = await ctx.prisma.dailyAnalytics.findMany({
        where: { poolAddress, date: { gte: input.from, lt: input.to } },
      });
      return res;
    }),
  getEpochFeesBatch: procedure
    .input(
      z.object({
        epoch: z.number(),
        poolAddresses: z.array(addressSchema).max(MAX_ARRAY_INPUT),
      })
    )
    .query(async ({ input, ctx }) => {
      const { poolAddresses, epoch } = input;
      const res = await ctx.prisma.protocolFees.findMany({
        where: { epoch, poolAddress: { in: poolAddresses } },
      });
      return res.sort(
        (a, b) =>
          poolAddresses.indexOf(a.poolAddress) -
          poolAddresses.indexOf(b.poolAddress)
      );
    }),

  // user distribution info (staking rewards, etc.)
  getUserDistributions: procedure
    .input(z.object({ userAddress: addressSchema }))
    .output(
      z.array(
        z.object({
          id: z.number(),
          userAddress: z.string(),
          token: z.string(),
          amount: z.string(),
          txHash: z.string().nullable(),
          sentAt: z.date(),
          rewardEpoch: z.number(),
        })
      )
    )
    .meta({ openapi: { method: "GET", path: "/distributions" } })
    .query(async ({ input, ctx }) => {
      const { userAddress } = input;
      return ctx.prisma.distribution.findMany({
        where: { userAddress },
        orderBy: { sentAt: "desc" },
      });
    }),
  // getGlobalEpochFees: procedure
  //   .input(
  //     z.object({
  //       from: z.string().transform((v) => new Date(v)),
  //       to: z.string().transform((v) => new Date(v)),
  //     })
  //   )
  //   .query(async ({ input, ctx }) => {
  //     const res = await ctx.prisma.dailyAnalytics.findMany({
  //       where: { date: { gte: input.from, lt: input.to } },
  //     });
  //     return res;
  //   }),

  // ------------
  // MASSA-TOOLS
  // ------------

  getMultisigs: procedure
    .input(z.object({ address: addressSchema }))
    .query(async ({ ctx, input }) => {
      const { address } = input;
      return ctx.prisma.multisig.findMany({
        where: { owners: { some: { address } } },
      });
    }),
  getBlock: t.procedure
    .input(z.object({ blockHash: z.string() }))
    .query(async ({ input, ctx }) => {
      const { blockHash } = input;
      return ctx.prisma.block.findUnique({
        where: { id: blockHash },
        include: { operations: true, ledgerChanges: true },
      });
    }),
  getOperation: t.procedure
    .input(z.object({ txHash: z.string() }))
    .query(async ({ input, ctx }) => {
      const { txHash } = input;
      return ctx.prisma.operation.findUnique({
        where: { id: txHash },
        include: { events: true },
      });
    }),
  getLedgerChange: procedure
    .input(z.object({ address: addressSchema, key: z.string() }))
    .query(async ({ input, ctx }) => {
      const { address, key } = input;
      return ctx.prisma.ledgerChange.findMany({
        where: { address, key191Chars: key },
      });
    }),
  // Fetch ledger entries by address and prefix
  getLedgerEntriesByPrefix: procedure
    .input(
      z.object({
        address: addressSchema,
        until: z.string().transform((v) => new Date(v)),
        // at least the start of a key name, e.g. "locked::" or "votes::"
        prefix: z.string().min(3),
        // keys returned (sorted by key); page through with `afterKey`
        take: z
          .number()
          .int()
          .min(1)
          .max(MAX_LEDGER_KEYS)
          .default(MAX_LEDGER_KEYS),
        afterKey: z.string().optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const { address, until, prefix, take, afterKey } = input;
      const where = {
        address,
        key191Chars: {
          startsWith: prefix,
          ...(afterKey ? { gt: afterKey } : {}),
        },
        createdAt: { lt: until },
      };
      // Latest snapshot date of each key, bounded in SQL. (`distinct` alone is applied
      // in memory by Prisma, after loading every matching row.)
      const latest = await ctx.prisma.ledgerChange.groupBy({
        by: ["key191Chars"],
        where,
        _max: { createdAt: true },
        orderBy: { key191Chars: "asc" },
        take,
      });
      if (!latest.length) return [];

      return ctx.prisma.ledgerChange.findMany({
        distinct: ["key191Chars"],
        orderBy: { createdAt: "desc" },
        where: {
          address,
          OR: latest.map((l) => ({
            key191Chars: l.key191Chars,
            createdAt: l._max.createdAt ?? undefined,
          })),
        },
      });
    }),
  // Fetch ledger entries by address and specific keys
  getLedgerEntriesByKeys: procedure
    .input(
      z.object({
        address: addressSchema,
        until: z.string().transform((v) => new Date(v)),
        keys: z.array(z.string()).max(MAX_LEDGER_KEYS),
        beyond: z
          .string()
          .transform((v) => new Date(v))
          .optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const { address, until, keys, beyond } = input;
      const res = await ctx.prisma.ledgerChange.findMany({
        distinct: ["key191Chars"],
        orderBy: { createdAt: "desc" },
        where: {
          address,
          key191Chars: { in: keys },
          createdAt: { lt: until, gte: beyond },
        },
      });
      const map = new Map(res.map((r) => [r.key191Chars, r]));
      return keys.map(
        (k) => map.get(k) || { address, key191Chars: k, value: null }
      );
    }),
  // Fetch single ledger entry by address and key beyond a certain date
  getLedgerEntryAfterDate: procedure
    .input(
      z.object({
        address: addressSchema,
        beyond: z.string().transform((v) => new Date(v)),
        key: z.string(),
        until: z
          .string()
          .transform((v) => new Date(v))
          .optional(),
      })
    )
    .query(async ({ input, ctx }) => {
      const { address, beyond, key, until } = input;
      return ctx.prisma.ledgerChange.findFirst({
        distinct: ["key191Chars"],
        orderBy: { createdAt: "asc" },
        where: {
          address,
          key191Chars: key,
          createdAt: { gte: beyond, lt: until },
        },
      });
    }),
  getTxs: procedure
    .input(
      z.object({
        targetAddress: addressSchema.optional(),
        callerAddress: addressSchema.optional(),
        targetFunction: z.string().optional(),
        from: z
          .string()
          .transform((v) => new Date(v))
          .optional(),
        to: z
          .string()
          .transform((v) => new Date(v))
          .optional(),
        take: z.number().max(100).default(50),
        skip: z.number().min(0).default(0),
      })
    )
    .query(async ({ input, ctx }) => {
      // prettier-ignore
      const { callerAddress, targetAddress, targetFunction, from, to, take, skip } = input;
      return ctx.prisma.operation.findMany({
        include: { events: true },
        where: {
          callerAddress,
          targetAddress,
          targetFunction: targetFunction
            ? { contains: targetFunction }
            : undefined,
          createdAt: { gte: from, lt: to },
        },
        skip,
        take,
      });
    }),
});

// A signature only proves control of `publicKey`; also require that this key is the
// one behind `userAddress`, otherwise anyone can act on behalf of any address.
const isKeyOfAddress = (publicKey: string, userAddress: string) => {
  try {
    return (
      PublicKey.fromString(publicKey).getAddress().toString() === userAddress
    );
  } catch {
    return false;
  }
};

// Ask Discord which account the OAuth access token belongs to, so a caller can only
// register a Discord ID they actually own.
const getDiscordIdFromToken = async (accessToken: string) => {
  const res = await fetch("https://discord.com/api/v10/users/@me", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) return undefined;
  const user = (await res.json()) as { id?: string };
  return user.id;
};

export const getActiveUsers = async (date?: number) => {
  const gte = date ? new Date(date) : undefined;
  const txs = { some: { timestamp: { gte } } } as const;

  return await prisma.user.count({
    where: {
      OR: [{ swapTxs: txs }, { liquidityTxs: txs }],
    },
  });
};

export const getVolumeFeesByPool = async (from?: number, to?: number) => {
  const gte = from ? new Date(from) : undefined;
  const lt = to ? new Date(to) : undefined;
  // TODO: optimize
  return prisma.analytics.groupBy({
    _sum: { volume: true, fees: true },
    by: ["poolAddress"],
    where: { date: { gte, lt } },
  });
};
export const getPoolVolumeFees = async (
  poolAddress: string,
  from?: number,
  to?: number
) => {
  const gte = from ? new Date(from) : undefined;
  const lt = to ? new Date(to) : undefined;
  return prisma.analytics
    .aggregate({
      _sum: { volume: true, fees: true },
      where: { date: { gte, lt }, poolAddress },
    })
    .then((res) => ({
      volume: res._sum.volume || 0,
      fees: round(res._sum.fees || 0),
    }));
};
export const getVolumeFees = async (from?: number, to?: number) => {
  const gte = from ? new Date(from) : undefined;
  const lt = to ? new Date(to) : undefined;
  return prisma.analytics
    .aggregate({
      _sum: { volume: true, fees: true },
      where: {
        date: { gte, lt },
        poolAddress: { in: await getWhitelistedPools() },
      },
    })
    .then((res) => ({
      volume: res._sum.volume || 0,
      fees: round(res._sum.fees || 0),
    }));
};

export const getAvgTVLByPool = async (from?: number, to?: number) => {
  const gte = from ? new Date(from) : undefined;
  const lt = to ? new Date(to) : undefined;
  return prisma.dailyAnalytics.groupBy({
    by: ["poolAddress"],
    _avg: { usdLocked: true },
    where: { date: { gte, lt } },
  });
};
export const getPoolAvgTVL = async (
  poolAddress: string,
  from?: number,
  to?: number
) => {
  const gte = from ? new Date(from) : undefined;
  const lt = to ? new Date(to) : undefined;
  return prisma.dailyAnalytics
    .aggregate({
      _avg: { usdLocked: true },
      where: { date: { gte, lt }, poolAddress },
    })
    .then((res) => res._avg.usdLocked || 0);
};
export const getAvgTVL = async (from?: number, to?: number) => {
  const gte = from ? new Date(from) : undefined;
  const lt = to ? new Date(to) : undefined;
  return prisma.dailyAnalytics
    .groupBy({
      by: ["date"],
      _avg: { usdLocked: true },
      where: {
        date: { gte, lt },
        poolAddress: { in: await getWhitelistedPools() },
      },
    })
    .then((res) =>
      res.reduce((acc, curr) => acc + (curr._avg.usdLocked || 0), 0)
    );
};

const getVolumeFeesDefiLlama = async (endTimestamp?: number) => {
  const targetDate = endTimestamp ? new Date(endTimestamp) : undefined;
  const previousDate = targetDate
    ? new Date(targetDate.getTime() - ONE_DAY)
    : undefined;

  return getVolumeFees(previousDate?.getTime(), targetDate?.getTime());
};

export const getTotalTVL = async () => {
  return prisma.dailyAnalytics
    .groupBy({
      by: ["date"],
      _sum: { usdLocked: true },
      orderBy: { date: "desc" },
      take: 1,
    })
    .then((r) => r[0]._sum.usdLocked || 0);
};

const getOperations = async (params: {
  take: number;
  skip: number;
  address: string;
}) => {
  const { take, skip, address } = params;
  const include: Prisma.SwapFindManyArgs["include"] = {
    pool: { include: { token0: true, token1: true } },
  } as const;
  const orderBy: Prisma.SwapOrderByWithRelationInput[] = [
    { timestamp: "desc" },
    { indexInSlot: "asc" },
  ];
  const opts = { include, take, orderBy, skip };
  return prisma.user
    .findUniqueOrThrow({
      include: { swapTxs: opts, liquidityTxs: opts },
      where: { address },
    })
    .catch(() => ({ liquidityTxs: [], swapTxs: [] }));
};

const getRecentSwapsTokens = async (
  input: z.infer<typeof recentSwapsTokensSchema>
) => {
  const { userAddress, token0Address, token1Address, take, skip } = input;
  const p = prisma;

  // Retrieve pools which include both token0 or token1
  const poolAddresses = await p.pool
    .findMany({
      where: {
        OR: [
          { AND: [{ token0Address, token1Address }] },
          {
            AND: [
              { token1Address: token0Address, token0Address: token1Address },
            ],
          },
        ],
      },
      select: { address: true },
    })
    .then((res) => res.map((r) => r.address));

  const _innerSwapsAll = await Promise.all(
    poolAddresses.map((poolAddress) =>
      p.swap.findMany({
        where: { poolAddress, userAddress },
        orderBy: { timestamp: "desc" },
        take,
        skip,
      })
    )
  );
  const _innerSwaps = _innerSwapsAll.flat();
  const _fullSwaps = p.fullSwap.findMany({
    where: {
      OR: [
        { tokenIn: token0Address, tokenOut: token1Address },
        { tokenIn: token1Address, tokenOut: token0Address },
      ],
      userAddress,
    },
    orderBy: { timestamp: "desc" },
    take,
    skip,
  });
  const [innerSwaps, fullSwaps] = await Promise.all([_innerSwaps, _fullSwaps]);
  const arr = [...innerSwaps, ...fullSwaps];
  const uniqueHashes = new Set(arr.map((s) => s.txHash));
  // const uniqueSwaps = new Set<Swap | FullSwap> ();
  const uniqueSwaps: (Swap | FullSwap)[] = [];

  // filter out duplicates txHash
  for (const s of arr) {
    if (uniqueHashes.has(s.txHash)) {
      uniqueSwaps.push(s);
      uniqueHashes.delete(s.txHash);
    }
  }
  return uniqueSwaps.sort(
    (a, b) => b.timestamp.getTime() - a.timestamp.getTime()
  );
};

const _getDelegatees = async () => {
  const multicall = new IMulticall(multicallSC, web3Client);
  const ve = new IBaseContract(votingEscrowSC, web3Client);

  // 2. Get the max tokenId
  const tokenId = await ve
    .extract(["tokenId"])
    .then((res) => (res[0] ? Number(U64.fromBytes(res[0])) : 0));
  if (!tokenId) return [];
  const ids = Array.from({ length: tokenId }, (_, i) => i + 1);

  // 3. Prepare multicall txs for balanceOfNFT
  const txs: Tx[] = ids.map(
    (id) =>
      new Tx(
        "balanceOfNFT",
        Uint8Array.from(new Args().addU64(BigInt(id)).serialize()),
        votingEscrowSC
      )
  );

  // 4. Prepare owner keys for datastore
  const ownerKeys = ids.map((id) => `idToOwner::${id}`);
  // 5. Fetch all owners in one call
  const ownerResults = await ve.extract(ownerKeys);
  const owners = ownerResults.map((bs) =>
    bs && bs.length ? new Args(bs).nextString() : undefined
  );

  // 6. Batch multicall for balanceOfNFT (in chunks)
  const chunkSize = 100;
  let votingPowers: bigint[] = [];
  for (let i = 0; i < txs.length; i += chunkSize) {
    const batch = txs.slice(i, i + chunkSize);
    const res = await multicall.aggregateMulticall(batch);
    const bs = new Args(res.value);
    votingPowers.push(
      ...Array.from({ length: batch.length }).map(() =>
        U256.fromBytes(bs.nextUint8Array())
      )
    );
  }

  // 7. Aggregate voting power per address
  const powerByAddress: Record<string, bigint> = {};
  ids.forEach((id, idx) => {
    const owner = owners[idx];
    const power = votingPowers[idx] || 0n;
    if (!owner || power === 0n) return;
    if (!powerByAddress[owner]) powerByAddress[owner] = 0n;
    powerByAddress[owner] += power;
  });

  // 8. Sort addresses by voting power (desc)
  const sorted = Object.entries(powerByAddress)
    .sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : 0))

    .map(([address, votingPower]) => ({
      address,
      votingPower: votingPower.toString(),
      // ids are indexes in the owners array
      ids: owners
        .map((o, i) => (o === address ? i + 1 : undefined))
        .filter((o) => o !== undefined),
    }));
  return sorted;
};
const getDelegatees = cache(_getDelegatees, { ttl: 60 * 60 }); // 1 hour

export const expressMiddleware = trpcExpress.createExpressMiddleware({
  router: appRouter,
  createContext,
  responseMeta(opts) {
    return {};
  },
  onError(opts) {
    const { error, path, input } = opts;
    logger.warn(path);
    logger.warn(error.message);
  },
});

// export type definition of API
export type AppRouter = typeof appRouter;
export type ProcedureName = keyof AppRouter["_def"]["procedures"];
