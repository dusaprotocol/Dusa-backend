import { Address, Args, strToBytes } from "@massalabs/massa-web3";
import { CHAIN_ID } from "./config";
import {
  Bin as _Bin,
  Fraction,
  IBaseContract,
  ILBPair,
  Token,
  TokenAmount,
} from "@dusalabs/sdk";
import { Prisma, Token as PrismaToken } from "@prisma/client";
import { ONE_DAY, ONE_WEEK, getDailyTick } from "./utils";
import { web3Client } from "./client";

type SCOutputEvent = OutputEvents[number];

export const getPriceFromId = _Bin.getPriceFromId;
export const getIdFromPrice = _Bin.getIdFromPrice;

export const getCallee = (callStack: string[]): string => {
  return callStack[callStack.length - 1];
};

export const isDepositEvent = (e: string) => e.startsWith("DEPOSITED_TO_BIN:");
export const isDepositV2Event = (e: string) => e.startsWith("DEPOSITED:");
export const isWithdrawEvent = (e: string) =>
  e.startsWith("WITHDRAWN_FROM_BIN:");
export const isWithdrawV2Event = (e: string) => e.startsWith("WITHDRAWN:");
export const isLiquidityEvent = (e: SCOutputEvent, poolAddress: string) =>
  getCallee(e.context.call_stack) === poolAddress &&
  (isDepositEvent(e.data) || isWithdrawEvent(e.data));
export const isLiquidityV2Event = (e: SCOutputEvent, poolAddress: string) =>
  getCallee(e.context.call_stack) === poolAddress &&
  (isDepositV2Event(e.data) || isWithdrawV2Event(e.data));

export const isSwapV1Event = (event: SCOutputEvent, poolAddress: string) =>
  getCallee(event.context.call_stack) === poolAddress &&
  event.data.startsWith("SWAP:");
export const isSwapV2Event = (event: SCOutputEvent, poolAddress: string) =>
  getCallee(event.context.call_stack) === poolAddress &&
  event.data.startsWith("V1_SWAP:");
export const isSwapEvent = (event: SCOutputEvent, poolAddress: string) =>
  isSwapV1Event(event, poolAddress) || isSwapV2Event(event, poolAddress);

export const adjustPrice = (
  price: number,
  decimals0: number,
  decimals1: number
): number => price * 10 ** (decimals0 - decimals1);
export const unadjustPrice = (
  price: number,
  decimals0: number,
  decimals1: number
): number => price * 10 ** (decimals1 - decimals0);

export const toFraction = (val: number): Fraction => {
  if (val === 0 || isNaN(val)) return new Fraction(0n, 1n);
  const value = BigInt(Math.round(val * 1e18));
  return new Fraction(value, BigInt(1e18));
};

export const round = (value: number, precision = 2) =>
  Number(value.toFixed(precision));

export const abs = (value: bigint) => (value < 0n ? -value : value);

type PartialBy<T, K extends keyof T> = Omit<T, K> & Partial<Pick<T, K>>;
type PartialToken = PartialBy<PrismaToken, "name" | "symbol">;
export const toToken = (token: PartialToken) =>
  new Token(CHAIN_ID, token.address, token.decimals, token.symbol, token.name);

export const toPrismaToken = (token: Token): PrismaToken => ({
  // warning /!\: do NOT use spread operator here (`unknown properties` issues w/ prisma)
  address: token.address,
  decimals: token.decimals,
  name: token.name || "",
  symbol: token.symbol || "",
});

export const printUSD = (value: number, keepCents = false) =>
  value.toLocaleString("en-US", {
    maximumSignificantDigits: value < 1 ? 2 : undefined,
    maximumFractionDigits: keepCents ? 2 : 0,
    minimumFractionDigits: keepCents ? 2 : 0,
  });

export const roundFraction = (amount: Fraction, precision = 6) =>
  Number(amount.toSignificant(precision));

export const calculateUSDValue = (
  amount0: TokenAmount,
  token0Value: number,
  amount1: TokenAmount,
  token1Value: number
): number =>
  roundFraction(
    amount0
      .multiply(toFraction(token0Value))
      .add(amount1.multiply(toFraction(token1Value)))
  );

/**
 * Calculate the weekly streak
 * @param timestamps - list of dates
 * @param now - relative to which date to calculate the streak
 * @returns
 */
export const calculateWeeklyStreak = (
  timestamps: Date[],
  now = Date.now()
): number => {
  if (!timestamps.length) return 0;

  let streak = 0;
  let currentDate = getDailyTick(now).getTime();

  // start on Monday
  while (new Date(currentDate).getDay() !== 1) {
    currentDate = currentDate - ONE_DAY;
  }

  while (true) {
    // check if there is a record for the current week range
    if (
      timestamps.some(
        (p) =>
          p.getTime() < currentDate && p.getTime() >= currentDate - ONE_WEEK
      )
    ) {
      streak++;
      currentDate = currentDate - ONE_WEEK;
    } else return streak;
  }
};

/**
 * Calculate the daily streak
 * @param timestamps - list of dates
 * @param now - relative to which date to calculate the streak
 * @returns
 */
export const calculateDailyStreak = (
  timestamps: Date[],
  now = Date.now()
): number => {
  if (!timestamps.length) return 0;

  let streak = 0;
  let currentDate = getDailyTick(now).getTime();

  while (true) {
    if (timestamps.some((p) => getDailyTick(p).getTime() === currentDate)) {
      streak++;
      currentDate = currentDate - ONE_DAY;
    } else return streak;
  }
};

export const isAddressValid = (address: string): boolean => {
  if (!address) return false;
  try {
    Address.fromString(address);
    return true;
  } catch (e) {
    return false;
  }
};

// TODO: move this to SDK? (copied from interface)

export interface Bin {
  id: number;
  amount0: bigint;
  amount1: bigint;
  amountLBT: bigint;
}

export const fetchUserLiquidityBins = async (
  account: string,
  address: string
): Promise<Bin[]> => {
  const ids = await new ILBPair(address, web3Client).getUserBinIds(account);

  const keys: string[] = ids.flatMap((id) => [
    `bin::${id}`,
    `balances::${id}:${account}`,
    `total_supplies::${id}`,
  ]);

  return new IBaseContract(address, web3Client)
    .extract(keys)
    .then(async (entries) => {
      const res: Bin[] = [];

      entries.forEach((entry, i) => {
        if (i % 3 !== 0) return; // skip balances::${id}${account} and total_supplies::${id}

        const resBin = entry;
        const resBalance = entries[i + 1];
        const resSupply = entries[i + 2];
        if (!resBin || !resBalance || !resSupply) {
          res.push({
            id: ids[i / 3],
            amountLBT: 0n,
            amount0: 0n,
            amount1: 0n,
          });
          return;
        }

        const returnValueBin = new Args(resBin);
        const totalAmount0 = returnValueBin.nextU256();
        const totalAmount1 = returnValueBin.nextU256();

        const returnValueBalance = new Args(resBalance);
        const lbTokenAmount = returnValueBalance.nextU256();
        if (lbTokenAmount === 0n) return;

        const returnValueSupply = new Args(resSupply);
        const totalLBT = returnValueSupply.nextU256();
        const amount0 = (lbTokenAmount * totalAmount0) / totalLBT;
        const amount1 = (lbTokenAmount * totalAmount1) / totalLBT;

        res.push({
          amount0,
          amount1,
          amountLBT: lbTokenAmount,
          id: ids[i / 3],
        });
      });

      return res;
    });
};

export const sumBinAmounts = (bins: Bin[]) =>
  bins.reduce(
    (acc, bin) => ({
      amount0: acc.amount0 + bin.amount0,
      amount1: acc.amount1 + bin.amount1,
    }),
    { amount0: 0n, amount1: 0n }
  );

export interface Pool {
  token0: PrismaToken;
  token1: PrismaToken;
  binStep: number;
}

export const fetchLiquidityBatch = (
  pools: Pool[],
  poolAddresses: string[]
) => {};

export const fetchUserLiquidity = async (
  pool: Pool,
  poolAddress: string,
  account: string
) => {
  const liq = await fetchUserLiquidityBins(account, poolAddress);
  const { amount0, amount1 } = sumBinAmounts(liq);

  const fees0 = 0n;
  const fees1 = 0n;
  const res: PoolLiquidity = {
    ...pool,
    amount0,
    amount1,
    fees0,
    fees1,
  };
  return { ...res, liq };
};

export interface PoolLiquidity {
  token0: PrismaToken;
  token1: PrismaToken;
  binStep: number;
  amount0: bigint;
  amount1: bigint;
  fees0: bigint;
  fees1: bigint;
}

// MISC

import NodeCache from "node-cache";
import { BigintIsh } from "@dusalabs/sdk/dist/constants";
import { tokenList } from "./contracts";
import { OutputEvents } from "@massalabs/massa-web3/dist/esm/generated/client-types";
const cacheSingleton = new NodeCache({ stdTTL: 10 });

type CacheOptions = {
  ttl: number;
  keyPrefix?: string;
};

// Type-safe function wrapper that preserves parameter and return types
type CacheableFunction<Args extends unknown[], R> = (
  ...args: Args
) => Promise<R>;

// Helper to create a cache key that captures the function signature and arguments
const createCacheKey = (
  fn: Function,
  args: unknown[],
  prefix?: string
): string => {
  const fnKey = fn.toString();
  const argsKey = JSON.stringify(args);
  return `${prefix || ""}${fnKey}:${argsKey}`;
};

export const cache = <Args extends unknown[], R>(
  fn: CacheableFunction<Args, R>,
  options: CacheOptions
): CacheableFunction<Args, R> => {
  return async (...args: Args): Promise<R> => {
    const cacheKey = createCacheKey(fn, args, options.keyPrefix);

    const cachedData = cacheSingleton.get(cacheKey) as R | undefined;
    if (cachedData !== undefined) return cachedData;

    const res = await fn(...args);
    cacheSingleton.set(cacheKey, res, options.ttl);
    return res;
  };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const chunk = (arr: any[], size: number) =>
  Array.from({ length: Math.ceil(arr.length / size) }, (v, i) =>
    arr.slice(i * size, i * size + size)
  );

export const printTA = (
  token: Pick<PrismaToken, "decimals">,
  amount: BigintIsh,
  precision = 4
) =>
  new TokenAmount(toToken({ ...token, address: "" }), amount).toSignificant(
    precision
  );
export const printAddress = (address: string) => address.slice(-6);
export const getSymbolFromAddress = (address: string): string =>
  tokenList.find((t) => t.address === address)?.symbol || "";
