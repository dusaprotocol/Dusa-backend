import { Prisma } from "@prisma/client";
import {
  computePoints,
  getDiscordUsers,
  getMakers,
  getReferrals,
  getSwapers,
  processPoints,
} from "./methods";
import { prisma } from "../../common/db";
import { ONE_DAY, ONE_WEEK, getDailyTick, wait } from "../../common/utils";

// eslint-disable-next-line @typescript-eslint/no-unused-vars
const main = async (from: Date) => {
  try {
    const to = new Date(from.getTime() + ONE_WEEK - 1);
    const date = getDailyTick(to.getTime() + 1);
    console.log(from, to, date);
    await prisma.points.deleteMany({ where: { date } });

    const swapers = await getSwapers(from, to);
    console.log("swapers", swapers.length);
    const makers = await getMakers(from, to);
    console.log("makers", makers.length);
    const referrals = await getReferrals(from, to);
    console.log("referrals", referrals.length);
    const discordUsers = await getDiscordUsers();
    console.log("discordUsers", discordUsers.length);

    const record = await processPoints(
      swapers,
      makers,
      referrals,
      discordUsers
    );

    const data = computePoints(record, date);
    await prisma.points.createMany({ data }).then(console.log);
  } catch (e) {
    console.error(e);
  }
};

(async () => {
  // run for all weeks
  // let now = Date.UTC(2024, 3, 19) - ONE_WEEK; // first friday before launch
  // while (now < Date.now() - ONE_WEEK) {
  //   const from = new Date(getDailyTick(now));
  //   await main(from);
  //   now += ONE_WEEK;
  // }
  //
  // only run for one week (set date as latest entries in db)
  // const from = getDailyTick(Date.UTC(2025, 0, 10));
  // await main(from);
})();
