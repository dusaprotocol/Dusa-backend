import {
  adjustPrice,
  cache,
  calculateUSDValue,
  getCallee,
  getPriceFromId,
  isDepositEvent,
  isDepositV2Event,
  isSwapEvent,
  isSwapV1Event,
  roundFraction,
  toFraction,
} from "../../common/methods";
import {
  computeLiquidityV2Event,
  computeSwapEvents,
  computeSwapV2Events,
  decodeComputeLiquidityEvents,
  decodeSwapEvents,
  decodeSwapV2Events,
} from "./decoder";
import {
  EventDecoder,
  Fraction,
  SwapSettings,
  Token,
  TokenAmount,
} from "@dusalabs/sdk";
import {
  createSwap,
  createLiquidity,
  createDCA,
  findDCA,
  updateDCAStatus,
  updateMakerFees,
  updateBinVolume,
  getTokenFromAddress,
  updatePrice,
  getLedgerEntries,
  updateVolume,
  getLedgerEntries2,
  MakerFeesDate,
} from "./db";
import { ONE_DAY, ONE_MINUTE, ONE_WEEK, wait } from "../../common/utils";
import { ScExecutionEvent } from "../gen/ts/massa/model/v1/execution";
import { Args, bytesToStr } from "@massalabs/massa-web3";
import { Pool_version, Status } from "@prisma/client";
import { handlePrismaError, prisma } from "../../common/db";
import logger from "../../common/logger";
import { fetchDCA } from "../../common/datastoreFetcher";
import { getEventTimestamp } from "./utils";
import * as gRPC from "./grpc";
import { sendDiscordAlert } from "../../common/discord";
import {
  masUsdcPairV1,
  ROUTERS,
  routerSC,
  stableEthPairV1,
  stableEthPairV2,
  stablePairs,
  TOKENS,
  usdcDaiPairV1,
  usdcDaiPairV2,
  usdcUsdtPairV1,
  usdcUsdtPairV2,
} from "../../common/contracts";
import { ILBPair } from "./grpcSDK/base";
import { baseClient } from "./client";
import { getTokenValue } from "../datastoreFetcher";
import { MAX_BINS_PER_EVENT } from "../../common/config";

export const processInnerSwap = async (params: {
  event: ScExecutionEvent;
  callStack: string[];
  blockId: string;
  i: number;
  opts?: ProcessOptions;
}) => {
  const { event, callStack, blockId, i, opts } = params;
  const eventData = bytesToStr(event.data);
  const poolAddress = getCallee(callStack);
  const tokens = await fGetTokens(poolAddress);
  const version: Pool_version = eventData.startsWith("SWAP:") ? "V1" : "V2";
  const { swapForY } =
    version === "V1"
      ? EventDecoder.decodeSwap(eventData)
      : EventDecoder.decodeSwapV2(eventData);
  const tokenInAddress = swapForY ? tokens[0] : tokens[1];
  const tokenOutAddress = swapForY ? tokens[1] : tokens[0];
  const binStep = await fBinStep(poolAddress);
  const userAddress = callStack.some((c) => ROUTERS.includes(c))
    ? callStack[callStack.length - 3]
    : callStack[callStack.length - 2];

  return processSwap({
    poolAddress,
    version,
    tokenInAddress,
    tokenOutAddress,
    tokenYAddress: tokens[1],
    binStep,
    swapEvents: [eventData],
    txHash: blockId,
    indexInSlot: i,
    timestamp: getEventTimestamp(event),
    userAddress,
    opts,
  });
};

export type ProcessOptions = {
  tokenValues: number[];
};

export const processSwap = async (params: {
  txHash: string;
  indexInSlot: number;
  userAddress: string;
  timestamp: string | Date;
  poolAddress: string;
  version: Pool_version;
  tokenInAddress: string;
  tokenOutAddress: string;
  tokenYAddress: string;
  binStep: number;
  swapEvents: string[];
  swapParams?: SwapSettings;
  opts?: ProcessOptions;
}) => {
  // prettier-ignore
  const { txHash, userAddress, timestamp, poolAddress, version, swapEvents, indexInSlot, binStep, tokenInAddress, tokenOutAddress, tokenYAddress, opts } = params;

  const swapPayload =
    version === "V1"
      ? computeSwapEvents(decodeSwapEvents(swapEvents))
      : computeSwapV2Events(decodeSwapV2Events(swapEvents));
  const binIds = swapPayload.ids;

  const [tokenIn, tokenOut] = await Promise.all(
    [tokenInAddress, tokenOutAddress].map(getTokenFromAddress)
  );
  const swapForY = tokenOut.address === tokenYAddress;

  const tokenX = swapForY ? tokenIn : tokenOut;
  const tokenY = swapForY ? tokenOut : tokenIn;
  const tokenXIndex = TOKENS.findIndex((t) => t === tokenX.address);
  const tokenYIndex = TOKENS.findIndex((t) => t === tokenY.address);
  const [tokenXValue, tokenYValue] = opts
    ? [opts.tokenValues[tokenXIndex], opts.tokenValues[tokenYIndex]]
    : await Promise.all([tokenX, tokenY].map(getTokenValue));
  const tokenInValue = swapForY ? tokenXValue : tokenYValue;

  const swapValue = calculateSwapValue({
    tokenIn,
    valueIn: tokenInValue,
    ...swapPayload,
  });

  const swap = await createSwap({
    ...swapPayload,
    timestamp,
    txHash,
    token0Value: tokenXValue,
    token1Value: tokenYValue,
    usdValue: swapValue.volume,
    feesUsdValue: swapValue.fees,
    poolAddress,
    version,
    token0: tokenX,
    token1: tokenY,
    binStep,
    userAddress,
    indexInSlot,
    amountIn: swapPayload.amountIn.toString(),
    amountOut: swapPayload.amountOut.toString(),
    feesIn: swapPayload.feesIn.toString(),
  });
  if (!swap) return { swapValue, swapPayload };

  // update chart data
  const price = adjustPrice(
    getPriceFromId(swapPayload.endId, binStep),
    tokenX.decimals,
    tokenY.decimals
  );
  updatePrice(poolAddress, price, timestamp);
  if (opts)
    // only when reprocessing
    updateVolume(poolAddress, swapValue.volume, swapValue.fees, timestamp);

  let binSupplies: bigint[] = [];
  if (!opts)
    binSupplies = await new ILBPair(poolAddress, baseClient).getSupplies(
      binIds
    );
  else {
    const r = await getLedgerEntries2(
      poolAddress,
      new Date(timestamp),
      binIds.map((id) => `total_supplies::${id}`)
    );
    binSupplies = r.map((e) => (e.value ? new Args(e.value).nextU256() : 0n));
  }
  for (let i = 0; i < binIds.length; i++) {
    const binSupply = binSupplies[i];

    const v2BinIndexInEvent = i % MAX_BINS_PER_EVENT;
    const v2EventIndex = Math.trunc(i / MAX_BINS_PER_EVENT);
    const v2Event = swapEvents[v2EventIndex];
    const amountInToBin =
      version === "V1"
        ? EventDecoder.decodeSwap(swapEvents[i]).amountInToBin
        : EventDecoder.decodeSwapV2(v2Event).amountsIn[v2BinIndexInEvent];
    const feesTotal =
      version === "V1"
        ? EventDecoder.decodeSwap(swapEvents[i]).feesTotal
        : EventDecoder.decodeSwapV2(v2Event).feesTotal[v2BinIndexInEvent];
    const binId = binIds[i];

    const { volume: volumeUsd, fees: feesUsd } = calculateSwapValue({
      tokenIn,
      valueIn: tokenInValue,
      amountIn: amountInToBin,
      feesIn: feesTotal,
    });

    // update bin volume
    updateBinVolume({ binId, feesUsd, volumeUsd, poolAddress }, timestamp)
      .then(() =>
        prisma.swap
          .update({
            where: { txHash_indexInSlot: { txHash, indexInSlot } },
            data: { updatedBinVolume: true },
          })
          .catch(handlePrismaError)
      )
      .catch((e) => logger.error(e));

    // update maker rewards
    processFee({
      poolAddress,
      binId,
      volumeUsd,
      binSupply,
      feesTotal,
      swapForY,
      binStep,
      tokenY,
      tokenYValue,
      timestamp,
      opts,
    })
      .then((res) => {
        prisma.swap
          .update({
            where: { txHash_indexInSlot: { txHash, indexInSlot } },
            data: { updatedMakerFees: true },
          })
          .catch(handlePrismaError);
        return res;
      })
      .catch((e) => logger.error(e));
  }

  sendDiscordAlert(swap);
  return { swapValue, swapPayload };
};

export const processFee = async (params: {
  poolAddress: string;
  binId: number;
  volumeUsd: number;
  binSupply: bigint;
  feesTotal: bigint;
  swapForY: boolean;
  binStep: number;
  tokenY: Token;
  tokenYValue: number;
  timestamp: string | Date;
  opts?: ProcessOptions & { bulk?: boolean };
}): Promise<MakerFeesDate[]> => {
  // prettier-ignore
  const { poolAddress, binId, volumeUsd, binSupply, feesTotal, swapForY, binStep, tokenY, tokenYValue, timestamp, opts } = params;
  const protocolShare = await fProtocolShare(poolAddress); // base 10000
  const makerShare = 10_000 - protocolShare;

  const prefix = `balances::${binId}:`;
  let makers: string[] = [];
  let balances: bigint[] = [];
  if (opts) {
    const r = await getLedgerEntries(poolAddress, new Date(timestamp), prefix);
    makers = r.map((e) => e.key191Chars.split(prefix)[1]);
    balances = r.map((e) => new Args(e.value).nextU256());
  } else {
    makers = await gRPC
      .getDatastoreKeys(poolAddress, prefix)
      .then((r) => r.map((k) => k.split(prefix)[1]))
      .catch(() => []);
    balances = await new ILBPair(poolAddress, baseClient).balanceOfBatch(
      makers,
      Array.from({ length: makers.length }, () => binId)
    );
  }

  const isStablePair = stablePairs.includes(poolAddress);
  const isStableBin =
    ([usdcUsdtPairV1, usdcDaiPairV1, usdcUsdtPairV2, usdcDaiPairV2].includes(
      poolAddress
    ) &&
      binId === 8112284) ||
    ([stableEthPairV1, stableEthPairV2].includes(poolAddress) &&
      binId === 8388608);

  const res: MakerFeesDate[] = [];
  for (let j = 0; j < makers.length; j++) {
    const maker = makers[j];
    const balance = balances[j];

    // Check if balance is defined and not zero
    if (!balance) continue;

    const share = new Fraction(balance).divide(binSupply);
    const makerVolume = roundFraction(share.multiply(toFraction(volumeUsd)));
    const accruedFees = share.multiply(feesTotal).quotient;
    const accruedFeesX = swapForY ? accruedFees : 0n;
    const accruedFeesY = swapForY ? 0n : accruedFees;
    const price = getPriceFromId(binId, binStep);
    const accruedFeesL = swapForY
      ? new Fraction(accruedFeesX).multiply(toFraction(price)).quotient
      : accruedFeesY;
    const accruedFeesUsd = roundFraction(
      new TokenAmount(tokenY, accruedFeesL).multiply(toFraction(tokenYValue))
    );
    if (accruedFeesUsd === 0) continue;

    const accruedFeesUsdEffective =
      ((isStablePair && !isStableBin ? 0 : accruedFeesUsd) * makerShare) /
      10_000;
    if (opts?.bulk) {
      res.push({
        accruedFeesUsdEffective,
        accruedFeesUsd,
        accruedFeesL: accruedFeesL.toString(),
        accruedFeesX: accruedFeesX.toString(),
        accruedFeesY: accruedFeesY.toString(),
        address: maker,
        poolAddress,
        volume: makerVolume,
        date: timestamp,
      });
      continue;
    }
    await updateMakerFees(
      {
        accruedFeesUsdEffective,
        accruedFeesUsd,
        accruedFeesL: accruedFeesL.toString(),
        accruedFeesX: accruedFeesX.toString(),
        accruedFeesY: accruedFeesY.toString(),
        address: maker,
        poolAddress,
        volume: makerVolume,
      },
      timestamp
    ).catch((e) => logger.error(e));
  }

  return res;
};

export const processLiquidity = async (params: {
  txHash: string;
  userAddress: string;
  timestamp: string | Date;
  poolAddress: string;
  version: Pool_version;
  token0Address: string;
  token1Address: string;
  tokenYAddress: string;
  liqEvents: string[];
  feeEvent?: string;
  opts?: ProcessOptions;
}) => {
  // prettier-ignore
  const { txHash, userAddress, timestamp, poolAddress, version, liqEvents, token0Address, token1Address, tokenYAddress, feeEvent, opts } = params;
  const {
    amountX: amountXAbs,
    amountY: amountYAbs,
    lowerBound,
    upperBound,
  } = version === "V1"
    ? decodeComputeLiquidityEvents(liqEvents)
    : computeLiquidityV2Event(EventDecoder.decodeLiquidityV2(liqEvents[0]));

  const isAdd = isDepositEvent(liqEvents[0]) || isDepositV2Event(liqEvents[0]);
  const [amountX, amountY] = isAdd
    ? [amountXAbs, amountYAbs]
    : [-amountXAbs, -amountYAbs];

  const tokenXAddress =
    token1Address === tokenYAddress ? token0Address : token1Address;
  const [tokenX, tokenY] = await Promise.all(
    [tokenXAddress, tokenYAddress].map(getTokenFromAddress)
  );
  const tokenXIndex = TOKENS.findIndex((t) => t === tokenX.address);
  const tokenYIndex = TOKENS.findIndex((t) => t === tokenY.address);
  const [tokenXValue, tokenYValue] = opts
    ? [opts.tokenValues[tokenXIndex], opts.tokenValues[tokenYIndex]]
    : await Promise.all([tokenX, tokenY].map(getTokenValue));

  const usdValue = calculateUSDValue(
    new TokenAmount(tokenX, amountX),
    tokenXValue,
    new TokenAmount(tokenY, amountY),
    tokenYValue
  );

  const binStep = await fBinStep(poolAddress);

  const liq = await createLiquidity({
    amount0: amountX.toString(),
    amount1: amountY.toString(),
    upperBound,
    lowerBound,
    timestamp,
    txHash,
    usdValue,
    poolAddress,
    version,
    token0: tokenX,
    token1: tokenY,
    binStep,
    userAddress,
    token0Value: tokenXValue,
    token1Value: tokenYValue,
  });
  if (!liq) return;

  sendDiscordAlert(liq);
  if (!feeEvent) return;

  const decoded = EventDecoder.decodeCompositionFee(feeEvent);
  const compositionFeeUsd = calculateUSDValue(
    new TokenAmount(tokenX, decoded.activeFeeX),
    tokenXValue,
    new TokenAmount(tokenY, decoded.activeFeeY),
    tokenYValue
  );
  const binSupply = await new ILBPair(poolAddress, baseClient)
    .getSupplies([decoded.id])
    .then((r) => r[0]);

  // logger.info(`$${usdValue} ($${compositionFeeUsd} composition fee)`);
  // TODO: update bin/pool volume

  // TODO: update analytics fees
  processFee({
    binId: decoded.id,
    binStep,
    tokenY,
    binSupply,
    feesTotal: decoded.activeFeeX || decoded.activeFeeY,
    poolAddress,
    swapForY: decoded.activeFeeX !== 0n,
    tokenYValue,
    volumeUsd: compositionFeeUsd,
    timestamp,
    opts,
  });
};

export const processDCAExecution = async (
  eventData: string,
  blockInfo: { thread: number; period: number; blockId: string },
  now = Date.now()
) => {
  const { amountOut, id, user } = EventDecoder.decodeDCAExecution(eventData);
  const dca = await findDCA(id).then(async (res) => {
    if (res) return res;

    await wait(ONE_MINUTE / 2);
    const resRetry = await findDCA(id);
    if (resRetry) return resRetry;

    return fetchDCA(id, user).then(async (_dca) => {
      await createDCA(_dca);
      return { ..._dca, execution: [] };
    });
  });
  if (!dca) return;

  const [tokenIn, tokenOut] = await Promise.all(
    [dca.tokenIn, dca.tokenOut].map(getTokenFromAddress)
  );
  const [tokenInValue, tokenOutValue] = await Promise.all(
    [tokenIn, tokenOut].map(getTokenValue)
  );

  prisma.dCAExecution
    .create({
      data: {
        ...blockInfo,
        tokenInValue,
        tokenOutValue,
        amountIn: dca.amountEachDCA,
        amountOut: amountOut.toString(),
        dcaId: id,
      },
    })
    .catch(handlePrismaError);

  const nbExecutions = dca.execution.length + 1;
  if (
    dca.nbOfDCA === nbExecutions ||
    (dca.endTime.getTime() !== dca.startTime.getTime() &&
      dca.endTime.getTime() < now)
  )
    await updateDCAStatus(id, Status.ENDED);
};

export const processOrderExecution = async (
  eventData: string,
  loSC: string,
  blockInfo: { thread: number; period: number; blockId: string }
) => {
  const { ids } = EventDecoder.decodeLimitOrderExecution(eventData);
  const orders = await prisma.order
    .findMany({
      where: {
        binId: { in: ids },
        limitOrderAddress: loSC,
      },
    })
    .then((res) => res.filter((o) => o.status === "ACTIVE"));

  if (orders.length === 0) return;

  await prisma.orderExecution
    .createMany({
      data: orders.map((order) => ({
        amountIn: order.amountIn,
        orderId: order.id,
        limitOrderAddress: loSC,
        ...blockInfo,
      })),
    })
    .catch(handlePrismaError);
  // only the orders executed on this limit order contract (same-bin orders on other
  // LO contracts, or already cancelled ones, must keep their status)
  await prisma.order.updateMany({
    where: {
      id: { in: orders.map((o) => o.id) },
      limitOrderAddress: loSC,
    },
    data: {
      status: "ENDED",
    },
  });
};

// HELPERS

const calculateSwapValue = (params: {
  tokenIn: Token;
  valueIn: number;
  amountIn: bigint;
  feesIn: bigint;
}) => {
  const { tokenIn, valueIn, amountIn, feesIn } = params;
  const [volume, fees] = [amountIn, feesIn].map((v) =>
    roundFraction(new TokenAmount(tokenIn, v).multiply(toFraction(valueIn)))
  );
  return { volume, fees };
};

const _fBinStep = async (pAddress: string) =>
  new ILBPair(pAddress, baseClient).feeParameters().then((r) => r.binStep);
const fBinStep = cache(_fBinStep, { ttl: ONE_WEEK / 1000 });
const _fProtocolShare = async (pAddress: string) =>
  new ILBPair(pAddress, baseClient)
    .feeParameters()
    .then((r) => r.protocolShare);
const fProtocolShare = cache(_fProtocolShare, { ttl: ONE_WEEK / 1000 });
const _fGetTokens = async (pAddress: string) =>
  new ILBPair(pAddress, baseClient).getTokens();
const fGetTokens = cache(_fGetTokens, { ttl: ONE_WEEK / 1000 });
