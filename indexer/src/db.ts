import {
  DCA,
  LedgerChange,
  Liquidity,
  Pool_version,
  Prisma,
  Status,
  Swap,
} from "@prisma/client";
import { handlePrismaError, prisma } from "../../common/db";
import logger from "../../common/logger";
import {
  getClosestTick,
  getDailyTick,
  getHourlyTick,
  ONE_WEEK,
} from "../../common/utils";
import { cache, toPrismaToken, toToken } from "../../common/methods";
import { EventDecoder, ILBPair, Token } from "@dusalabs/sdk";
import {
  fetchPairAddress,
  fetchTokenFromAddress,
  fetchTokenInfo,
} from "../../common/datastoreFetcher";
import { web3Client } from "../../common/client";
import { masUsdcPairV2 } from "../../common/contracts";

type Pool = {
  token0: Token;
  token1: Token;
  binStep: number;
  version: Pool_version;
};

const cocUser = (address: string) => ({
  connectOrCreate: { where: { address }, create: { address } },
});

const cocPool = (
  address: string,
  p: Pool
): Prisma.PoolCreateNestedOneWithoutSwapTxsInput => ({
  connectOrCreate: {
    where: { address },
    create: {
      address,
      token0: {
        connectOrCreate: {
          where: { address: p.token0.address },
          create: toPrismaToken(p.token0),
        },
      },
      token1: {
        connectOrCreate: {
          where: { address: p.token1.address },
          create: toPrismaToken(p.token1),
        },
      },
      binStep: p.binStep,
      version: p.version,
    },
  },
});

export const createSwap = async (
  payload: Prisma.SwapUncheckedCreateInput & Pool
): Promise<Swap | false> => {
  // prettier-ignore
  const { poolAddress, version, userAddress, amountIn, amountOut, feesIn, swapForY, startId, endId, timestamp, txHash, usdValue, feesUsdValue, indexInSlot, token0, token1, binStep, token0Value, token1Value } = payload;
  return prisma.swap
    .create({
      data: {
        pool: cocPool(poolAddress, { token0, token1, binStep, version }),
        user: cocUser(userAddress),
        amountIn,
        amountOut,
        feesIn,
        startId,
        endId,
        timestamp,
        txHash,
        usdValue,
        feesUsdValue,
        token0Value,
        token1Value,
        indexInSlot,
        swapForY,
      },
    })
    .catch((err) => {
      handlePrismaError(err);
      return false;
    });
};

export const createLiquidity = async (
  payload: Prisma.LiquidityUncheckedCreateInput & Pool
): Promise<Liquidity | false> => {
  // prettier-ignore
  const { poolAddress, version, userAddress, amount0, amount1, lowerBound, upperBound, timestamp, txHash, usdValue, indexInSlot, token0, token1, binStep, token0Value, token1Value } = payload;
  return prisma.liquidity
    .create({
      data: {
        pool: cocPool(poolAddress, { token0, token1, binStep, version }),
        user: cocUser(userAddress),
        amount0,
        amount1,
        lowerBound,
        upperBound,
        timestamp,
        txHash,
        usdValue,
        token0Value,
        token1Value,
        indexInSlot,
      },
    })
    .catch((err) => {
      handlePrismaError(err);
      return false;
    });
};

export const createPool = async (
  params: ReturnType<typeof EventDecoder.decodeCreateLBPair>,
  version: Pool_version
) => {
  const tokenX = await fetchTokenInfo(params.tokenX);
  const tokenY = await fetchTokenInfo(params.tokenY);
  const tokens = await new ILBPair(params.pair, web3Client).getTokens();
  const token0 = tokens[0] === params.tokenX ? tokenX : tokenY;
  const token1 = tokens[1] === params.tokenY ? tokenY : tokenX;

  return prisma.pool
    .create({
      data: {
        address: params.pair,
        token0: {
          connectOrCreate: {
            where: { address: token0.address },
            create: { ...token0 },
          },
        },
        token1: {
          connectOrCreate: {
            where: { address: token1.address },
            create: { ...token1 },
          },
        },
        binStep: params.binStep,
        version,
      },
    })
    .catch(handlePrismaError);
};

export const updateBinVolume = async (
  params: Omit<Prisma.BinUpsertArgs["create"], "date">,
  now: Date | number | string = new Date()
) => {
  // prettier-ignore
  const { binId, feesUsd, volumeUsd, poolAddress } = params;

  const date = getHourlyTick(now);
  await prisma.bin
    .upsert({
      create: {
        date,
        binId,
        feesUsd,
        volumeUsd,
        poolAddress,
      },
      update: {
        feesUsd: { increment: feesUsd },
        volumeUsd: { increment: volumeUsd },
      },
      where: {
        poolAddress_binId_date: {
          binId,
          date,
          poolAddress,
        },
      },
    })
    .catch(handlePrismaError);
};

export const findDCA = async (id: number, includeExecution = true) =>
  await prisma.dCA.findUnique({
    where: { id },
    include: { execution: includeExecution },
  });

export const createDCA = async (dca: DCA) =>
  await prisma.dCA
    .create({
      data: {
        ...dca,
        userAddress: undefined,
        user: cocUser(dca.userAddress),
      },
    })
    .catch(handlePrismaError);

export const updateDCA = async (
  id: number,
  data: Omit<Prisma.DCAUpdateInput, "userAddress">
): Promise<DCA | false> => {
  return prisma.dCA
    .update({
      where: { id },
      data: {
        ...data,
        status: Status.ACTIVE,
      },
    })
    .catch((err) => {
      handlePrismaError(err);
      return false;
    });
};

export const updateDCAStatus = async (id: number, status: Status) => {
  await prisma.dCA
    .update({
      where: { id },
      data: { status },
    })
    .catch(handlePrismaError);
};

export const createAnalytic = async (
  args: Pick<
    Prisma.AnalyticsUncheckedCreateInput,
    | "date"
    | "poolAddress"
    | "open"
    | "token0Locked"
    | "token1Locked"
    | "usdLocked"
  >
): Promise<boolean> =>
  prisma.analytics
    .create({
      data: {
        ...args,
        close: args.open,
        high: args.open,
        low: args.open,
        fees: 0,
        volume: 0,
        volume0: "0",
        volume1: "0",
      },
    })
    .then(() => true)
    .catch((err) => {
      handlePrismaError(err);
      return false;
    });

export type MakerFees = Omit<Prisma.MakerUncheckedCreateInput, "date">;
export type MakerFeesDate = MakerFees & { date: Date | string };
export const updateMakerFees = async (
  params: MakerFees,
  now?: Date | number | string
) => {
  const date = getHourlyTick(now);
  const {
    address,
    poolAddress,
    accruedFeesX,
    accruedFeesY,
    accruedFeesL,
    accruedFeesUsd,
    accruedFeesUsdEffective,
  } = params;

  const where = { address_poolAddress_date: { address, poolAddress, date } };
  const prev = await prisma.maker.findUnique({
    where,
    select: {
      accruedFeesUsd: true,
      accruedFeesX: true,
      accruedFeesY: true,
      accruedFeesL: true,
    },
  });
  if (!prev)
    await prisma.maker
      .create({ data: { ...params, date } })
      .catch(handlePrismaError);
  else
    await prisma.maker
      .update({
        where,
        data: {
          accruedFeesUsd: { increment: accruedFeesUsd },
          accruedFeesUsdEffective: { increment: accruedFeesUsdEffective },
          accruedFeesX: updateFees(prev.accruedFeesX, accruedFeesX),
          accruedFeesY: updateFees(prev.accruedFeesY, accruedFeesY),
          accruedFeesL: updateFees(prev.accruedFeesL, accruedFeesL),
          volume: { increment: params.volume },
        },
      })
      .catch(handlePrismaError);
};

const updateFees = (current: string, increment: string) =>
  (BigInt(current) + BigInt(increment)).toString();

const getTokenFromAddressRaw = async (tokenAddress: string) => {
  const address = tokenAddress.replace("_", ""); // TEMP: handle MAS/WMAS

  const token = await prisma.token.findUnique({
    where: { address },
  });
  if (!token) {
    logger.warn(`Token ${address} not found in DB`);
    return fetchTokenFromAddress(address);
  }

  return toToken(token);
};
export const getTokenFromAddress = cache(getTokenFromAddressRaw, {
  ttl: ONE_WEEK / 1000,
});

export const getHighLow = async (poolAddress: string, gte: Date, lt: Date) => {
  return prisma.swap
    .aggregate({
      where: { poolAddress, timestamp: { gte, lt } },
      _max: { endId: true },
      _min: { endId: true },
    })
    .then((res) => ({ highId: res._max.endId, lowId: res._min.endId }));
};
export const getVolumeFees = async (
  poolAddress: string,
  gte: Date,
  lt: Date
) => {
  return prisma.swap
    .aggregate({
      where: { poolAddress, timestamp: { gte, lt } },
      _sum: { usdValue: true, feesUsdValue: true },
    })
    .then((res) => ({
      volume: Math.round(res._sum.usdValue || 0),
      fees: res._sum.feesUsdValue || 0,
    }));
};

const getPairAddressRaw = async (
  tokenInAddress: string,
  tokenOutAddress: string,
  binStep: number,
  version: Pool_version = "V2"
) => {
  return prisma.pool
    .findFirst({
      where: {
        OR: [
          {
            token0Address: tokenInAddress,
            token1Address: tokenOutAddress,
            binStep,
            version,
          },
          {
            token0Address: tokenOutAddress,
            token1Address: tokenInAddress,
            binStep,
            version,
          },
        ],
      },
    })
    .then((p) => {
      if (!p) throw new Error("Pool not found");
      return p.address;
    })
    .catch(() =>
      fetchPairAddress(
        tokenInAddress,
        tokenOutAddress,
        binStep,
        version === "V2"
      )
    );
};
export const getPairAddress = cache(getPairAddressRaw, {
  ttl: ONE_WEEK / 1000,
});

export const getTokenY = async (poolAddress: string) => {
  return prisma.pool
    .findUnique({
      where: { address: poolAddress },
      select: { token1Address: true },
    })
    .then((p) => {
      if (!p) throw new Error("Pool not found");
      return p.token1Address;
    })
    .catch(() =>
      new ILBPair(poolAddress, web3Client).getTokens().then((t) => t[1])
    );
};

export const getPools = async (whitelisted = true) => {
  return prisma.pool.findMany({
    where: whitelisted ? { whitelisted: true } : {},
    include: { token0: true, token1: true },
  });
};

export const updatePrice = async (
  poolAddress: string,
  price: number,
  now?: Date | number | string
) => {
  const date = getClosestTick(now);
  const curr = await prisma.analytics.findUnique({
    where: { poolAddress_date: { poolAddress, date } },
  });
  if (!curr) return;

  const data: Prisma.AnalyticsUpdateInput = { close: price };
  if (price > curr.high) data.high = price;
  if (price < curr.low) data.low = price;

  return prisma.analytics
    .update({
      where: { poolAddress_date: { poolAddress, date } },
      data: { ...data },
    })
    .catch(handlePrismaError);
};

export const updateVolume = async (
  poolAddress: string,
  volume: number,
  fees: number,
  now?: Date | number | string
) => {
  const n = now || new Date();
  const date = getClosestTick(n);
  const daily = getDailyTick(n);

  //
  // const curr = await prisma.analytics.findUnique({
  //   where: { poolAddress_date: { poolAddress, date } },
  // });
  // if (!curr) return;
  // TODO: update volume0, volume1

  const data = { volume: { increment: volume }, fees: { increment: fees } };

  const success = await prisma.analytics
    .update({
      where: { poolAddress_date: { poolAddress, date } },
      data,
    })
    .catch(handlePrismaError);
  if (!success) return false;

  return prisma.dailyAnalytics
    .update({
      where: { poolAddress_date: { poolAddress, date: daily } },
      data,
    })
    .catch(handlePrismaError);
};

/**
 * Fetches ledger entries for a given address and prefix
 * @param address
 * @param until
 * @param prefix
 * @returns
 */
export const getLedgerEntries = async (
  address: string,
  until: Date,
  prefix: string
) => {
  return prisma.ledgerChange.findMany({
    distinct: ["key191Chars"],
    orderBy: { createdAt: "desc" },
    where: {
      address,
      key191Chars: { startsWith: prefix },
      createdAt: { lt: until },
    },
  });
};
/**
 * Fetches ledger entries for a given address and keys
 * @param address
 * @param until
 * @param keys
 * @returns
 */
export const getLedgerEntries2 = async (
  address: string,
  until: Date,
  keys: string[],
  beyond?: Date
) => {
  const res = await prisma.ledgerChange.findMany({
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
};
/**
 * Fetches ledger entry for a given address and key beyond a certain date
 * @param address
 * @param beyond
 * @param key
 * @param until
 * @returns
 */
export const getLedgerEntries3 = async (
  address: string,
  beyond: Date,
  key: string,
  until?: Date
) => {
  return prisma.ledgerChange.findFirst({
    distinct: ["key191Chars"],
    orderBy: { createdAt: "asc" },
    where: {
      address,
      key191Chars: key,
      createdAt: { gte: beyond, lt: until },
    },
  });
};
