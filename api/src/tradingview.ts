import { Prisma } from "@prisma/client";
import { prisma } from "../../common/db";
import logger from "../../common/logger";
import { launchTimestamp, TICKS_PER_DAY } from "../../common/utils";

interface BarsData {
  t: number[];
  o: number[];
  c: number[];
  h: number[];
  l: number[];
  v: number[];
}
type BarsResponse =
  | (BarsData & {
      s: "ok";
    })
  | {
      s: "error";
      errmsg: string;
    }
  | {
      s: "no_data";
      nextTime?: number;
    };

const supported_resolutions = [
  "5",
  "15",
  "30",
  "60",
  "120",
  "240",
  "360",
  "480",
  "720",
  "1D",
  "3D",
  "1W",
  "1M",
];

// Data feed configuration data
// https://www.tradingview.com/charting-library-docs/latest/connecting_data/UDF/#data-feed-configuration-data
export const getConfig = () => {
  return {
    supported_resolutions,
    supports_group_request: false,
    supports_marks: false,
    supports_search: true,
    supports_timescale_marks: false,
  };
};

// Symbol resolve
// https://www.tradingview.com/charting-library-docs/latest/connecting_data/UDF/#symbol-resolve
export const resolveSymbol = async (symbol: string) => {
  const poolAddresses = symbol.split(":");
  // symbol = symbol.split(":")[0];
  const pool = await prisma.pool.findMany({
    where: { address: { in: poolAddresses } },
    include: { token0: true, token1: true },
  });
  const description = pool
    .map((p) => `${p.token0.symbol}/${p.token1.symbol}`)
    .join(", ");
  return {
    name: symbol,
    full_name: symbol,
    // base_name: [symbol],
    // ticker: symbol,
    description,
    type: "crypto",
    session: "24x7",
    exchange: "Dusa",
    listed_exchange: "Dusa",
    timezone: "Etc/UTC",
    format: "price",
    pricescale: 10 ** 9,
    minmov: 1,
    has_empty_bars: true,
    has_intraday: true,
    intraday_multipliers: ["5"],
    supported_resolutions,
  };
};

// Symbol search
// https://www.tradingview.com/charting-library-docs/latest/connecting_data/UDF/#symbol-search
export const searchSymbols = () => {
  return [];
};

interface GetBarsOptions {
  symbol: string;
  resolution: string;
  from: number;
  to: number;
  countback: number;
  includeEmptyCandles?: boolean;
}

// Bars
// https://www.tradingview.com/charting-library-docs/latest/connecting_data/UDF/#bars
const MAX_HOPS = 3; // swap routes in the interface use at most 3 pools

export const getBars = async (opts: GetBarsOptions): Promise<BarsResponse> => {
  const { resolution, from, to, countback, includeEmptyCandles } = opts;
  let take = countback;

  const launchInS = launchTimestamp / 1000;
  const invalidDate = (!countback && from < launchInS) || to < launchInS;
  if (invalidDate) return { nextTime: launchInS, s: "no_data" };

  const isDailyBars = resolution === "1D";
  const prices = await getTicks(
    opts,
    take,
    isDailyBars,
    includeEmptyCandles === undefined ? true : includeEmptyCandles
  );

  const length = prices.length;
  if (length === 0) return { s: "no_data" };
  // if (opts.countback !== prices.length) {
  //   return {
  //     // nextTime: prices[prices.length - 1].date.getTime() / 1000,
  //     s: "no_data",
  //   };
  // }

  const newPrices: BarsData = {
    t: Array.from({ length }),
    o: Array.from({ length }),
    c: Array.from({ length }),
    h: Array.from({ length }),
    l: Array.from({ length }),
    v: Array.from({ length }),
  };
  for (let i = prices.length - 1; i >= 0; i--) {
    const price = prices[i];
    const index = length - (i + 1);
    newPrices.t[index] = price.date.getTime() / 1000;
    newPrices.o[index] = price.open;
    newPrices.c[index] = price.close;
    newPrices.h[index] = price.high;
    newPrices.l[index] = price.low;
    newPrices.v[index] = price.volume;
  }

  return { ...newPrices, s: "ok" };
};

// Server time
// https://www.tradingview.com/charting-library-docs/latest/connecting_data/UDF/#server-time
export const getServerTime = () => {
  return Math.floor(Date.now() / 1000);
};

// UTILS

const getTicks = async (
  opts: GetBarsOptions,
  take: number,
  isDailyBars: boolean,
  includeEmptyCandles: boolean
) => {
  const { symbol, from, to, countback } = opts;
  // unique pools, at most MAX_HOPS: each extra entry multiplies the rows loaded
  const poolAddresses = [...new Set(symbol.split(":"))].slice(0, MAX_HOPS);
  const hops = poolAddresses.length;
  // console.log({ hops });

  const volume = includeEmptyCandles ? undefined : { gt: 0 };

  if (isDailyBars) {
    const res = await prisma.dailyAnalytics.findMany({
      select: { ...selectPrice, poolAddress: true },
      where: {
        poolAddress: { in: poolAddresses },
        date: {
          gte: countback ? undefined : new Date(from * 1000),
          lt: new Date(to * 1000),
        },
        volume,
      },
      orderBy: [{ date: "desc" }, { poolAddress: "desc" }],
      take: take * hops,
    });
    if (hops === 1) return res;

    // check if there are the same number of daily bars for each pool
    // 1. get the number of daily bars for each pool
    // 2. get the minimum number of daily bars
    // 3. filter out the extra daily bars
    // 4. normalize the data
    // const poolDailyBars = res.reduce((acc, curr) => {
    //   acc[curr.poolAddress] = (acc[curr.poolAddress] || 0) + 1;
    //   return acc;
    // }, {} as Record<string, number>);
    // const minDailyBars = Math.min(...Object.values(poolDailyBars));
    // const normalizedRes = res.filter(
    //   (r) => poolDailyBars[r.poolAddress] <= minDailyBars
    // );
    // return normalize(normalizedRes, hops);

    // console.log(normalize(res, hops).length, take, countback);
    return normalize(res, hops);
  }

  const res = await prisma.analytics.findMany({
    select: { ...selectPrice, poolAddress: true },
    where: {
      poolAddress: { in: poolAddresses },
      date: {
        gte: countback ? undefined : new Date(from * 1000),
        lt: new Date(to * 1000),
      },
      volume,
    },
    orderBy: [{ date: "desc" }, { poolAddress: "desc" }],
    take: take * hops,
  });
  if (hops === 1) return res;

  return normalize(res, hops);
};

const selectPrice = {
  open: true,
  close: true,
  high: true,
  low: true,
  date: true,
  volume: true,
};

// type PriceWithVolume = Prisma.AnalyticsGetPayload<{ select: typeof selectPrice }>;
// type PriceWithoutVolume = Omit<PriceWithVolume, "volume">;
// type Price = PriceWithVolume | PriceWithoutVolume;
type Price = Prisma.AnalyticsGetPayload<{ select: typeof selectPrice }>;

export const normalize = (
  res: (Price & { poolAddress: string })[],
  hops: number
) => {
  const norm: Price[] = [];

  // If single hop, no normalization needed
  if (hops === 1) {
    return res.map(({ poolAddress, ...price }) => price);
  }

  // Group by date to ensure we combine the right data
  const groupedByDate = new Map<
    number,
    Map<string, Price & { poolAddress: string }>
  >();

  for (const item of res) {
    const timestamp = item.date.getTime();
    if (!groupedByDate.has(timestamp)) {
      groupedByDate.set(timestamp, new Map());
    }
    groupedByDate.get(timestamp)!.set(item.poolAddress, item);
  }

  // Get unique pool addresses to maintain consistent order
  const poolAddresses = [...new Set(res.map((r) => r.poolAddress))].sort();

  // Process each date group
  for (const [timestamp, poolMap] of groupedByDate) {
    // Check if we have data for all required pools
    if (poolMap.size !== hops || poolMap.size !== poolAddresses.length) {
      continue; // Skip incomplete data
    }

    // Get prices in consistent order
    const arr = poolAddresses
      .map((addr) => poolMap.get(addr))
      .filter(Boolean) as Price[];

    if (arr.length !== hops) {
      continue; // Skip if we don't have all pool data
    }

    const open = arr.reduce((acc, curr) => acc * curr.open, 1);
    const close = arr.reduce((acc, curr) => acc * curr.close, 1);
    const high = arr.reduce((acc, curr) => acc * curr.high, 1);
    const low = arr.reduce((acc, curr) => acc * curr.low, 1);
    const volume = arr.reduce((acc, curr) => acc + curr.volume, 0);

    norm.push({ open, close, high, low, date: new Date(timestamp), volume });
  }

  // Sort by date descending to maintain order
  norm.sort((a, b) => b.date.getTime() - a.date.getTime());

  return norm;
};
