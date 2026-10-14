import { strToBytes, Args, Operation } from "@massalabs/massa-web3";
import { web3Client } from "./client";
import {
  DUSA,
  JELLY,
  USDC,
  WETH,
  WETH_B,
  WMAS,
  dcaSC,
  dcaSCV2,
  factorySC,
  masUsdcPairV1,
  masUsdcPairBs,
  v2FactorySC,
  v2QuoterSC,
} from "./contracts";
import {
  IBaseContract,
  IERC20,
  IFactory,
  ILBPair,
  QuoterHelper,
  Token,
  TokenAmount,
  parseUnits,
} from "@dusalabs/sdk";
import { CHAIN_ID, MCAP, NO_VALUE_TOKENS, SUPPLY } from "./config";
import {
  adjustPrice,
  cache,
  getPriceFromId,
  roundFraction,
  toToken,
} from "./methods";
import { DCA, Status, Token as PrismaToken } from "@prisma/client";
import { decodeDcaTx } from "../indexer/src/decoder";
import { IEventPollerResult, MASSA_EXEC_ERROR } from "./eventPoller";
import { ONE_MINUTE } from "./utils";
import logger from "./logger";
import { prisma } from "./db";

export const fetchPairAddress = async (
  token0: string,
  token1: string,
  binStep: number,
  v2 = true
): Promise<string> =>
  new IFactory(v2 ? v2FactorySC : factorySC, web3Client)
    .getLBPairInformation(token0, token1, binStep)
    .then((res) => res.LBPair);

export const getTokenValueUsingQuoter = async (
  tokenIn: Token
): Promise<number> => {
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
    web3Client,
    CHAIN_ID,
    v2QuoterSC
  );
  try {
    return roundFraction(bestTrade.executionPrice);
  } catch (e) {
    logger.error(`Error fetching token value for ${tokenIn.address}: ${e}`);
    return 0;
  }
};

/**
 * @dev hardcoded values for poolAddress & token order (should be safe)
 * @returns `WMAS` value in `USDC`
 */
export const getWmasValue = async () => {
  return getTokenValueUsingQuoter(WMAS);
  // const activeId = await new IBaseContract(masUsdcPairV1, web3Client)
  //   .extract(["PAIR_INFORMATION"])
  //   .then((res) => {
  //     if (!res[0]?.length) throw new Error("activeId not found");
  //     return Number(new Args(res[0]).nextU32());
  //   });

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
  if (NO_VALUE_TOKENS.includes(token.address)) return 0;
  if (!token.address) throw new Error("Token address is required");
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
    const activeId = await new ILBPair(usdcPool.address, web3Client)
      .getReservesAndId()
      .then((r) => r.activeId);
    return adjustPrice(
      getPriceFromId(activeId, usdcPool.binStep),
      usdcPool.token0.decimals,
      usdcPool.token1.decimals
    );
  }

  const wmasPool = find(WMAS.address);
  if (wmasPool) {
    const activeId = await new ILBPair(wmasPool.address, web3Client)
      .getReservesAndId()
      .then((r) => r.activeId);
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

    const activeId = await new ILBPair(stablePool.address, web3Client)
      .getReservesAndId()
      .then((r) => r.activeId);
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

export const fetchDCA = async (
  id: number,
  userAddress: string,
  contractAddress?: string
): Promise<DCA> => {
  // Try dcaSC first, then dcaSCV2 if not specified
  const dcaContract = contractAddress || dcaSC;

  return new IBaseContract(dcaContract, web3Client)
    .extract([`D::${userAddress}:${id}`])
    .then((res) => {
      if (!res[0]?.length) {
        // If dcaSC failed and no specific contract was requested, try dcaSCV2
        if (!contractAddress && dcaContract === dcaSC) {
          return fetchDCA(id, userAddress, dcaSCV2);
        }
        throw new Error(`DCA ${id} not found`);
      }

      const dca = decodeDcaTx(res[0]);
      return {
        ...dca,
        id,
        userAddress,
        status: Status.ACTIVE,
        txHash: "",
      };
    });
};

// Helper function to get all DCA contract addresses
export const getDCAContracts = (): string[] => [dcaSC, dcaSCV2];

// Helper function to check if an address is a DCA contract
export const isDCAContract = (address: string): boolean =>
  getDCAContracts().includes(address);

export const fetchTokenFromAddress = async (
  tokenAddress: string
): Promise<Token> => {
  const token = new IERC20(tokenAddress, web3Client);
  const [decimals, name, symbol] = await Promise.all([
    token.decimals(),
    token.name(),
    token.symbol(),
  ]);

  return toToken({ address: token.address, decimals, name, symbol });
};

export const getDatastoreKeys = async (
  address: string,
  prefix?: string
): Promise<string[]> =>
  web3Client
    .getStorageKeys(address, prefix)
    .then((r) => r.map((v) => String.fromCharCode(...v)));

export const fetchTokenInfo = async (
  tokenAddress: string
): Promise<PrismaToken> => {
  const token = new IERC20(tokenAddress, web3Client);
  const [name, symbol, decimals] = await Promise.all([
    token.name(),
    token.symbol(),
    token.decimals(),
  ]);

  return {
    address: token.address,
    name,
    symbol,
    decimals,
  };
};

export const fetchEvents = async (
  txHash: string,
  intervalMs = 1000,
  timeoutMs = ONE_MINUTE
): Promise<IEventPollerResult> => {
  const events = await new Operation(web3Client, txHash).getSpeculativeEvents();
  const errorEvents = events.filter((e) => e.data.includes(MASSA_EXEC_ERROR));
  if (errorEvents.length > 0) return { isError: true, events: errorEvents };

  return { isError: false, events };
};
