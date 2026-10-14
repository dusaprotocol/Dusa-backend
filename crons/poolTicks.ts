import {
  IBaseContract,
  ILBPair,
  SWAP_ROUTER_METHODS,
  Token,
  TokenAmount,
} from "@dusalabs/sdk";
import { handlePrismaError, prisma } from "../common/db";
import logger from "../common/logger";
import {
  adjustPrice,
  cache,
  calculateUSDValue,
  getCallee,
  getPriceFromId,
  isSwapEvent,
  toToken,
} from "../common/methods";
import { web3Client } from "../common/client";
import { fetchTokenInfo, getTokenValueRaw } from "../common/datastoreFetcher";
import {
  ONE_DAY,
  TICKS_PER_DAY,
  ONE_TICK,
  getClosestTick,
  getDailyTick,
  ONE_WEEK,
  parseSlot,
  parseTimestamp,
  getHourlyTick,
  ONE_HOUR,
} from "../common/utils";
import {
  createAnalytic,
  getHighLow,
  getPools,
  getVolumeFees,
} from "../indexer/src/db";
import { Prisma } from "@prisma/client";
import { postWebhook } from "../common/discord";
import { Args, bytesToStr, strToBytes, U256, U64 } from "@massalabs/massa-web3";
import {
  ROUTERS,
  V2_PAIRS,
  votingEscrowSC,
  voterSC,
  v2RouterSC,
  PAIRS,
} from "../common/contracts";
import { getDatastoreKeys } from "../common/datastoreFetcher";
import { getOperations, getOperation } from "../scripts/src/backup";
import { backfillTxs } from "../scripts/src/backfill";

type Pool = Prisma.PoolGetPayload<{ include: { token0: true; token1: true } }>;
type LockedState = Awaited<ReturnType<typeof getPoolLocked>>;
type ActivityState = Awaited<ReturnType<typeof getPoolVolumeFees>>;

// when theres a massive amount of missing ticks (only retrieving price/volume)
const fillMissingTicksBulk = async (
  pool: Pool,
  ticks: Prisma.AnalyticsGetPayload<{}>[],
  from: number
) => {
  const bulk: Prisma.AnalyticsCreateManyInput[] = [];
  const { address: poolAddress, binStep } = pool;
  const now = Date.now();

  logger.info(
    `Filling missing ticks for pool ${poolAddress} from ${new Date(from).toISOString()}`
  );

  let i = 0;
  while (true) {
    const tickTimestamp = from + i * ONE_TICK;
    const date = getClosestTick(tickTimestamp);
    const currentTick = getClosestTick(now);

    // Stop when we reach the current tick
    if (date.getTime() >= currentTick.getTime()) break;

    // Check if tick already exists
    const existingTick = ticks.find((t) => t.date.getTime() === date.getTime());
    if (existingTick) {
      i++;
      continue;
    }

    // Get volume and fees for this tick period
    const gte = date;
    const lt = getClosestTick(tickTimestamp + ONE_TICK);
    const { volume, fees } = await getVolumeFees(poolAddress, gte, lt);

    // Get high/low prices from swaps
    const { highId, lowId } = await getHighLow(poolAddress, gte, lt);

    // Get volumes in token amounts
    const volumes = await prisma.swap.findMany({
      where: {
        poolAddress,
        timestamp: { gte, lt },
      },
      select: {
        amountIn: true,
        amountOut: true,
        swapForY: true,
        feesIn: true,
        endId: true,
      },
    });

    const { volumeX, volumeY, feesX, feesY } = volumes.reduce(
      (acc, { amountIn, amountOut, swapForY, feesIn }) => {
        if (swapForY) {
          acc.volumeX += BigInt(amountIn);
          acc.volumeY += BigInt(amountOut);
          acc.feesX += BigInt(feesIn);
        } else {
          acc.volumeX += BigInt(amountOut);
          acc.volumeY += BigInt(amountIn);
          acc.feesY += BigInt(feesIn);
        }
        return acc;
      },
      { volumeX: 0n, volumeY: 0n, feesX: 0n, feesY: 0n }
    );

    // Calculate price - use the last swap's endId as close, or use previous tick's close
    let closePrice = 0;
    if (volumes.length > 0) {
      const lastSwap = volumes[volumes.length - 1];
      closePrice = adjustPrice(
        getPriceFromId(lastSwap.endId, binStep),
        pool.token0.decimals,
        pool.token1.decimals
      );
    } else if (i > 0 && bulk.length > 0) {
      // Use previous tick's close if no swaps in this period
      closePrice = bulk[bulk.length - 1].close;
    } else if (ticks.length > 0) {
      // Use the last existing tick's close
      const lastExistingTick = ticks.reduce((latest, tick) =>
        tick.date.getTime() > latest.date.getTime() ? tick : latest
      );
      closePrice = lastExistingTick.close;
    }

    const [high, low] = [highId, lowId].map((id) =>
      adjustPrice(
        getPriceFromId(id || 0, binStep),
        pool.token0.decimals,
        pool.token1.decimals
      )
    );

    // Create tick with minimal data (no locked liquidity data)
    bulk.push({
      poolAddress,
      date,
      open: closePrice,
      close: closePrice,
      high: high || closePrice,
      low: low || closePrice,
      volume,
      fees,
      volume0: volumeX.toString(),
      volume1: volumeY.toString(),
      fees0: feesX.toString(),
      fees1: feesY.toString(),
      token0Locked: "0",
      token1Locked: "0",
      usdLocked: 0,
    });

    i++;

    // Log progress every 50 ticks
    if (i % 50 === 0) {
      logger.info(`Processed ${i} ticks for pool ${poolAddress}`);
    }
  }

  if (bulk.length > 0) {
    logger.info(
      `Inserting ${bulk.length} missing ticks for pool ${poolAddress}`
    );
    await prisma.analytics.createMany({ data: bulk, skipDuplicates: true });
  } else {
    logger.info(`No missing ticks to fill for pool ${poolAddress}`);
  }
};

// MAIN HELPERS

const getPoolLocked = async (pool: Pool, dollarValues?: [number, number]) => {
  const { address: poolAddress } = pool;
  const [token0, token1] = [pool.token0, pool.token1].map(toToken);

  const pairInfo = await new ILBPair(
    poolAddress,
    web3Client
  ).getReservesAndId();

  const { reserveX: token0Locked, reserveY: token1Locked } = pairInfo;
  const [token0Value, token1Value] =
    dollarValues ||
    (await Promise.all([getTokenValueRaw(token0), getTokenValueRaw(token1)]));
  const usdLocked = calculateUSDValue(
    new TokenAmount(token0, token0Locked),
    token0Value,
    new TokenAmount(token1, token1Locked),
    token1Value
  );

  return { usdLocked, token0Locked, token1Locked, activeId: pairInfo.activeId };
};

const getPoolVolumeFees = async (pool: Pool, now: number) => {
  const { address: poolAddress } = pool;

  const volumes = await prisma.swap.findMany({
    where: {
      poolAddress,
      timestamp: {
        gte: getClosestTick(now - ONE_TICK),
        lt: getClosestTick(now),
      },
    },
    select: {
      amountIn: true,
      amountOut: true,
      swapForY: true,
      feesIn: true,
    },
  });
  const volumeFeesAmounts = volumes.reduce(
    (acc, { amountIn, amountOut, swapForY, feesIn }) => {
      if (swapForY) {
        acc.volumeX += BigInt(amountIn);
        acc.volumeY += BigInt(amountOut);
        acc.feesX += BigInt(feesIn);
      } else {
        acc.volumeX += BigInt(amountOut);
        acc.volumeY += BigInt(amountIn);
        acc.feesY += BigInt(feesIn);
      }
      return acc;
    },
    { volumeX: 0n, volumeY: 0n, feesX: 0n, feesY: 0n }
  );

  const gte = getClosestTick(now - ONE_TICK);
  const lt = getClosestTick(now);
  const usdVolumeFees = await getVolumeFees(poolAddress, gte, lt);

  return { ...volumeFeesAmounts, ...usdVolumeFees };
};

const poolVolumeFees = cache(getPoolVolumeFees, { ttl: ONE_WEEK / 1000 });

// CRITICAL DATASTORE KEYS ARCHIVAL

/**
 * Archives critical datastore keys to LedgerChange table
 * This ensures historical state is preserved for governance scripts and reindexing
 */
const archiveCriticalDatastoreKeys = async () => {
  logger.info("Starting critical datastore keys archival...");

  try {
    const blockId = new Date().toISOString(); // not important
    const timestamp = new Date();
    await prisma.block.create({
      data: {
        id: blockId,
        period: 0,
        thread: 0,
      },
    });

    let totalKeysArchived = 0;
    const argsDelimiter = ";?!";

    // 1. Archive Voting Escrow keys
    logger.info("Archiving VotingEscrow contract keys...");
    const veContract = new IBaseContract(votingEscrowSC, web3Client);

    const veKeys = await getDatastoreKeys(votingEscrowSC);
    const veData = await veContract.extract(veKeys);
    const veEntries = veKeys.map((key, i) => ({
      key,
      value: veData[i],
    }));
    await archiveKeys(votingEscrowSC, veEntries, blockId, timestamp);

    // 2. Archive Voter contract keys
    logger.info("Archiving Voter contract keys...");
    const voterContract = new IBaseContract(voterSC, web3Client);

    const voterKeys = await getDatastoreKeys(voterSC);
    const voterData = await voterContract.extract(voterKeys);
    const voterEntries = voterKeys.map((key, i) => ({
      key,
      value: voterData[i],
    }));
    await archiveKeys(voterSC, voterEntries, blockId, timestamp);

    // 3. Archive Pool state (PAIR_INFORMATION) for all V2 pairs
    logger.info("Archiving pool PAIR_INFORMATION...");
    for (const poolAddress of V2_PAIRS) {
      const poolContract = new IBaseContract(poolAddress, web3Client);
      const pairInfoData = await poolContract.extract(["PAIR_INFORMATION"]);
      await archiveKeys(
        poolAddress,
        [{ key: "PAIR_INFORMATION", value: pairInfoData[0] }],
        blockId,
        timestamp
      );
      totalKeysArchived++;
    }

    // 4. Archive LP keys (balances:: and total_supplies::) for whitelisted pools
    logger.info("Archiving LP keys for whitelisted pools...");
    const whitelistedPools = await prisma.pool.findMany({
      where: { whitelisted: true },
      include: { token0: true, token1: true },
    });

    for (const pool of whitelistedPools) {
      try {
        // Get active bin ID from PAIR_INFORMATION
        const poolContract = new ILBPair(pool.address, web3Client);
        const pairInfo = await poolContract.getReservesAndId();
        const activeId = pairInfo.activeId;

        // Define bin radius (5 bins on each side)
        const BIN_RADIUS = 5;
        const binIds = Array.from(
          { length: BIN_RADIUS * 2 + 1 },
          (_, i) => activeId - BIN_RADIUS + i
        );

        logger.info(
          `Archiving LP data for pool ${pool.token0.symbol}/${pool.token1.symbol} around bin ${activeId}`
        );

        // Archive total_supplies for bins in radius
        const totalSupplyKeys = binIds.map(
          (binId) => `total_supplies::${binId}`
        );
        const totalSupplyData = await poolContract.extract(totalSupplyKeys);
        const totalSupplyEntries = totalSupplyKeys.map((key, i) => ({
          key,
          value: totalSupplyData[i],
        }));
        await archiveKeys(pool.address, totalSupplyEntries, blockId, timestamp);
        totalKeysArchived += totalSupplyEntries.filter(
          (e) => e.value?.length
        ).length;

        // Archive balances:: for all users with positions in these bins
        // Use getDatastoreKeys to find all existing balance keys
        logger.info(`Fetching all balances:: keys for pool ${pool.address}...`);
        const allBalanceKeys = await getDatastoreKeys(
          pool.address,
          "balances::"
        );

        // Filter to only include keys for bins in our radius
        const balanceKeys = allBalanceKeys.filter((key) => {
          // Extract binId from key pattern: balances::8388608:AU12...
          const match = key.match(/^balances::(\d+):/);
          if (!match) return false;
          const binId = parseInt(match[1]);
          return binIds.includes(binId);
        });

        if (balanceKeys.length > 0) {
          // Fetch in batches to avoid overwhelming the RPC
          const BATCH_SIZE = 100;
          for (let i = 0; i < balanceKeys.length; i += BATCH_SIZE) {
            const batch = balanceKeys.slice(i, i + BATCH_SIZE);
            const balanceData = await poolContract.extract(batch);
            const balanceEntries = batch.map((key, j) => ({
              key,
              value: balanceData[j],
            }));
            await archiveKeys(pool.address, balanceEntries, blockId, timestamp);
            totalKeysArchived += balanceEntries.filter(
              (e) => e.value?.length
            ).length;
          }

          logger.info(
            `Archived ${binIds.length} total_supplies and ${balanceKeys.length} balances for pool ${pool.address}`
          );
        } else {
          logger.info(
            `Archived ${binIds.length} total_supplies (no balances found)`
          );
        }
      } catch (error) {
        logger.error(
          `Failed to archive LP keys for pool ${pool.address}: ${error}`
        );
      }
    }

    logger.info(
      `✅ Successfully archived ${totalKeysArchived} critical datastore keys at block ${blockId}`
    );
  } catch (error) {
    logger.error(`❌ Error archiving critical datastore keys: ${error}`);
  }
};

/**
 * Helper to archive multiple keys to LedgerChange table
 */
const archiveKeys = async (
  contractAddress: string,
  entries: { key: string; value: Uint8Array | undefined }[],
  blockId: string,
  _timestamp: Date
) => {
  const data = entries
    .filter((entry) => entry.value && entry.value.length > 0)
    .map((entry, index) => ({
      address: contractAddress,
      key: Buffer.from(strToBytes(entry.key)),
      value: Buffer.from(entry.value!),
      blockId,
      index: Date.now() + index, // Use timestamp + index to ensure uniqueness
      key191Chars: entry.key.slice(0, 191),
    }));

  if (data.length === 0) return;

  // Insert ledger changes
  await prisma.ledgerChange
    .createMany({
      data,
      skipDuplicates: true,
    })
    .catch(handlePrismaError);
};

// SWAP INDEXING MONITORING

const ONE_HOUR = 60 * 60 * 1000;
const DELAY = 2 * ONE_HOUR; // 2 hours in milliseconds
let lastAlertTimestamp = 0;
const ALERT_COOLDOWN = 6 * ONE_HOUR; // 6 hours cooldown to avoid spam

/**
 * Check if swaps are being indexed properly
 * Sends a Discord alert if a swap is in the explorer but not in the database
 */
const checkSwapIndexing = async () => {
  const webhook = process.env.DISCORD_WEBHOOK_ALERT;
  if (!webhook) {
    logger.debug(
      "DISCORD_WEBHOOK_ALERT not configured, skipping indexing check"
    );
    return;
  }

  try {
    // Get the most recent swap from the database
    const mostRecentSwap = await prisma.swap.findFirstOrThrow({
      where: { txHash: { startsWith: "O" } },
      orderBy: { timestamp: "desc" },
      select: { timestamp: true, txHash: true },
    });

    const now = Date.now();
    const timeSinceLastSwap = now - mostRecentSwap.timestamp.getTime();

    let lastSwapTimestamp = 0;
    let lastSwapTxHash = "";
    const routerTxs = await getOperations(v2RouterSC).then(
      (r) => r.operationsReceived || []
    );
    for (let i = 0; i < routerTxs.length; i++) {
      const tx = routerTxs[i];
      if (!tx.op_exec_status) continue;

      if (mostRecentSwap.txHash === tx.hash) break;

      const timestamp = new Date(Number(tx.block_time));
      const fullTx = await getOperation(tx.hash);
      const targetFunction = fullTx.operation.content.op.CallSC.target_func;
      if (SWAP_ROUTER_METHODS.includes(targetFunction as any)) {
        lastSwapTimestamp = timestamp.getTime();
        lastSwapTxHash = tx.hash;
        break;
      }
    }
    if (!lastSwapTimestamp || !lastSwapTxHash) return;

    const timeSinceExplorerLatestSwap = now - lastSwapTimestamp;

    // console.log(timeSinceExplorerLatestSwap, timeSinceLastSwap);

    const shouldAlert = mostRecentSwap.txHash !== lastSwapTxHash;
    if (!shouldAlert) return;

    const hoursSinceLastSwap = (timeSinceLastSwap / ONE_HOUR).toFixed(1);

    const content = `
    ⚠️ **Indexer Alert**: No swaps have been indexed in the last ${hoursSinceLastSwap} hours!\n\n
    Last indexed swap: ${mostRecentSwap.timestamp.toISOString()}\n
    Tx: ${mostRecentSwap.txHash}\n\n
    Last explorer swap: ${new Date(lastSwapTimestamp).toISOString()}\n
    Tx: ${lastSwapTxHash}
    `;

    const lastSwapEvents = await prisma.event.findMany({
      where: { operationId: lastSwapTxHash },
    });
    const op = await prisma.operation.findUnique({
      where: { id: lastSwapTxHash },
    });
    if (lastSwapEvents.length)
      logger.info("Events found for last swap transaction");
    if (op) logger.info("Operation found for last swap transaction");
    if (op && lastSwapEvents.length) backfillTxs(ONE_DAY);

    // Send webhook message
    const sent = await postWebhook(webhook, { content });
    if (sent) logger.info("Discord alert sent successfully");
  } catch (error) {
    logger.error(`Error checking swap indexing: ${error}`);
  }
};

/**
 * Archive swap events from the last 5 minutes using web3Client.getEvents
 * This ensures events are preserved in the database before gRPC nodes ditch them
 */
const archiveRecentSwapEvents = async () => {
  let archivedCount = 0;
  let totalEventsFetched = 0;

  // Fetch events from blockchain using web3Client
  const lastTick = parseTimestamp(getClosestTick(Date.now() - ONE_TICK));
  const currentTick = parseTimestamp(getClosestTick());
  const events = await web3Client.getEvents({
    isFinal: true,
    start: { period: Number(lastTick.period), thread: lastTick.thread },
    end: { period: Number(currentTick.period), thread: currentTick.thread },
  });

  totalEventsFetched = events.length;
  logger.debug(`Fetched ${totalEventsFetched} events from blockchain`);

  // Filter for swap events
  const swapEvents = events.filter((event) => {
    const eventData = event.data || "";
    const emitterAddress = getCallee(event.context.call_stack);
    const isSwapEvent = eventData.includes("SWAP:"); // SWAP: or V1_SWAP:
    const isFromPair = PAIRS.includes(emitterAddress);
    return isSwapEvent && isFromPair;
  });
  logger.debug(`Found ${swapEvents.length} swap events to archive`);

    // Store events in database
    await prisma.event
      .createMany({
      data: swapEvents.map((event) => ({
          data: Buffer.from(strToBytes(event.data)),
          emitterAddress: getCallee(event.context.call_stack),
          indexInSlot: event.context.index_in_slot,
        operationId: event.context.block || "",
        })),
        skipDuplicates: true,
      })
    .then(console.log)
    .catch(console.log);

    archivedCount++;
};

// MAIN

export const createPoolTick = async (
  pool: Pool,
  opts?: {
    timestamp?: number;
    lockedState?: LockedState;
    activityState?: ActivityState;
    dollarValues?: [number, number];
  }
): Promise<boolean> => {
  const timestamp = opts?.timestamp ?? Date.now();
  // logger.silly(`[${new Date().toString()}]: ${pool.address}`);

  const { address: poolAddress, binStep } = pool;
  const [token0, token1] = [toToken(pool.token0), toToken(pool.token1)];

  const { activeId, token0Locked, token1Locked, usdLocked } =
    opts?.lockedState ?? (await getPoolLocked(pool, opts?.dollarValues));

  const { volumeX, volumeY, feesX, feesY, fees, volume } =
    opts?.activityState ?? (await poolVolumeFees(pool, timestamp));

  const gte = getClosestTick(timestamp - ONE_TICK);
  const lt = getClosestTick(timestamp);
  const { highId, lowId } = await getHighLow(poolAddress, gte, lt);
  const [active, high, low] = [activeId, highId, lowId].map((id) =>
    adjustPrice(
      getPriceFromId(id || activeId, binStep),
      token0.decimals,
      token1.decimals
    )
  );
  if (!active) throw new Error("Invalid price");

  // create new 5-min pool tick
  const success = await createAnalytic({
    poolAddress,
    date: getClosestTick(timestamp),
    open: active,
    token0Locked: token0Locked.toString(),
    token1Locked: token1Locked.toString(),
    usdLocked,
  });
  if (!success) return false;

  // update last 5-min pool tick
  const lastTick = gte;
  prisma.analytics
    .update({
      where: { poolAddress_date: { poolAddress, date: lastTick } },
      data: {
        close: active,
        high,
        low,
        fees,
        volume,
        volume0: volumeX.toString(),
        volume1: volumeY.toString(),
        fees0: feesX.toString(),
        fees1: feesY.toString(),
        token0Locked: token0Locked.toString(),
        token1Locked: token1Locked.toString(),
        usdLocked,
      },
    })
    // .then(() => console.log("updated last tick"))
    .catch(handlePrismaError);

  // update pool daily aggregate tick
  const daily = getDailyTick(timestamp);
  const where = { poolAddress_date: { poolAddress, date: daily } };
  const dailyTick = await prisma.dailyAnalytics.findUnique({ where });
  prisma.dailyAnalytics
    .upsert({
      where,
      create: {
        open: active,
        close: active,
        high: active,
        low: active,
        fees,
        volume,
        volume0: volumeX.toString(),
        volume1: volumeY.toString(),
        fees0: feesX.toString(),
        fees1: feesY.toString(),
        token0Locked: token0Locked.toString(),
        token1Locked: token1Locked.toString(),
        usdLocked,
        date: daily,
        poolAddress,
      },
      update: {
        high: { set: dailyTick ? Math.max(dailyTick.high, high) : high },
        low: { set: dailyTick ? Math.min(dailyTick.low, low) : low },
        // prettier-ignore
        close: { set: active},
        fees: { set: dailyTick ? dailyTick.fees + fees : fees },
        volume: { set: dailyTick ? dailyTick.volume + volume : volume },
        // prettier-ignore
        volume0: { set: dailyTick ? (BigInt(dailyTick.volume0) + volumeX).toString() : volumeX.toString()},
        // prettier-ignore
        volume1: { set: dailyTick ? (BigInt(dailyTick.volume1) + volumeY).toString() : volumeY.toString()},
        // prettier-ignore
        fees0: { set: dailyTick ? (BigInt(dailyTick.fees0) + feesX).toString() : feesX.toString()},
        // prettier-ignore
        fees1: { set: dailyTick ? (BigInt(dailyTick.fees1) + feesY).toString() : feesY.toString()},
      },
    })
    // .then(() => console.log("updated daily tick"));
    .catch(handlePrismaError);

  return true;
};

const main = async (now = Date.now()) => {
  // Archive recent swap events to prevent data loss
  await archiveRecentSwapEvents();

  // Archive critical datastore keys
  if (getClosestTick() === getHourlyTick())
    await archiveCriticalDatastoreKeys();

  // get pools that are active or whitelisted
  const allPools = await getPools(true);
  // const activePools = await prisma.swap.findMany({
  //   select: { poolAddress: true },
  //   distinct: ["poolAddress"],
  //   where: { timestamp: { gte: getClosestTick(now - ONE_DAY * 7) } },
  // });
  // const pools = allPools.filter(
  //   (pool) =>
  //     activePools.some((p) => p.poolAddress === pool.address) ||
  //     pool.whitelisted
  // );
  const pools = allPools; // tmp

  const tokens = pools.flatMap((pool) => [
    toToken(pool.token0),
    toToken(pool.token1),
  ]);
  const uniqueTokensAddresses = Array.from(
    new Set(tokens.map((token) => token.address))
  );
  const uniqueTokens = uniqueTokensAddresses.map((address) =>
    tokens.find((token) => token.address === address)
  ) as Token[];

  const _globalDollarValues = await Promise.allSettled(
    uniqueTokens.map(getTokenValueRaw)
  );
  const rejected = _globalDollarValues.filter((v) => v.status === "rejected");
  if (rejected.length)
    logger.warn(
      `Failed to fetch dollar value for ${rejected.length} tokens: ${rejected
        .map((r, i) => uniqueTokens[i].address)
        .join(", ")}`
    );
  const globalDollarValues = _globalDollarValues.map((v) =>
    v.status === "fulfilled" ? v.value : 0
  );

  let successCount = 0;
  for (const pool of pools) {
    const index0 = uniqueTokensAddresses.indexOf(pool.token0.address);
    const dollarValue0 = globalDollarValues[index0];
    const index1 = uniqueTokensAddresses.indexOf(pool.token1.address);
    const dollarValue1 = globalDollarValues[index1];
    const success = await createPoolTick(pool, {
      dollarValues: [dollarValue0, dollarValue1],
    });
    if (success) successCount++;
  }

  // Check if swaps are being indexed properly
  if (
    successCount > pools.length / 2 ||
    (successCount === pools.length / 2 && Math.random() > 0.5)
  )
    await checkSwapIndexing();

  for (const token of uniqueTokens) {
    const poolsAsToken = pools.filter(
      (pool) =>
        pool.token0.address === token.address ||
        pool.token1.address === token.address
    );

    let sumVolume = 0;
    let sumFees = 0;
    for (const pool of poolsAsToken) {
      const { volume, fees } = await poolVolumeFees(pool, now);
      sumVolume += volume;
      sumFees += fees;
    }

    const lastTokenTick = await prisma.tokenAnalytics.findFirst({
      where: { tokenAddress: token.address },
      orderBy: { date: "desc" },
      select: { close: true },
    });
    const open = lastTokenTick?.close || 0;

    const tokenIndex = uniqueTokensAddresses.indexOf(token.address);
    const close = globalDollarValues[tokenIndex];
    const high = Math.max(open, close);
    const low = Math.min(open, close);

    prisma.tokenAnalytics
      .create({
        data: {
          tokenAddress: token.address,
          volume: sumVolume,
          fees: sumFees,
          high,
          open,
          close,
          low,
          date: getClosestTick(),
        },
      })
      .catch(handlePrismaError);
  }
};

const mainBulk = async () => {
  // Script to regenerate missing ticks for the last 24 hours
  try {
    logger.info("Starting bulk tick regeneration for the last 24 hours...");

    const allPools = await getPools(true);
    const from = Date.now() - ONE_DAY;

    logger.info(`Found ${allPools.length} pools to process`);

    for (const pool of allPools) {
      try {
        // Fetch existing ticks for this pool in the last 24 hours
        const existingTicks = await prisma.analytics.findMany({
          where: {
            poolAddress: pool.address,
            date: { gte: getClosestTick(from) },
          },
          orderBy: { date: "asc" },
        });

        logger.info(
          `Pool ${pool.address}: Found ${existingTicks.length} existing ticks`
        );

        await fillMissingTicksBulk(pool, existingTicks, from);
      } catch (error) {
        logger.error(`Failed to process pool ${pool.address}:`, error);
      }
    }

    logger.info("Bulk tick regeneration completed successfully");
  } catch (error) {
    logger.error("Bulk tick regeneration failed:", error);
  } finally {
    process.exit(0);
  }
};

(async () => {
  main()
    .catch((e) => logger.error(e))
    .finally(() => process.exit(0));
})();
