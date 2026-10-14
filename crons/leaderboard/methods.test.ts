import { describe, expect, it, vi } from "vitest";
import { computePoints, getMakers, getSwapers, processPoints } from "./methods";
import { roles } from "../../common/discord";
import { prisma } from "../../common/db";
import { ONE_DAY, getDailyTick } from "../../common/utils";
import { SYBILS } from "../../common/config";

vi.mock("../../api/src/discord", () => ({
  getRoles: async () => roles,
}));
// SYBILS comes from private config (SYBIL_ADDRESSES): use a fixture address here
vi.mock("../../common/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../common/config")>()),
  SYBILS: ["AU1sybilFixtureAddress"],
}));

const isLocalDatabase = () => {
  try {
    const { hostname } = new URL(process.env.DATABASE_URL ?? "");
    return ["localhost", "127.0.0.1", "::1"].includes(hostname);
  } catch {
    return false;
  }
};

type Params = Parameters<typeof processPoints>;
describe("leaderboard", () => {
  const user1Address = "0x1";
  const user2Address = "0x2";

  it("", async () => {
    const swapers: Params["0"] = [
      { userAddress: user1Address, feesUsdValue: 100 },
      { userAddress: user2Address, feesUsdValue: 50 },
    ];
    const makers: Params["1"] = [];
    const referrals: Params["2"] = [
      { godfatherAddress: user1Address, userAddress: user2Address },
    ];
    const discordUsers: Params["3"] = [
      { address: user1Address, discordId: "AAA" },
    ];

    const res = await processPoints(swapers, makers, referrals, discordUsers);
    const user1 = res[user1Address];
    const user2 = res[user2Address];

    expect(user1.totalScore).not.toEqual(user2.totalScore);
    expect(user1.discordScore).toBeGreaterThan(0);
    expect(user1.totalScore).toEqual(
      user1.swapScore + user1.discordScore + user1.referralScore
    );
    expect(user1.referralScore).toEqual(user2.referralScore);
  });
  it("two users with equal on chain", async () => {
    const swapers: Params["0"] = [
      { userAddress: user1Address, feesUsdValue: 50 },
      { userAddress: user2Address, feesUsdValue: 50 },
    ];
    const makers: Params["1"] = [];
    const referrals: Params["2"] = [];
    const discordUsers: Params["3"] = [
      { address: user1Address, discordId: "AAA" },
    ];

    const record = await processPoints(
      swapers,
      makers,
      referrals,
      discordUsers
    );
    const data = computePoints(record, new Date());

    expect(record[user1Address].swapScore).toEqual(
      record[user2Address].swapScore
    );
    expect(record[user1Address].totalScore).not.toEqual(
      record[user2Address].totalScore
    );

    const user1Points = data.find(
      (p) => p.userAddress === user1Address
    )?.points;
    const user2Points = data.find(
      (p) => p.userAddress === user2Address
    )?.points;
    expect(user1Points).not.toEqual(user2Points);
  });
  it("user w/ 0 score", async () => {
    const swapers: Params["0"] = [
      { userAddress: user1Address, feesUsdValue: 0 },
      { userAddress: user2Address, feesUsdValue: 50 },
    ];
    const makers: Params["1"] = [];
    const referrals: Params["2"] = [];
    const discordUsers: Params["3"] = [];

    const record = await processPoints(
      swapers,
      makers,
      referrals,
      discordUsers
    );
    const data = computePoints(record, new Date());

    expect(record[user1Address].swapScore).toEqual(0);
    expect(record[user1Address].makerScore).toEqual(0);
    expect(record[user1Address].referralScore).toEqual(0);
    expect(record[user1Address].discordScore).toEqual(0);
    expect(record[user1Address].totalScore).toEqual(0);

    const user1Points = data.find(
      (p) => p.userAddress === user1Address
    )?.points;
    expect(user1Points).toEqual(0);
  });
  it("user w/ sybil behaviour", async () => {
    const swapers: Params["0"] = [
      { userAddress: SYBILS[0], feesUsdValue: 50 },
      { userAddress: user2Address, feesUsdValue: 50 },
    ];
    const makers: Params["1"] = [];
    const referrals: Params["2"] = [];
    const discordUsers: Params["3"] = [];

    const record = await processPoints(
      swapers,
      makers,
      referrals,
      discordUsers
    );
    const data = computePoints(record, new Date());

    const user1 = record[SYBILS[0]];
    const user2 = record[user2Address];
    expect(user1.totalScore).not.toEqual(user2.totalScore);
    expect(user1.totalScore).toBeGreaterThan(0);

    // const user1Points = data.find((p) => p.userAddress === SYBILS[0])?.points;
    // expect(user1Points).not.toEqual(0);
  });
  // Reads and DELETES Points rows in the database behind DATABASE_URL: only run it
  // against a local database, never in CI or against a shared/production one.
  it.skipIf(!!process.env.CI || !isLocalDatabase())("actual data", async () => {
    const from = getDailyTick(Date.UTC(2024, 10, 15));
    const to = new Date(from.getTime() + ONE_DAY * 7 - 1);
    const date = getDailyTick(to.getTime() + 1);
    await prisma.points.deleteMany({ where: { date } });

    const swapers = await getSwapers(from, to);
    const makers = await getMakers(from, to);
    const referrals = await prisma.referral.findMany({
      where: { createdAt: { lte: to } },
    });
    const discordUsers = await prisma.user.findMany({
      select: { address: true, discordId: true },
      where: { discordId: { not: null } },
    });

    const record = await processPoints(
      swapers,
      makers,
      referrals,
      discordUsers
    );
    const user = "AU12ScWGycW9sZNbCBq6QgJos2DpBNr6J8CLbMPNWeFFQoRiw3nqD";
    console.log(record[user]);

    const data = computePoints(record, date);
    const userWith0Score = data.find(
      (p) =>
        p.swapScore === 0 &&
        p.makerScore === 0 &&
        p.referralScore === 0 &&
        p.discordScore === 0
    );
    expect(userWith0Score?.userAddress).toBeUndefined();
    expect(userWith0Score?.points || 0).toEqual(0);
  });
});
