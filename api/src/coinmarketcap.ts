import { TokenAmount } from "@dusalabs/sdk";
import { prisma } from "../../common/db";
import { ONE_DAY, getClosestTick } from "../../common/utils";
import { toToken } from "../../common/methods";
import { getPools } from "../../indexer/src/db";

interface Ticker {
  base_id: string;
  base_name: string;
  base_symbol: string;
  quote_id: string;
  quote_name: string;
  quote_symbol: string;
  last_price: string;
  base_volume: string;
  quote_volume: string;
}
// key is base_id + `_` + quote_id
type Response = Record<string, Ticker>;

export const getTickers = async (): Promise<Response> => {
  const pools = await getPools();
  const res = await Promise.all(
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
      const quote_volume = last24h.reduce(
        (acc, { volume1 }) => acc + BigInt(volume1),
        0n
      );

      const lastTick = last24h.length ? last24h[last24h.length - 1].open : 0;

      return {
        base_id: token0.address,
        base_name: token0.name,
        base_symbol: token0.symbol,
        quote_id: token1.address,
        quote_name: token1.name,
        quote_symbol: token1.symbol,
        last_price: lastTick.toString(),
        base_volume: new TokenAmount(
          toToken(token0),
          base_volume
        ).toSignificant(),
        quote_volume: new TokenAmount(
          toToken(token1),
          quote_volume
        ).toSignificant(),
      };
    })
  );
  return res.reduce((acc, ticker) => {
    acc[`${ticker.base_id}_${ticker.quote_id}`] = ticker;
    return acc;
  }, {} as Response);
};
