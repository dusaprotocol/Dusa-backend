import { web3Client } from "../../common/client";
import { handlePrismaError, prisma } from "../../common/db";
import { ILBPair } from "@dusalabs/sdk";
import {
  TICKS_PER_DAY,
  launchTimestamp,
  ONE_DAY,
  getDailyTick,
  ONE_TICK,
} from "../../common/utils/date";
import { createPool } from "../../indexer/src/db";
import { createPoolTick } from "../../crons/poolTicks";
import { getPriceFromId, unadjustPrice } from "../../common/methods";
import { Pool_version } from "@prisma/client";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const createPair = async (poolAddress: string, version: Pool_version) => {
  const pair = new ILBPair(poolAddress, web3Client);
  const tokens = await new ILBPair(poolAddress, web3Client).getTokens();
  const binStep = await pair.feeParameters().then((r) => r.binStep);
  const pool = {
    pair: poolAddress,
    tokenX: tokens[0],
    tokenY: tokens[1],
    binStep,
  };

  await createPool(
    {
      pair: poolAddress,
      tokenX: tokens[0],
      tokenY: tokens[1],
      binStep,
    },
    version
  ).then((res) => console.log(res));
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const computeDailyTicks = async (poolAddress: string) => {
  const startTimestamp = await prisma.analytics
    .findFirst({ where: { poolAddress } })
    .then((r) => r?.date.getTime() || launchTimestamp);
  const currentTicks = await prisma.dailyAnalytics
    .findMany({ where: { poolAddress } })
    .then((r) => r.map((t) => t.date.getTime()));

  let curr = startTimestamp - ONE_DAY;
  while (curr < Date.now()) {
    curr += ONE_DAY;

    const date = getDailyTick(curr);
    if (currentTicks.includes(date.getTime())) continue;

    const before = getDailyTick(curr);
    const after = getDailyTick(curr + ONE_DAY);
    const dailyTicks = await prisma.analytics.findMany({
      where: { poolAddress, date: { gte: before, lt: after } },
      orderBy: { date: "asc" },
    });
    console.log(new Date(curr).toLocaleDateString(), dailyTicks.length);
    if (!dailyTicks.length) continue;

    const high = Math.max(...dailyTicks.map((p) => p.high));
    const low = Math.min(...dailyTicks.map((p) => p.low));
    // prettier-ignore
    const volume0 = dailyTicks.reduce((acc, { volume0 }) => acc + BigInt(volume0), 0n).toString();
    // prettier-ignore
    const volume1 = dailyTicks.reduce((acc, { volume1 }) => acc + BigInt(volume1), 0n).toString();
    const volume = dailyTicks.reduce((acc, curr) => acc + curr.volume, 0);
    const fees = dailyTicks.reduce((acc, curr) => acc + curr.fees, 0);

    const { close, token0Locked, token1Locked, usdLocked } =
      dailyTicks[dailyTicks.length - 1];

    await prisma.dailyAnalytics
      .create({
        data: {
          token0Locked,
          token1Locked,
          usdLocked,
          close,
          high,
          low,
          open: dailyTicks[0].open,
          poolAddress,
          volume0,
          volume1,
          volume,
          fees,
          date,
        },
      })
      .catch(handlePrismaError);
  }
};

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const check = async (poolAddress: string, now = Date.now()) => {
  const today = getDailyTick(now);
  const yesterday = new Date(today.getTime() - ONE_DAY);
  console.log(yesterday, today);

  const ticks = await prisma.analytics.findMany({
    where: {
      poolAddress,
      date: { gte: yesterday, lt: today },
    },
  });
  const daily = await prisma.dailyAnalytics.findUnique({
    where: { poolAddress_date: { poolAddress, date: yesterday } },
  });
  if (!daily) return;

  if (TICKS_PER_DAY !== ticks.length)
    console.log("ticks", TICKS_PER_DAY, ticks.length);

  const high = Math.max(...ticks.map((t) => t.high));
  if (high !== daily.high) console.log("high", high, daily.high);

  const low = Math.min(...ticks.map((t) => t.low));
  if (low !== daily.low) console.log("low", low, daily.low);

  const open = ticks[0].open;
  if (open !== daily.open) console.log("open", open, daily.open);

  const close = ticks[ticks.length - 1].close;
  if (close !== daily.close) console.log("close", close, daily.close);

  const fees = ticks.reduce((prev, curr) => prev + curr.fees, 0);
  if (fees !== daily.fees) console.log("fees", fees, daily.fees);

  const volume = ticks.reduce((prev, curr) => prev + curr.volume, 0);
  if (volume !== daily.volume) console.log("volume", volume, daily.volume);

  if (TICKS_PER_DAY !== ticks.length) {
    const pool = await prisma.pool.findUniqueOrThrow({
      where: { address: poolAddress },
      include: { token0: true, token1: true },
    });
    const timestamps = ticks.map((t) => t.date.getTime());
    const missingTimestamps = Array.from(
      { length: TICKS_PER_DAY },
      (_, i) => yesterday.getTime() + i * ONE_TICK
    ).filter((t) => !timestamps.includes(t));

    for (const timestamp of missingTimestamps) {
      const tickJustBefore = ticks.findLast(
        (t) => t.date.getTime() < timestamp
      );
      const tickJustAfter = ticks.find((t) => t.date.getTime() > timestamp);
      if (!tickJustBefore || !tickJustAfter) continue;

      // avg of the two ticks
      const active = (tickJustBefore.close + tickJustAfter.open) / 2;
      // const activeId = unadjustPrice(
      //   getPriceFromId(active, pool.binStep),
      //   pool.token0.decimals,
      //   pool.token1.decimals
      // );
      const activeId = getPriceFromId(
        unadjustPrice(active, pool.token0.decimals, pool.token1.decimals),
        pool.binStep
      );
      console.log("active", active, activeId, pool.binStep);
      const token0Locked =
        (BigInt(tickJustBefore.token0Locked) +
          BigInt(tickJustAfter.token0Locked)) /
        2n;
      const token1Locked =
        (BigInt(tickJustBefore.token1Locked) +
          BigInt(tickJustAfter.token1Locked)) /
        2n;
      const usdLocked =
        (tickJustBefore.usdLocked + tickJustAfter.usdLocked) / 2;
      console.log(
        "token0Locked",
        tickJustBefore.token0Locked,
        tickJustAfter.token0Locked,
        token0Locked
      );
      console.log(
        "token1Locked",
        tickJustBefore.token1Locked,
        tickJustAfter.token1Locked,
        token1Locked
      );
      console.log(
        "usdLocked",
        tickJustBefore.usdLocked,
        tickJustAfter.usdLocked,
        usdLocked
      );
      console.log(
        "activeId",
        tickJustBefore.close,
        tickJustAfter.open,
        activeId
      );

      const lockedState = {
        activeId,
        token0Locked,
        token1Locked,
        usdLocked,
      };
      createPoolTick(pool, { lockedState, timestamp });
    }
  }
};

(async () => {
  // const yesterday = getDailyTick(Date.now() - ONE_DAY);
  // await prisma.dailyAnalytics
  //   .deleteMany({ where: { poolAddress, date: yesterday } })
  //   .then(console.log);
  // await computeDailyTicks(poolAddress, yesterday.getTime()).then(() =>
  //   console.log("done")
  // );
  //
  // const poolAddress = masUsdcPair;
  // check(poolAddress);
})();
