import { TokenAmount } from "@dusalabs/sdk";
import { prisma } from "../../common/db";
import { ONE_DAY, ONE_TICK, getClosestTick } from "../../common/utils";
import { adjustPrice, getPriceFromId, toToken } from "../../common/methods";
import { getHighLow, getPools } from "../../indexer/src/db";
import {
  DAI,
  USDC,
  WETH,
  WMAS,
  USDT,
  WETH_B,
  PUR,
  WBTC,
} from "../../common/contracts";
import { z } from "zod";

interface Ticker {
  ticker_id: string;
  base_currency: string;
  target_currency: string;
  pool_id: string;
  last_price: string;
  base_volume: string;
  target_volume: string;
  liquidity_in_usd: string;
  high: string;
  low: string;
}

export const getTickers = async (): Promise<Ticker[]> => {
  const pools = await getPools();
  return Promise.all(
    pools.map(async (pool): Promise<Ticker> => {
      const { token0, token1 } = pool;
      const last24h = await prisma.analytics.findMany({
        select: {
          volume0: true,
          volume1: true,
          open: true,
          usdLocked: true,
        },
        where: {
          poolAddress: pool.address,
          date: { gte: getClosestTick(Date.now() - ONE_DAY) },
          volume: { gt: 0 },
        },
      });
      const base_volume = last24h.reduce(
        (acc, { volume0 }) => acc + BigInt(volume0),
        0n
      );
      const target_volume = last24h.reduce(
        (acc, { volume1 }) => acc + BigInt(volume1),
        0n
      );

      const lastTick = last24h.length ? last24h[last24h.length - 1] : null;
      const liquidity_in_usd = lastTick?.usdLocked || 0n;
      const open = lastTick?.open || 0;

      const { highId, lowId } = await getHighLow(
        pool.address,
        getClosestTick(Date.now() - ONE_TICK),
        getClosestTick()
      );
      const [high, low] = [highId, lowId].map((binId) =>
        binId
          ? adjustPrice(
              getPriceFromId(binId, pool.binStep),
              token0.decimals,
              token1.decimals
            )
          : open
      );

      return {
        ticker_id: `${token0.address}_${token1.address}`,
        base_currency: token0.address,
        target_currency: token1.address,
        pool_id: pool.address,
        last_price: open.toString(),
        base_volume: new TokenAmount(
          toToken(token0),
          base_volume
        ).toSignificant(),
        target_volume: new TokenAmount(
          toToken(token1),
          target_volume
        ).toSignificant(),
        liquidity_in_usd: liquidity_in_usd.toString(),
        high: high.toString(),
        low: low.toString(),
      };
    })
  );
};

export const fetchTokenValue = async (
  tokenAddresses: string[]
): Promise<number[]> => {
  if (!process.env.COINGECKO_API_KEY) throw new Error("No Coingecko API key");

  const ids = tokenAddresses.map(addressToId);
  if (ids.length !== tokenAddresses.length)
    throw new Error("Tokens not supported by Coingecko");

  const baseUrl = "https://api.coingecko.com/api/v3/simple/price";
  const url = `${baseUrl}?ids=${ids.join(",")}&vs_currencies=usd`;
  const options = {
    headers: {
      accept: "application/json",
      "x-cg-demo-api-key": process.env.COINGECKO_API_KEY,
    },
  };

  const res = await fetch(url, options)
    .then((res) => res.json())
    .then((json) =>
      z
        .number()
        .array()
        .parse(ids.map((id) => json[id].usd))
    );
  return res;
};

/**
 *
 * @param tokenAddress token address
 * @param timestamp in milliseconds
 * @returns
 */
export const fetchTokenValueAtTimestamp = async (
  tokenAddress: string,
  timestamp: Date | string | number
): Promise<number> => {
  if (!process.env.COINGECKO_API_KEY) throw new Error("No Coingecko API key");

  const id = addressToId(tokenAddress);
  if (!id) throw new Error("Token not supported by Coingecko");

  const baseUrl = `https://api.coingecko.com/api/v3/coins/${id}/market_chart`;
  const url = `${baseUrl}?days=1&vs_currency=usd`;
  const options = {
    headers: {
      accept: "application/json",
      "x-cg-demo-api-key": process.env.COINGECKO_API_KEY,
    },
  };

  type Tick = [number, number]; // [timestamp, price]
  const res: Tick[] = await fetch(url, options)
    .then((res) => res.json())
    .then((json) => json.prices);
  const closestTick = res.find(
    ([tickTimestamp]) => tickTimestamp >= new Date(timestamp).getTime()
  );
  if (!closestTick) throw new Error("No data found for this timestamp");
  return closestTick[1];
};

const addressToId = (tokenAddress: string) => {
  if (equals(tokenAddress, WMAS.address)) return "wrapped-massa";
  if (equals(tokenAddress, USDC.address)) return "massa-bridged-usdc-massa";
  if (equals(tokenAddress, USDT.address)) return "massa-bridged-usdt-massa";
  if (equals(tokenAddress, DAI.address)) return "massa-bridged-dai-massa";
  if (equals(tokenAddress, WBTC.address)) return "bitcoin"; // tmp
  // prettier-ignore
  if (equals(tokenAddress, WETH.address) || equals(tokenAddress, WETH_B.address)) return "wrapped-ether-massa";
  if (equals(tokenAddress, PUR.address)) return "purrfect-universe";
  else throw new Error("Token not supported by Coingecko");
};

const equals = (tokenA: string, tokenB: string) =>
  tokenA.toLowerCase() === tokenB.toLowerCase();

// fetchTokenValueAtTimestamp(WETH.address, Date.now() - ONE_DAY / 2).then(
//   console.log
// );
