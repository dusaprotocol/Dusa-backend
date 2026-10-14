import { Event, Prisma, PrismaClient, Swap } from "@prisma/client";
import { prisma } from "../../common/db";
import {
  processSignedOperation,
  ProcessSignedOperationOptions,
} from "../../indexer/src/helpers";
import { MASSA_EXEC_ERROR } from "../../common/eventPoller";
import { Args } from "@massalabs/massa-web3";
import {
  getDailyTick,
  getHourlyTick,
  ONE_DAY,
  ONE_MINUTE,
  ONE_WEEK,
  parseTimestamp,
  wait,
} from "../../common/utils";
import {
  EventDecoder,
  SWAP_ROUTER_METHODS,
  SwapEvent,
  SwapEventV2,
  SwapRouterMethod,
} from "@dusalabs/sdk";
import {
  OperationType,
  SignedOperation,
} from "../../indexer/gen/ts/massa/model/v1/operation";
import {
  masEthPairV1,
  masUsdcPairV1,
  routerSC,
  usdcUsdtPairV1,
  stableEthPairV1,
  TOKENS,
  masEthPairV2,
  masUsdcPairV2,
  stableEthPairV2,
  usdcUsdtPairV2,
  ROUTERS,
} from "../../common/contracts";
import { fetchTokenValueAtTimestamp } from "../../api/src/coingecko";
import { processFee, processInnerSwap } from "../../indexer/src/socket";
import {
  getLedgerEntries2,
  MakerFees,
  MakerFeesDate,
} from "../../indexer/src/db";
import {
  cache,
  isSwapEvent,
  isSwapV1Event,
  isSwapV2Event,
  printAddress,
  toToken,
} from "../../common/methods";
import { getOperations, getOperationsGenerator, Operation } from "./backup";
import { ScExecutionEvent } from "../../indexer/gen/ts/massa/model/v1/execution";
import { transformEvent2 } from "../../indexer/src/utils";
import { SCOutputEvent } from "@massalabs/massa-web3/dist/esm/generated/client-types";

type Swapp = Swap & {
  poolAddress: string;
  token0Address: string;
  token1Address: string;
};
type Transaction = Prisma.OperationGetPayload<{
  include: { events: true };
}>;

// HELPERS

const transformEvent = (e: Event, tx: Transaction): SCOutputEvent => {
  const slot = parseTimestamp(tx.createdAt.getTime());
  return {
    context: {
      block: tx.blockId,
      call_stack: [e.emitterAddress],
      index_in_slot: e.indexInSlot,
      origin_operation_id: tx.id,
      slot: { ...slot, period: Number(slot.period) },
      is_error: false,
      is_final: true,
      read_only: false,
    },
    data: e.data.toString(),
  };
};

const updateMakerFeesBulk = async (params: MakerFeesDate[]) => {
  type X = Prisma.MakerCreateManyInput[];
  const updateFees = (current: string, increment: string) =>
    (BigInt(current) + BigInt(increment)).toString();

  const data: X = params.map((p) => ({
    ...p,
    date: getHourlyTick(p.date),
  }));

  // merge entries with the same date/poolAddress/address
  const merged: X = [];
  for (const d of data) {
    const existing = merged.find(
      (m) =>
        new Date(m.date).getTime() === new Date(d.date).getTime() &&
        m.poolAddress === d.poolAddress &&
        m.address === d.address
    );
    if (existing) {
      existing.accruedFeesUsdEffective =
        (existing.accruedFeesUsdEffective || 0) +
        (d.accruedFeesUsdEffective || 0);
      existing.accruedFeesUsd += d.accruedFeesUsd;
      existing.accruedFeesL = updateFees(existing.accruedFeesL, d.accruedFeesL);
      existing.accruedFeesY = updateFees(existing.accruedFeesY, d.accruedFeesY);
      existing.accruedFeesX = updateFees(existing.accruedFeesX, d.accruedFeesX);
    } else {
      merged.push({ ...d });
    }
  }
  console.log(`Merged ${data.length} entries into ${merged.length}.`);

  await prisma.maker.createMany({ data: merged });
};

const _fPool = async (pAddress: string) =>
  prisma.pool.findUniqueOrThrow({
    include: { token0: true, token1: true },
    where: { address: pAddress },
  });
const fBinStep = cache(_fPool, { ttl: ONE_WEEK / 1000 });

// MAIN

// Tx record with swap record but no full swap record
async function backfillFullSwaps(i: number) {
  // Step 1: G
  const limit = 50000;
  const allSwaps = await prisma.$queryRaw<Swapp[]>`
    SELECT * FROM Swap
    INNER JOIN Pool ON Swap.poolAddress = Pool.address
    ORDER BY timestamp ASC
    LIMIT ${limit} OFFSET ${i * limit}
  `;
  const uniqueTxHashes = new Set(allSwaps.map((s) => s.txHash));
  console.log(`Found ${allSwaps.length} total Swap records.`);
  console.log(`Found ${uniqueTxHashes.size} unique txHashes.`);

  // Step 2: For each txHash, load all Swap records and aggregate
  let count = 0;
  const dataToInsert: Prisma.FullSwapCreateManyArgs["data"] = [];
  for (const txHash of uniqueTxHashes) {
    count++;
    console.log(count, txHash);

    const _swaps = allSwaps.filter((s) => s.txHash === txHash);
    // sort by indexInSlot ASC
    const swaps = _swaps.sort((a, b) => a.indexInSlot - b.indexInSlot);

    // Step 3: Derive FullSwap fields
    const firstSwap = swaps[0];
    const lastSwap = swaps[swaps.length - 1];

    const tokenIn = firstSwap.swapForY
      ? firstSwap.token0Address
      : firstSwap.token1Address;
    const tokenOut = lastSwap.swapForY
      ? lastSwap.token1Address
      : lastSwap.token0Address;

    const feesIn = firstSwap.feesIn;
    const totalFeesUsdValue = swaps.reduce((acc, s) => acc + s.feesUsdValue, 0);
    const timestamp = firstSwap.timestamp;
    const amountIn = firstSwap.amountIn;
    const amountOut = lastSwap.amountOut;
    const userAddress = firstSwap.userAddress;

    const data = {
      txHash,
      tokenIn,
      tokenOut,
      amountIn,
      amountOut,
      timestamp,
      userAddress,
      feesIn,
      feesUsdValue: totalFeesUsdValue,
      usdValue: firstSwap.usdValue,
    };
    const item = { data };

    dataToInsert.push(data);
  }

  await prisma.fullSwap
    .createMany({ data: dataToInsert })
    .then((res) => console.log(`Inserted ${res.count} FullSwap records.`))
    .catch((err) => {
      if (err instanceof Prisma.PrismaClientKnownRequestError) {
        console.log(err.message, err.code);
      }
    });
}

const swapMethods = SWAP_ROUTER_METHODS as unknown as string[];
// Tx record with events but no swap record
export async function backfillTxs(until = ONE_DAY) {
  const from = new Date(Date.now() - until);
  const to = new Date();
  console.time("database");
  const txs = await prisma.operation.findMany({
    include: { events: true },
    where: {
      createdAt: { gte: from, lte: to },
      targetAddress: { in: ROUTERS },
      targetFunction: { in: swapMethods },
    },
  });
  const swaps = await prisma.swap.findMany({
    where: { txHash: { in: txs.map((t) => t.id) } },
  });
  // Filter out txs that either have already been processed or have error events
  const filteredTxs = txs.filter(
    (t) =>
      swaps.every((s) => s.txHash !== t.id) &&
      !t.events.some((e) => e.data.includes(MASSA_EXEC_ERROR))
  );
  console.timeEnd("database");
  console.log(`Found ${txs.length} txs, ${filteredTxs.length} missing swaps.`);
  let count = 0;
  for (const tx of filteredTxs) {
    count++;
    const tokenValues = await Promise.all(
      TOKENS.map((t) =>
        fetchTokenValueAtTimestamp(t, tx.createdAt).catch(() => 0)
      )
    );

    const events = tx.events;
    const opts: ProcessSignedOperationOptions = {
      events: events.map((e) => transformEvent(e, tx)),
      tokenValues,
    };

    const op: OperationType = {
      type: { oneofKind: "callSc", callSc: { ...tx, parameter: tx.data } },
    };
    const signedOp: SignedOperation = {
      contentCreatorAddress: tx.callerAddress,
      contentCreatorPubKey: "",
      secureHash: tx.id,
      serializedSize: 0n,
      signature: "",
      content: { expirePeriod: 0n, fee: { mantissa: 0n, scale: 0 }, op },
    };

    console.log(`Processing tx ${tx.id}...`, count + "/" + filteredTxs.length);
    await processSignedOperation(signedOp, tx.indexInBlock, tx.blockId, opts);
    console.log(`Processed tx ${tx.id}.`);
    console.log();

    await wait(5000);
    // return;
  }
}

// Tx record with swap record but null token values
async function backfillNullSwaps() {
  const from = new Date(Date.now() - ONE_DAY);
  const to = new Date();
  console.time("database");
  const swaps = await prisma.swap.findMany({
    where: {
      timestamp: { gte: from, lte: to },
      poolAddress: {
        in: [
          masUsdcPairV1,
          masUsdcPairV2,
          masEthPairV1,
          masEthPairV2,
          usdcUsdtPairV1,
          usdcUsdtPairV2,
          stableEthPairV1,
          stableEthPairV2,
        ],
      },
      OR: [{ token0Value: 0 }, { token1Value: 0 }],
    },
  });
  const filteredTxs = await prisma.operation.findMany({
    include: { events: true },
    where: { id: { in: swaps.map((s) => s.txHash) } },
  });
  console.timeEnd("database");
  console.log(`Found ${swaps.length} swaps.`);
  let count = 0;
  return;
  for (const tx of filteredTxs) {
    count++;
    const tokenValues = await Promise.all(
      TOKENS.map((t) =>
        fetchTokenValueAtTimestamp(t, tx.createdAt).catch(() => 0)
      )
    );

    const events = tx.events;
    const opts: ProcessSignedOperationOptions = {
      events: events.map((e) => transformEvent(e, tx)),
      tokenValues,
    };

    const op: OperationType = {
      type: { oneofKind: "callSc", callSc: { ...tx, parameter: tx.data } },
    };
    const signedOp: SignedOperation = {
      contentCreatorAddress: tx.callerAddress,
      contentCreatorPubKey: "",
      secureHash: tx.id,
      serializedSize: 0n,
      signature: "",
      content: { expirePeriod: 0n, fee: { mantissa: 0n, scale: 0 }, op },
    };

    console.log(`Processing tx ${tx.id}...`, count + "/" + filteredTxs.length);
    await processSignedOperation(signedOp, tx.indexInBlock, tx.blockId, opts);
    console.log(`Processed tx ${tx.id}.`);
    console.log();

    await wait(5000);
    // return;
  }
}

// Tx record with swap record but null maker fees
async function backfillMakerRewards(poolAddress?: string) {
  const from = new Date(Date.now() - ONE_DAY * 4);
  const to = new Date();
  console.log(to.getTime() - from.getTime());
  console.time("database");
  const swaps = await prisma.swap.findMany({
    where: {
      timestamp: { gte: from, lte: to },
      // feesUsdValue: { gt: 0.05 },
      poolAddress,
    },
  });
  const txs = await prisma.operation.findMany({
    include: { events: true },
    where: { id: { in: swaps.map((s) => s.txHash) } },
  });
  console.timeEnd("database");
  console.log(`Found ${swaps.length} swaps.`);

  let count = 0;
  const bulk: MakerFeesDate[] = [];
  for (const swap of swaps) {
    count++;
    console.log(
      `Processing swap ${swap.txHash}...`,
      count + "/" + swaps.length
    );

    const tx = txs.find((t) => t.id === swap.txHash);
    if (!tx) continue;

    const pool = await _fPool(swap.poolAddress);

    const events = tx.events.map((e) => transformEvent(e, tx));
    const swapEventsV1 = events
      .filter((e) => isSwapV1Event(e, swap.poolAddress))
      .map((e) => EventDecoder.decodeSwap(e.data));
    const swapEventsV2 = events
      .filter((e) => isSwapV2Event(e, swap.poolAddress))
      .map((e) => EventDecoder.decodeSwapV2(e.data));
    const swapEvents = [...swapEventsV1, ...swapEventsV2];
    const {
      startId,
      endId,
      poolAddress,
      usdValue,
      token0Value,
      token1Value,
      timestamp,
    } = swap;
    // console.log(timestamp);
    if (!token0Value || !token1Value)
      throw new Error("tokenValue is undefined");

    const binIds = Array.from(
      { length: endId - startId + 1 },
      (_, i) => i + startId
    );
    const r = await getLedgerEntries2(
      poolAddress,
      new Date(timestamp),
      binIds.map((id) => `total_supplies::${id}`)
    );
    const binSupplies = r.map((e) =>
      e.value ? new Args(e.value).nextU256() : 0n
    );

    const tokenY = toToken(pool.token1);
    const tokenYValue = token1Value;

    const tokenValues = Array.from({ length: TOKENS.length }, () => 0);
    const token0Index = TOKENS.findIndex((t) => t === pool.token0.address);
    const token1Index = TOKENS.findIndex((t) => t === pool.token1.address);
    if (token0Index === -1 || token1Index === -1)
      throw new Error("token not found");
    tokenValues[token0Index] = token0Value;
    tokenValues[token1Index] = token1Value;

    for (let i = startId; i <= endId; i++) {
      const binSupply = binSupplies[i - startId];
      const swapEvent = swapEvents.find((e) => e.activeId === i);
      if (!swapEvent) continue;

      let feesTotal: bigint = 0n;
      const isEventV1 = (e: SwapEvent | SwapEventV2): e is SwapEvent =>
        typeof e.feesTotal === "bigint";
      const isSwapV1 = isEventV1(swapEvent);
      if (isSwapV1) feesTotal = swapEvent.feesTotal;
      else feesTotal = swapEvent.feesTotal.reduce((a, b) => a + b, 0n);

      processFee({
        ...swap,
        binId: i,
        poolAddress,
        binStep: pool.binStep,
        volumeUsd: usdValue,
        binSupply,
        feesTotal,
        tokenY,
        tokenYValue,
        opts: { tokenValues, bulk: true },
      }).then((res) => bulk.push(...res));
    }

    // console.log(`Processed swap ${swap.txHash}.`);
    console.log();

    await wait(300);
  }

  await updateMakerFeesBulk(bulk);
}

// No tx record
async function backfillMissingTxs() {
  const from = new Date(Date.now() - ONE_DAY);
  const to = new Date();
  console.time("database");
  const indexedTxs = await prisma.operation.findMany({
    where: {
      createdAt: { gte: from, lte: to },
      targetAddress: { in: ROUTERS },
      targetFunction: { in: swapMethods },
    },
  });

  const allTxs: Operation[] = [];
  const generator = getOperationsGenerator(routerSC, { beyond: from });
  for await (const operation of generator) {
    const createdAt = Number(operation.block_time);
    if (createdAt < to.getTime() && createdAt > from.getTime()) {
      allTxs.push(operation);
    }
  }
  const allTxsHashes = allTxs.map((t) => t.hash);
  const allTxsBlockIds = await prisma.block
    .findMany({
      select: { id: true },
      where: {
        createdAt: { gte: from, lte: to },
        operations: { some: { id: { in: allTxsHashes } } },
      },
    })
    .then((res) => res.map((b) => b.id));
  console.timeEnd("database");
  console.log(`Found ${allTxs.length} txs, ${allTxsBlockIds.length} blockIds.`);

  const events = await prisma.event.findMany({
    // where: { operationId: { startsWith: "B" } }, // events
    where: { operationId: { in: allTxsBlockIds } }, // events
  });
  console.log(events.length);
  // Filter out txs that have already been processed
  const filteredTxs = allTxs.filter((t) =>
    indexedTxs.every((s) => s.id !== t.hash)
  );
  console.log(`Found ${allTxs.length} txs, ${filteredTxs.length} missing txs.`);
  let count = 0;
  return;
}

// Inner swaps
async function backfillInnerSwaps() {
  // const from = new Date(1734951600_000);
  // const to = new Date(1734994800_000);
  const logs = await prisma.log.findMany({
    where: { message: Buffer.from("Inner swap") },
  });

  let sumVolume = 0;
  let sumFees = 0;

  let i = 0;
  let lastLogTimestamp = logs[0].createdAt;
  let tokenValues: number[] = [];
  for (const log of logs) {
    const { createdAt, data, id } = log;

    // const diff = log.createdAt.getTime() - lastLogTimestamp.getTime();
    // if (!tokenValues.length || diff > ONE_MINUTE * 5) {
    //   tokenValues = await Promise.all(
    //     TOKENS.map((t) =>
    //       fetchTokenValueAtTimestamp(t, log.createdAt).catch(() => 0)
    //     )
    //   );
    //   lastLogTimestamp = log.createdAt;
    // } else console.log("Using cached token values.");

    const d: { blockId: string; event: SCOutputEvent | ScExecutionEvent } =
      JSON.parse(log.data.toString());
    const isGrpcEvent = (
      e: SCOutputEvent | ScExecutionEvent
    ): e is ScExecutionEvent => typeof d.event.data !== "string";
    const callStack =
      (isGrpcEvent(d.event)
        ? d.event.context?.callStack
        : d.event.context?.call_stack) || [];
    const grpcEvent = isGrpcEvent(d.event) ? d.event : transformEvent2(d.event);
    if (
      callStack.includes("AS1KDohwRhneJemAfeKwwB1Q5y6Kx5knTiELu8j1U5S9i8FW9gJC")
    ) {
      console.log(i, d.blockId, id, callStack[0]);
      i++;
      // const res = await processInnerSwap({
      //   ...data,
      //   event: grpcEvent,
      //   i,
      //   callStack,
      //   opts: { tokenValues },
      // });
      // sumVolume += res.swapValue.volume;
      // sumFees += res.swapValue.fees;
    }
    // const op = await prisma.operation.findUnique({
    //   where: { id: data.blockId },
    // });
    // if (!op) throw new Error("op is undefined: " + data.blockId);
    // console.log(op.callerAddress, op.targetAddress, op.targetFunction);
  }
  console.log(i, logs.length, sumVolume, sumFees);
}

(async () => {
  // backfillMakerRewards(masUsdcPairV2);
})();

// @ts-expect-error: Property 'toJSON' does not exist on type 'BigInt'
BigInt.prototype.toJSON = function (): string {
  return this.toString();
};
