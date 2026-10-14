import { Args } from "@massalabs/massa-web3";
import {
  DUSA,
  JELLY,
  USDC,
  WETH,
  WETH_B,
  WMAS,
  masUsdcPairV1,
  masUsdcPairV2,
  masUsdcPairBs,
} from "../common/contracts";
import {
  Token,
  TokenAmount,
  parseUnits,
  ILBPair as ILBPairJSON,
} from "@dusalabs/sdk";
import { CHAIN_ID, MCAP, NO_VALUE_TOKENS, SUPPLY } from "../common/config";
import {
  adjustPrice,
  cache,
  getPriceFromId,
  getSymbolFromAddress,
  roundFraction,
  toToken,
} from "../common/methods";
import logger from "../common/logger";
import { prisma } from "../common/db";
import * as gRPC from "./src/grpc";
import { ILBPair } from "./src/grpcSDK/base";
import { web3Client } from "../common/client";
import { baseClient } from "./src/client";
import { QuoterHelper } from "./src/quoterHelper";
// import { QuoterHelper } from "./src/quoterHelper";

// HELPERS

// const extract = (address: string, keys: string[]) =>
//   gRPC.getDatastoreEntries(address, keys).then((r) => r);

// METHODS

// export const fetchPairAddress = async (
//   token0: string,
//   token1: string,
//   binStep: number
// ): Promise<string> =>
//   gRPC
//     .read(
//       factorySC,
//       "getLBPairInformation",
//       Uint8Array.from(
//         new Args()
//           .addString(token0)
//           .addString(token1)
//           .addU32(binStep)
//           .serialize()
//       )
//     )
//     .then((res) => new LBPairInformation().deserialize(res).instance.LBPair);

export const getActiveId = async (pairAddress: string): Promise<number> =>
  new ILBPairJSON(pairAddress, web3Client) // TEMP
    .read({ targetFunction: "getPairInformation", parameter: [] })
    .then((res) => Number(new Args(res.value).nextU32()));

export const getTokenValueUsingQuoter = async (
  tokenIn: Token
): Promise<number> => {
  if (tokenIn.equals(USDC)) return 1;
  const amountOut = new TokenAmount(USDC, parseUnits("1", USDC.decimals));
  const maxHops = 2;
  const bestTrade = await QuoterHelper.findBestPath(
    tokenIn,
    false,
    USDC,
    false,
    amountOut,
    false,
    maxHops,
    baseClient,
    CHAIN_ID
  );
  try {
    return roundFraction(bestTrade.executionPrice);
  } catch (e) {
    logger.error(
      `Error fetching token value for ${
        tokenIn.address
      } (${getSymbolFromAddress(tokenIn.address)}): ${e}`
    );
    return 0;
  }
};

/**
 * @dev hardcoded values for poolAddress & token order (should be safe)
 * @returns `WMAS` value in `USDC`
 */
export const getWmasValue = async () => {
  return getTokenValueUsingQuoter(WMAS);
  // const activeId = await getActiveId(masUsdcPair);

  // const token0 = WMAS;
  // const token1 = USDC;
  // return adjustPrice(
  //   getPriceFromId(activeId, masUsdcPairBs),
  //   token0.decimals,
  //   token1.decimals
  // );
};

export const getTokenValue = async (
  token: Token,
  ttl = 10
): Promise<number> => {
  try {
    const fn = cache(getTokenValueRaw, { ttl });
    const res = await fn(token);
    return res;
  } catch (e) {
    logger.error(`Error fetching token value for ${token.address}: ${e}`);
    return 0;
  }
};
export const getTokenValueRaw = async (_token: Token): Promise<number> => {
  const token = _token.equals(JELLY) ? DUSA : _token;
  if (!token.address) throw new Error("Token address is required");
  if (NO_VALUE_TOKENS.includes(token.address)) return 0;
  if (token.equals(USDC)) return 1;
  if (token.equals(WMAS)) return getWmasValue();

  const pools = await prisma.pool.findMany({
    where: {
      whitelisted: true,
      version: "V2",
      OR: [{ token0Address: token.address }, { token1Address: token.address }],
    },
    include: { token0: true, token1: true },
  });

  const find = (quoteAddress: string) =>
    pools.find(
      (p) =>
        (p.token0Address === quoteAddress &&
          p.token1Address === token.address) ||
        (p.token1Address === quoteAddress && p.token0Address === token.address)
    );

  const usdcPool = find(USDC.address);
  if (usdcPool) {
    const activeId = await getActiveId(usdcPool.address);
    return adjustPrice(
      getPriceFromId(activeId, usdcPool.binStep),
      usdcPool.token0.decimals,
      usdcPool.token1.decimals
    );
  }

  const wmasPool = find(WMAS.address);
  if (wmasPool) {
    const activeId = await getActiveId(wmasPool.address);
    const priceInWmas = adjustPrice(
      getPriceFromId(activeId, wmasPool.binStep),
      wmasPool.token0.decimals,
      wmasPool.token1.decimals
    );
    const wmasValue = await getWmasValue();
    return priceInWmas * wmasValue;
  }

  if (token.equals(WETH_B)) {
    const stablePool = find(WETH.address);
    if (!stablePool) throw new Error("No pool found for WETH.b and WETH.e");

    const activeId = await getActiveId(stablePool.address);
    const priceInWethE = adjustPrice(
      getPriceFromId(activeId, stablePool.binStep),
      stablePool.token0.decimals,
      stablePool.token1.decimals
    );
    const wethValue = await getTokenValue(WETH);
    return priceInWethE * wethValue;
  }

  return getTokenValueUsingQuoter(token);
};
