import { Maker, Prisma, Token as PrismaToken } from "@prisma/client";
import { prisma } from "../../common/db";
import { writeFile } from "fs";
import { Fraction, IERC20, parseUnits, TokenAmount } from "@dusalabs/sdk";
import { ONE_DAY, ONE_WEEK, wait } from "../../common/utils";
import {
  calculateWeeklyStreak,
  printTA,
  roundFraction,
  toFraction,
  toToken,
} from "../../common/methods";
import xlsx from "node-xlsx";
import { BigintIsh } from "@dusalabs/sdk/dist/constants";
import { FEE_WEIGHT } from "../../common/config";
import { JELLY, PUR, WMAS } from "../../common/contracts";
import { web3Client } from "../../common/client";

// TYPES

export type RawDBData = Omit<Maker, "address" | "date" | "volume">;
export type ExcelData = RawDBData & {
  userAddress: string;
  percentOfTotalFees: number;
  makerScore: number;
  makerRank: number;
  rewardPercentage: number;
  rewardToken: string;
  makerRewards: number;
  makerRewardsRaw: string;
  makerRewardsWithStreak: number;
  makerRewardsWithStreakRaw: string;
  pairName: string;
  rewardEpoch: number;
  rewardAmount: number;
  weeklyStreak: number;
};

export type MarketData = {
  address: string;
  epoch: number;
  start: number;
  duration: number;
  length: number;
  rewards: RewardData[];
};

export type RewardData = {
  address: string;
  totalRewards: bigint;
  length: number;
  users: UserData[];
};

export type UserData = {
  address: string;
  amount: bigint;
};

export type JSONData = {
  length: number;
  markets: MarketData[];
};

// CONSTANTS

let epoch = 1;
let from = new Date(Date.UTC(2024, 3, 22));
let to = new Date(from.getTime() + ONE_DAY * 7 - 1);

// SAVE FILE

const saveJSONFile = (data: {}, name?: string) =>
  writeFile(
    name || `dataset_${epoch}.json`,
    JSON.stringify(data),
    (err) => err && console.error(err)
  );

const saveXLSXFile = (rawData: ExcelData[]) => {
  const data = rawData.map((row) => {
    return Object.values(row);
  });
  // add headers
  data.unshift(Object.keys(rawData[0]));
  writeFile(
    `dataset_${epoch}.xlsx`,
    xlsx.build([
      {
        name: `Epoch ${epoch}`,
        data,
        options: {},
      },
    ]),
    (err) => err && console.error(err)
  );
};

const saveDB = (rawData: ExcelData[]) => {
  prisma.rewards
    .createMany({
      data: rawData.map((data) => {
        return {
          ...data,
        };
      }),
    })
    .catch((err) => console.error(err));
};

// HELPERS

const getAccruedFees = async (poolAddress: string, makerAddress: string) => {
  const res = await prisma.maker.findMany({
    where: {
      poolAddress,
      date: { lt: to },
      address: makerAddress,
    },
  });
  const timestamps = res
    .filter((m) => m.accruedFeesUsdEffective > 0)
    .map((maker) => maker.date);
  const streak = calculateWeeklyStreak(timestamps, from.getTime());
  const accruedFees = res.reduce(
    (acc, maker) => {
      // filter out records that are not in the current week
      if (maker.date.getTime() < from.getTime()) return acc;

      return {
        accruedFeesX: acc.accruedFeesX + BigInt(maker.accruedFeesX),
        accruedFeesY: acc.accruedFeesY + BigInt(maker.accruedFeesY),
        accruedFeesL: acc.accruedFeesL + BigInt(maker.accruedFeesL),
      };
    },
    { accruedFeesX: 0n, accruedFeesY: 0n, accruedFeesL: 0n }
  );
  return { ...accruedFees, streak };
};

const getMarkets = async () => {
  return prisma.rewardPool.findMany({
    include: {
      rewardTokens: { include: { token: true } },
      pool: { include: { token0: true, token1: true } },
    },
    where: { epoch },
  });
};

// MAIN

const main = async () => {
  console.log(epoch, from, to);
  const jsonData: JSONData = { length: 0, markets: [] };
  const excelData: ExcelData[] = [];

  const markets = await getMarkets();
  for (const market of markets) {
    const {
      poolAddress,
      pool: { token0, token1, binStep },
      rewardTokens,
    } = market;
    const makers = await prisma.maker
      .groupBy({
        by: ["address"],
        where: { poolAddress, date: { gte: from, lt: to } },
        _sum: {
          volume: true,
          accruedFeesUsd: true,
          accruedFeesUsdEffective: true,
        },
      })
      .then((res) => {
        return res
          .map((maker) => {
            return {
              address: maker.address,
              volume: maker._sum.volume || 0,
              accruedFeesUsd: maker._sum.accruedFeesUsd || 0,
              accruedFeesUsdEffective: maker._sum.accruedFeesUsdEffective || 0,
            };
          })
          .sort(
            (a, b) => b.accruedFeesUsdEffective - a.accruedFeesUsdEffective
          );
      });

    const totalFees = makers.reduce(
      (acc, maker) => acc + maker.accruedFeesUsdEffective,
      0
    );
    const totalFeesWeighted = makers.reduce(
      (acc, maker) => acc + maker.accruedFeesUsdEffective ** FEE_WEIGHT,
      0
    );

    let i = 0;
    for (const maker of makers) {
      i++;
      const accruedFees = await getAccruedFees(poolAddress, maker.address);
      const percentOfTotalFees = maker.accruedFeesUsdEffective / totalFees;
      const makerScore = maker.accruedFeesUsdEffective ** FEE_WEIGHT;

      for (const rewardToken of rewardTokens) {
        const totalRewards = BigInt(rewardToken.amount);
        const makerRewards = new Fraction(totalRewards)
          .multiply(toFraction(makerScore))
          .divide(toFraction(totalFeesWeighted));
        const isPUR = rewardToken.address === PUR.address;
        const isMAS =
          rewardToken.address === "" || rewardToken.address === WMAS.address;
        const streakMultiplier =
          isPUR || (isMAS && epoch >= 63)
            ? 0
            : Math.min(30, 5 * accruedFees.streak);
        const streakRewards = makerRewards.multiply(
          new Fraction(BigInt(streakMultiplier), 100n)
        );
        const makerRewardsWithStreak = makerRewards.add(streakRewards);
        const rewardPercentage = makerRewards
          .multiply(100n)
          .divide(totalRewards);

        const parse = (token: PrismaToken, val: BigintIsh) =>
          roundFraction(new TokenAmount(toToken(token), val));

        if (makerRewards.denominator == 0n) continue;
        excelData.push({
          userAddress: maker.address,
          accruedFeesX: parse(token0, accruedFees.accruedFeesX).toString(),
          accruedFeesY: parse(token1, accruedFees.accruedFeesY).toString(),
          accruedFeesL: parse(token1, accruedFees.accruedFeesL).toString(),
          accruedFeesUsd: maker.accruedFeesUsd,
          accruedFeesUsdEffective: maker.accruedFeesUsdEffective,
          percentOfTotalFees,
          poolAddress,
          makerScore,
          makerRank: i,
          rewardPercentage: roundFraction(rewardPercentage),
          rewardToken: rewardToken.token.symbol,
          makerRewards: parse(rewardToken.token, makerRewards.quotient),
          makerRewardsRaw: makerRewards.quotient.toString(),
          makerRewardsWithStreak: parse(
            rewardToken.token,
            makerRewardsWithStreak.quotient
          ),
          makerRewardsWithStreakRaw: makerRewardsWithStreak.quotient.toString(),
          pairName: token0.symbol + "_" + token1.symbol + "-" + binStep,
          rewardEpoch: epoch,
          rewardAmount: parse(rewardToken.token, totalRewards),
          weeklyStreak: accruedFees.streak,
        });
      }
    }

    const rewards: RewardData[] = rewardTokens.map((rewardToken) => {
      const totalRewards = BigInt(rewardToken.amount);
      return {
        totalRewards,
        address: rewardToken.address,
        length: makers.length,
        users: makers.map((maker) => {
          const amount = excelData.find(
            (data) =>
              data.poolAddress === poolAddress &&
              data.userAddress === maker.address &&
              data.rewardToken === rewardToken.token.symbol
          )?.makerRewardsWithStreakRaw;
          if (!amount) return { address: maker.address, amount: 0n };

          return { address: maker.address, amount: BigInt(amount) };
        }),
      };
    });

    // increase total rewards to match streak bonuses
    rewards.forEach((reward) => {
      const rewardSum = reward.users.reduce(
        (acc, user) => acc + user.amount,
        0n
      );
      console.log(reward.totalRewards, rewardSum);
      reward.totalRewards = rewardSum;
    });

    jsonData.markets.push({
      address: poolAddress,
      epoch,
      start: to.getTime(),
      duration: 0,
      length: market.rewardTokens.length,
      rewards,
    });
    jsonData.length++;
  }

  saveJSONFile(jsonData);
  saveXLSXFile(excelData);
  saveDB(excelData);
};

const airdrop = async () => {
  const uniqueUsers = await prisma.points.findMany({
    distinct: ["userAddress"],
  });
  const users = uniqueUsers.map((user) => user.userAddress);
  console.log("Airdropping to", users.length, "users");

  const jsonData: JSONData = { length: 1, markets: [] };

  jsonData.markets.push({
    address: "airdrop",
    epoch: 63,
    duration: 0,
    start: Date.now(),
    length: 1,
    rewards: [
      {
        length: users.length,
        address: JELLY.address,
        totalRewards: 0n,
        users: [],
      },
    ],
  });

  let totalRewards = 0n;
  let subCount = 0;
  for (const [index, user] of users.entries()) {
    const balance = await new IERC20(JELLY.address, web3Client).balanceOf(user);
    console.log(index, user, printTA(JELLY, balance));
    jsonData.markets[0].rewards[0].users.push({
      address: user,
      amount: balance,
    });
    totalRewards += balance;
    if (balance < parseUnits("10", JELLY.decimals)) subCount++;

    await wait(200);
  }
  console.log(subCount);

  jsonData.markets[0].rewards[0].totalRewards = totalRewards;
  saveJSONFile(jsonData, "airdrop.json");
};

(async () => {
  // // run from epoch 1 to 33
  // for (let i = 1; i <= 33; i++) {
  //   await main();
  //   epoch++;
  //   from = new Date(from.getTime() + ONE_WEEK - 1);
  //   to = new Date(from.getTime() + ONE_WEEK - 1);
  // }
  //
  // // run for one epoch
  // await main();
  await airdrop();
})();

// @ts-expect-error: Property 'toJSON' does not exist on type 'BigInt'
BigInt.prototype.toJSON = function (): string {
  return this.toString();
};
