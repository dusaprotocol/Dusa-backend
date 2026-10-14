import { Prisma } from "@prisma/client";
import { prisma } from "../../common/db";
import {
  ONE_DAY,
  ONE_MINUTE,
  ONE_WEEK,
  getDailyTick,
  wait,
} from "../../common/utils";
import { IERC20, parseUnits, TokenAmount } from "@dusalabs/sdk";
import { web3Client } from "../../common/client";
import { DUSA, JELLY, v2RewarderSC } from "../../common/contracts";
import {
  ALLOCATION_PCT_PER_SEASON,
  BASE_ALLOCATION_PCT,
  SUPPLY,
} from "../../common/config";
import { printTA } from "../../common/methods";
import { BigintIsh } from "@dusalabs/sdk/dist/constants";
import { fetchEvents } from "../../common/datastoreFetcher";
import { MASSA_EXEC_ERROR } from "../../common/eventPoller";
import { Address, Args, byteToBool, MassaUnits } from "@massalabs/massa-web3";

// const TOTAL_POINTS = 35_000_000;
const INITIAL_JELLY_AMOUNT = (BASE_ALLOCATION_PCT * SUPPLY) / 100;
const SEASON_1_WEEK_DURATION = 10;
const SEASON_1_JELLY_AMOUNT = (ALLOCATION_PCT_PER_SEASON * SUPPLY) / 100;
const SEASON_1_WEEKLY_JELLY_AMOUNT =
  SEASON_1_JELLY_AMOUNT / SEASON_1_WEEK_DURATION;
const SEASON_1_WEEKLY_JELLY_AMOUNT_AFTER = 25_000;
// const JELLY_PER_POINT = JELLY_AMOUNT / TOTAL_POINTS;
const jellyContract = new IERC20(JELLY.address, web3Client);

const print = (x: BigintIsh) => printTA(JELLY, x);

/**
 * Lock/unlock transfers for the token
 * @param paused - true to pause, false to unpause
 */
const setPaused = async (paused: boolean) => {
  const isPaused = await jellyContract
    .extract(["isTransferPaused"])
    .then((r) => (r[0] ? byteToBool(r[0]) : false));
  if (isPaused === paused) throw new Error("Already in desired state");
  await jellyContract
    .call(
      {
        targetFunction: paused ? "pauseTransfer" : "unpauseTransfer",
        // coins: MassaUnits.oneMassa * 5n,
        parameter: [],
      },
      false
    )
    .then(console.log);
};

const manageWhitelist = async (address: string, toAdd: boolean) => {
  jellyContract
    .call({
      targetFunction: toAdd
        ? "addAddressToWhitelist"
        : "removeAddressFromWhitelist",
      parameter: new Args().addString(address),
    })
    .then(console.log);
};
const addToWhitelist = async (address: string) =>
  manageWhitelist(address, true);
const removeFromWhitelist = async (address: string) =>
  manageWhitelist(address, false);

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const main = async () => {
  const leaderboard = await prisma.points
    .groupBy({
      by: ["userAddress"],
      _sum: { points: true },
      orderBy: { _sum: { points: "asc" } },
    })
    .then((res) =>
      res.map((r) => ({ address: r.userAddress, points: r._sum.points || 0 }))
    );
  console.log(leaderboard.length + " users in leaderboard");
  const TOTAL_POINTS = leaderboard.reduce((acc, user) => acc + user.points, 0);
  console.log("Total points:", TOTAL_POINTS.toFixed(1));

  let totalJellyAmount = 0n;
  let i = 0;
  for (const user of leaderboard) {
    i++;
    const share = (user.points * INITIAL_JELLY_AMOUNT) / TOTAL_POINTS;
    const userJellyAmount = parseUnits(share.toString(), 18);
    totalJellyAmount += userJellyAmount;
    const balance = await jellyContract.balanceOf(user.address);
    if (balance > 0n) continue;

    const targetFunction = "transfer";
    const parameter = new Args()
      .addString(user.address)
      .addU256(userJellyAmount);
    const existingTransfer = await prisma.operation.findFirst({
      where: {
        AND: [
          { targetAddress: jellyContract.address },
          { targetFunction },
          { data: Buffer.from(parameter.serialize()) },
        ],
      },
    });
    if (existingTransfer) {
      console.log("Transfer already exists for", user.address);
      continue;
    }
    return;
    // const txId = await jellyContract.transfer(user.address, userJellyAmount);
    const txId = await jellyContract.call(
      {
        targetFunction,
        parameter,
        coins: MassaUnits.oneMassa / 100n,
      },
      false
    );

    fetchEvents(txId)
      .then(({ events }) => {
        const errorEvent = events.find((e) =>
          e.data.includes(MASSA_EXEC_ERROR)
        );
        if (!events.length || errorEvent)
          console.error(
            "Error transferring jelly to",
            user.address,
            "with txId",
            txId,
            errorEvent
          );
      })
      .catch((e) => console.error("Error fetching events for txId", txId, e));
    console.log(i, user.address, txId, share);

    await wait(500);
  }
  console.log(
    "Total Jelly Amount:",
    print(totalJellyAmount),
    INITIAL_JELLY_AMOUNT
  );
};

const weekly = async (date: Date, executeTransfers = true) => {
  const leaderboard = await prisma.points.findMany({
    where: { date },
    orderBy: { points: "asc" },
  });

  console.log(leaderboard.length, "users in leaderboard");
  const TOTAL_POINTS = leaderboard.reduce((acc, user) => acc + user.points, 0);
  console.log("Total points:", TOTAL_POINTS.toFixed(1));
  // if (TOTAL_POINTS !== SEASON_1_WEEKLY_JELLY_AMOUNT_AFTER)
  //   throw new Error("Invalid total points");

  let totalJellyAmount = 0n;
  let i = 0;
  for (const user of leaderboard) {
    i++;
    const share =
      (user.points * SEASON_1_WEEKLY_JELLY_AMOUNT_AFTER) / TOTAL_POINTS;
    const userJellyAmount = parseUnits(share.toString(), 18);
    // console.log(user.userAddress, share, userJellyAmount);
    totalJellyAmount += userJellyAmount;
    if (!executeTransfers || userJellyAmount === 0n) continue;

    const targetFunction = "transfer";
    const parameter = new Args()
      .addString(user.userAddress)
      .addU256(userJellyAmount);
    const existingTransfer = await prisma.operation.findFirst({
      where: {
        AND: [
          { targetAddress: jellyContract.address },
          { targetFunction: "transfer" },
          { data: Buffer.from(parameter.serialize()) },
        ],
      },
    });
    if (existingTransfer) {
      console.log("Transfer already exists for", user.userAddress);
      continue;
    }

    // const txId = await jellyContract.transfer(user.userAddress, userJellyAmount);
    const txId = await jellyContract.call(
      {
        targetFunction,
        parameter,
        coins: MassaUnits.oneMassa / 1000n,
      },
      false
    );
    fetchEvents(txId, ONE_MINUTE / 2)
      .then(({ events }) => {
        const errorEvent = events.find((e) =>
          e.data.includes(MASSA_EXEC_ERROR)
        );
        if (!events.length || errorEvent)
          throw new Error(
            JSON.stringify({
              user: user.userAddress,
              errorEvent,
              txId,
            })
          );
      })
      .catch((e) => console.error("Error fetching events for txId", txId, e));
    console.log(i, user.userAddress, txId, share);

    await wait(1000);
  }
  console.log(
    "Total $JELLY:",
    print(totalJellyAmount),
    BigInt(SEASON_1_WEEKLY_JELLY_AMOUNT_AFTER)
  );
};

(async () => {
  // only last week (date equal to last friday)
  const date = getDailyTick(Date.UTC(2025, 6, 11));
  weekly(date, true);
  //
  // const add = "AU1YHBVyC3pNVh8sNeL2nWkWtFP8bgsT8swbSTTaf43NyRsPDoDX";
  // new Address(add); // throws if invalid
  // new IERC20(JELLY.address, web3Client)
  //   .transfer(add, parseUnits("5000", 18))
  //   .then(console.log);
})();
