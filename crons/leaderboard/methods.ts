import { Prisma } from "@prisma/client";
import { prisma } from "../../common/db";
import { getRoles as _getRoles } from "../../api/src/discord";
import {
  BLACKLIST as _BLACKLIST,
  GREYLIST,
  SYBILS,
  MAKER_MULTIPLIER,
  REFERRAL_BONUS,
  WEEKLY_POINTS,
} from "../../common/config";
import { cache } from "../../common/methods";
import { ONE_DAY } from "../../common/utils";

const getRoles = cache(_getRoles, { ttl: ONE_DAY / 1000 });

type Data = Omit<
  Prisma.PointsGetPayload<{}>,
  "date" | "userAddress" | "points"
>;

const BLACKLIST = [..._BLACKLIST, ...GREYLIST];

const getSwapValue = (feesUsdValue: number) => feesUsdValue;
const getMakerValue = (maker: Maker) =>
  maker.accruedFeesUsdEffective * MAKER_MULTIPLIER;

export const getSwapers = async (from: Date, to: Date) => {
  return prisma.$queryRaw<Swaper[]>`
  SELECT
    userAddress,
    SUM(feesUsdValue) AS feesUsdValue
  FROM
    Swap INNER JOIN Pool ON Swap.poolAddress = Pool.address
  WHERE
    timestamp BETWEEN ${from} AND ${to}
    AND Pool.whitelisted = 1
    AND userAddress NOT IN (${Prisma.join(BLACKLIST)})
  GROUP BY userAddress;
  `;
};

type Maker = Prisma.MakerGetPayload<{
  select: {
    address: true;
    accruedFeesUsdEffective: true;
    volume: true;
  };
}>;

type Swaper = Prisma.SwapGetPayload<{
  select: {
    userAddress: true;
    feesUsdValue: true;
  };
}>;

export const getMakers = async (from: Date, to: Date) => {
  return prisma.$queryRaw<Maker[]>`
    SELECT Maker.address, SUM(accruedFeesUsdEffective) as accruedFeesUsdEffective, SUM(volume) as volume
    FROM Maker INNER JOIN Pool ON Maker.poolAddress = Pool.address
    WHERE 
      date BETWEEN ${from} AND ${to} 
      AND Pool.whitelisted = 1
      AND Maker.address NOT IN (${Prisma.join(BLACKLIST)})
    GROUP BY Maker.address
  `;
};

export const getReferrals = async (from: Date, to: Date) => {
  return prisma.referral.findMany({
    where: {
      createdAt: { lte: to },
      godfatherAddress: { notIn: BLACKLIST },
      userAddress: { notIn: BLACKLIST },
    },
    orderBy: { createdAt: "asc" },
  });
};

export const getDiscordUsers = async () => {
  return prisma.user.findMany({
    select: { address: true, discordId: true },
    where: { discordId: { not: null }, address: { notIn: BLACKLIST } },
  });
};

export const processPoints = async (
  swapers: Awaited<ReturnType<typeof getSwapers>>,
  makers: Awaited<ReturnType<typeof getMakers>>,
  referrals: Omit<Prisma.ReferralGetPayload<{}>, "createdAt">[],
  discordUsers: Prisma.UserGetPayload<{
    select: { address: true; discordId: true };
  }>[]
) => {
  const record: Record<string, Data> = {};

  const emptyRecord: Data = {
    discordScore: 0,
    makerScore: 0,
    referralScore: 0,
    swapScore: 0,
    totalScore: 0,
  };

  // process swaps
  for (const swaper of swapers) {
    const swapScore = getSwapValue(swaper.feesUsdValue);
    record[swaper.userAddress] = {
      ...emptyRecord,
      swapScore,
      totalScore: swapScore,
    };
  }

  // process makers
  for (const maker of makers) {
    const makerScore = getMakerValue(maker);
    if (record[maker.address]) {
      record[maker.address].makerScore = makerScore;
      record[maker.address].totalScore += makerScore;
    } else {
      record[maker.address] = {
        ...emptyRecord,
        makerScore,
        totalScore: makerScore,
      };
    }
  }

  // process referrals
  for (const referral of referrals) {
    const parrain = referral.godfatherAddress;
    const filleul = referral.userAddress;
    if (!record[filleul]?.totalScore || parrain === filleul) continue;

    const onChainScore = record[filleul].swapScore + record[filleul].makerScore;
    const bonus = onChainScore * (REFERRAL_BONUS / 100);
    record[filleul].referralScore += bonus;
    record[filleul].totalScore += bonus;

    if (record[parrain])
      record[parrain] = {
        ...record[parrain],
        referralScore: record[parrain].referralScore + bonus,
        totalScore: record[parrain].totalScore + bonus,
      };
    else {
      record[parrain] = { ...emptyRecord };
      record[parrain].referralScore = bonus;
      record[parrain].totalScore += bonus;
    }
  }

  // process discord roles
  for (const user of discordUsers) {
    if (!record[user.address]) continue;

    const onChainScore =
      record[user.address].swapScore + record[user.address].makerScore;
    const discordRoles = await getRoles(user.discordId!);
    const bonus = onChainScore * discordRoles[0]?.boost || 0;
    record[user.address].discordScore = bonus;
    record[user.address].totalScore += bonus;
  }

  for (const sybil of SYBILS) {
    if (!record[sybil]) continue;
    record[sybil].totalScore = record[sybil].totalScore * 0.3;
  }
  return record;
};

export const computePoints = (
  record: Awaited<ReturnType<typeof processPoints>>,
  date: Date
) => {
  const totalScore = Object.values(record).reduce(
    (acc, user) => acc + user.totalScore,
    0
  );

  return Object.keys(record).map((user) => {
    const userScore = record[user].totalScore;
    const userPoints = (userScore / totalScore) * WEEKLY_POINTS;
    return {
      ...record[user],
      date,
      userAddress: user,
      points: userPoints,
    };
  });
};
