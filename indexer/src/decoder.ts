import { Args, ArrayTypes } from "@massalabs/massa-web3";
import {
  EventDecoder,
  LimitOrder,
  LiquidityEventV2,
  SwapEvent,
  SwapEventV2,
} from "@dusalabs/sdk";
import { DCA, Order } from "@prisma/client";

export const decodeDcaTx = (
  params: Uint8Array
): Omit<DCA, "userAddress" | "txHash" | "id" | "status"> => {
  const args = new Args(params);
  const amountEachDCA = args.nextU256();
  const interval = Number(args.nextU64());
  const nbOfDCA = Number(args.nextU64());

  const tokenPathStr: string[] = args.nextArray(ArrayTypes.STRING);
  const tokenIn = tokenPathStr[0];
  const tokenOut = tokenPathStr[tokenPathStr.length - 1];

  const _threshold = args.nextU32();
  const _moreGas = args.nextBool();
  const startTimestamp = Date.now() + Number(args.nextU64());
  const duration = nbOfDCA == 0 ? 0 : (interval * (2 * nbOfDCA - 1)) / 2;
  const endTimestamp = startTimestamp + duration;

  return {
    amountEachDCA: amountEachDCA.toString(),
    interval,
    nbOfDCA,
    tokenIn,
    tokenOut,
    startTime: new Date(startTimestamp),
    endTime: new Date(endTimestamp),
  };
};

export const decodeUpdateDcaTx = (
  params: Uint8Array
): Omit<DCA, "userAddress" | "txHash" | "status" | "startTime" | "endTime"> => {
  const args = new Args(params);
  const id = Number(args.nextU64());
  const amountEachDCA = args.nextU256();
  const interval = Number(args.nextU64());
  const nbOfDCA = Number(args.nextU64());

  const tokenPathStr: string[] = args.nextArray(ArrayTypes.STRING);
  const tokenIn = tokenPathStr[0];
  const tokenOut = tokenPathStr[tokenPathStr.length - 1];

  return {
    id,
    amountEachDCA: amountEachDCA.toString(),
    interval,
    nbOfDCA,
    tokenIn,
    tokenOut,
  };
};

export const decodeOrderTx = (
  params: Uint8Array,
  functionName?: string,
  coins: bigint = 0n
): Omit<
  Order,
  | "userAddress"
  | "txHash"
  | "id"
  | "status"
  | "poolAddress"
  | "limitOrderAddress"
> => {
  const args = new Args(params);
  const orderType = args.nextU8();
  const binId = args.nextU64();

  let amount: bigint;
  if (functionName === "addLimitOrderMas") {
    const masSent = args.nextU64();
    amount = coins - masSent;
  } else {
    amount = args.nextU256();
  }

  return {
    amountIn: amount.toString(),
    binId: Number(binId),
    isSellOrder: orderType === 1n, // 0 = BID (false), 1 = ASK (true)
  };
};

export const decodeSwapEvents = (events: string[]): SwapEvent[] => {
  return events.reduce((prev, event) => {
    prev.push(EventDecoder.decodeSwap(event));
    return prev;
  }, [] as SwapEvent[]);
};
export const decodeSwapV2Events = (events: string[]): SwapEventV2[] => {
  return events.reduce((prev, event) => {
    prev.push(EventDecoder.decodeSwapV2(event));
    return prev;
  }, [] as SwapEventV2[]);
};

type ComputedSwaps = {
  startId: number;
  endId: number;
  ids: number[];
  swapForY: boolean;
  amountIn: bigint;
  amountOut: bigint;
  feesIn: bigint;
  volatilityAccumulated: number;
};
export const computeSwapEvents = (events: SwapEvent[]): ComputedSwaps => {
  const { activeId: endId, swapForY } = events[events.length - 1];
  const { activeId: startId } = events[0];
  const feesIn = events.reduce((prev, event) => prev + event.feesTotal, 0n);
  const amountIn = events.reduce(
    (prev, { amountInToBin }) => prev + amountInToBin,
    feesIn
  );
  const amountOut = events.reduce(
    (prev, { amountOutOfBin }) => prev + amountOutOfBin,
    0n
  );
  const volatilityAccumulated = events.reduce(
    (prev, { volatilityAccumulated }) => prev + volatilityAccumulated,
    0
  );
  const ids = events.map(({ activeId }) => activeId);
  return {
    startId,
    endId,
    ids,
    swapForY,
    amountIn,
    amountOut,
    feesIn,
    volatilityAccumulated,
  };
};
export const computeSwapV2Events = (events: SwapEventV2[]): ComputedSwaps => {
  let feesIn = 0n;
  let amountIn = 0n;
  let ids: number[] = [];
  for (const event of events) {
    const _feesIn = event.feesTotal.reduce((prev, fee) => prev + fee, 0n);
    const _amountIn = event.amountsIn.reduce(
      (prev, amount) => prev + amount,
      feesIn
    );
    ids.push(...event.ids);
    feesIn += _feesIn;
    amountIn += _amountIn;
  }
  const event = events[events.length - 1];
  return {
    ...event,
    endId: event.activeId,
    amountIn,
    ids,
    feesIn,
  };
};

type ComputedLiquidity = {
  amountX: bigint;
  amountY: bigint;
  lowerBound: number;
  upperBound: number;
};
export const decodeComputeLiquidityEvents = (events: string[]) => {
  return events.reduce(
    (prev, event) => {
      const decoded = EventDecoder.decodeLiquidity(event);

      prev.amountX += decoded.amountX;
      prev.amountY += decoded.amountY;
      prev.lowerBound = Math.min(prev.lowerBound, decoded.id);
      prev.upperBound = Math.max(prev.upperBound, decoded.id);

      return prev;
    },
    { amountX: 0n, amountY: 0n, lowerBound: +Infinity, upperBound: -Infinity }
  );
};
export const computeLiquidityV2Event = (
  event: LiquidityEventV2
): ComputedLiquidity => {
  return {
    ...event,
    lowerBound: event.startId,
    upperBound: event.endId,
  };
};
