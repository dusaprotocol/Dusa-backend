import {
  ChainId,
  PairV2,
  parseUnits,
  Quote,
  RouteV2,
  Token,
  TokenAmount,
  TradeV2,
  Tx,
  USDC,
  WETH,
  WMAS,
} from "@dusalabs/sdk";
import { Args, ArrayTypes } from "@massalabs/massa-web3";
import { multicallSC, v2QuoterSC } from "../../common/contracts";
import { IMulticall, IQuoter } from "./grpcSDK/base";
import { baseClient } from "./client";
import { CHAIN_ID } from "../../common/config";

export class QuoterHelper {
  static async findBestPath(
    inputToken: Token,
    isNativeIn: boolean,
    outputToken: Token,
    isNativeOut: boolean,
    amount: TokenAmount,
    isExactIn: boolean,
    maxHops: number,
    client: typeof baseClient,
    CHAIN_ID: ChainId,
    quoterAddress = v2QuoterSC
  ) {
    const BASES: Token[] = [WMAS, USDC, WETH].map((token) => token[CHAIN_ID]);

    // get all [Token, Token] combinations
    const allTokenPairs = PairV2.createAllTokenPairs(
      inputToken,
      outputToken,
      BASES
    );

    // get pairs
    const allPairs = PairV2.initPairs(allTokenPairs);

    // routes to consider in finding the best trade
    const allRoutes = RouteV2.createAllRoutes(
      allPairs,
      inputToken,
      outputToken,
      maxHops
    );

    const trades = await this.getTrades(
      isExactIn,
      allRoutes,
      amount,
      isExactIn ? outputToken : inputToken,
      isNativeIn,
      isNativeOut,
      client,
      CHAIN_ID,
      quoterAddress
    );

    const filteredTrades = trades.filter(
      (trade): trade is TradeV2 => trade !== undefined
    );
    return TradeV2.chooseBestTrade(filteredTrades, isExactIn);
  }

  private static async getTrades(
    isExactIn: boolean,
    routes: RouteV2[],
    tokenAmount: TokenAmount,
    otherToken: Token,
    isNativeIn: boolean,
    isNativeOut: boolean,
    client: typeof baseClient,
    chainId: ChainId,
    quoterAddress = v2QuoterSC,
    checkLegacy: boolean = true // checkLegacy = true to include legacy pairs
  ): Promise<(TradeV2 | undefined)[]> {
    const tokenIn = isExactIn ? tokenAmount.token : otherToken;
    const tokenOut = isExactIn ? otherToken : tokenAmount.token;

    const txs: Tx[] = routes.map((route) => {
      const routeStrArr = route.pathToStrArr();
      const args = new Args()
        .addArray(routeStrArr, ArrayTypes.STRING)
        .addU256(tokenAmount.raw);
      if (quoterAddress === v2QuoterSC) args.addBool(checkLegacy);
      return new Tx(
        isExactIn ? "findBestPathFromAmountIn" : "findBestPathFromAmountOut",
        args.serialize(),
        quoterAddress
      );
    });

    const quotes: Array<Quote | undefined> = await new IMulticall(
      multicallSC,
      client
    )
      .aggregateMulticall(txs)
      .then((res) => {
        const bs = new Args(res.value);
        return routes.map(
          () => new Quote().deserialize(bs.nextUint8Array()).instance
        );
      })
      .catch((err) => {
        console.log("Error fetching quotes:", err.message);
        const quoter = new IQuoter(quoterAddress, client);
        return Promise.all(
          routes.map(async (route) => {
            try {
              const methodName = isExactIn
                ? "findBestPathFromAmountIn"
                : "findBestPathFromAmountOut";
              const quote: Quote = await quoter[methodName](
                route.pathToStrArr(),
                tokenAmount.raw.toString(),
                checkLegacy
              );
              return quote;
            } catch (e) {
              console.log("Error fetching quote:", e);
              return undefined;
            }
          })
        );
      });

    const trades: Array<TradeV2 | undefined> = quotes.map((quote, i) => {
      try {
        if (!quote) return undefined;
        const trade: TradeV2 = new TradeV2(
          routes[i],
          tokenIn,
          tokenOut,
          quote,
          isExactIn,
          isNativeIn,
          isNativeOut
        );
        return trade;
      } catch (e) {
        console.log("Error:", e);
        return undefined;
      }
    });

    return trades.filter((trade) => !!trade && trade.outputAmount.raw > 0n);
  }
}

// const usdc = USDC[CHAIN_ID];
// QuoterHelper.findBestPath(
//   usdc,
//   false,
//   WETH[CHAIN_ID],
//   false,
//   new TokenAmount(usdc, parseUnits("1", usdc.decimals)),
//   true,
//   3,
//   baseClient,
//   CHAIN_ID
// ).then(console.log);
