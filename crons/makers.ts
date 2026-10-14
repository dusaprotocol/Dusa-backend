import { ILBPair, Percent } from "@dusalabs/sdk";
import { handlePrismaError, prisma } from "../common/db";
import { getDailyTick, getHourlyTick, ONE_HOUR } from "../common/utils";
import { web3Client } from "../common/client";
import {
  masEthPairV1,
  masEthPairV2,
  masUsdcPairV1,
  masUsdcPairV2,
} from "../common/contracts";
import { getLedgerEntries2 } from "../indexer/src/db";
import { Args } from "@massalabs/massa-web3";

const MAX_ACTIVE_BIN_OWN_PERC = new Percent(25n, 100n);
const MAX_ACTIVE_BIN_RADIUS = 50;
const MAX_ACTIVE_BIN_TOTAL_PERC = new Percent(50n, 100n);
const WHITELIST = ["AU1AoSDvNLknftvrMkhrHfuUupyhY1MQ4qQ5ATs1NTuJHeK56spg"];

// print the last 6 characters of an address
const printAddress = (address: string) => address.slice(-6);

// @notice a maker is ineligible if it meets any of the following conditions:
// 1. has more than 25% of its liquidity in the active bin
// 2. has traded both ways in the last hour
// 3. has more than 50% of the active bin's liquidity and is not whitelisted
// 4. has updated its liquidity (add/remove) in the active bin in the last hour

export const checkMakersEligibility = async (poolAddress: string) => {
  const date = getHourlyTick();
  const pair = new ILBPair(poolAddress, web3Client);
  const { activeId } = await pair.getReservesAndId();
  const makers = await prisma.maker.findMany({
    where: { poolAddress, date },
  });
  for (const maker of makers) {
    const userBinsRaw = await pair.getUserBinIds(maker.address);
    if (!userBinsRaw.length) continue;

    const userBins = userBinsRaw.filter(
      (binId) =>
        binId > activeId - MAX_ACTIVE_BIN_RADIUS &&
        binId < activeId + MAX_ACTIVE_BIN_RADIUS
    );
    const activeBinIndex = userBins.findIndex((binId) => binId === activeId);
    if (activeBinIndex === -1) continue;

    const balances = await pair.balanceOfBatch(
      Array.from({ length: userBins.length }, (_, i) => maker.address),
      userBins
    );
    const activeBinOwnPerc = new Percent(
      balances[activeBinIndex],
      balances.reduce((a, b) => a + b, 0n)
    );
    if (activeBinOwnPerc.lessThan(MAX_ACTIVE_BIN_OWN_PERC)) continue;

    // maker activity one hour ago
    const prevState = await getLedgerEntries2(
      poolAddress,
      new Date(Date.now() - ONE_HOUR),
      userBins.map((id) => `balances::${id}:${maker.address}`)
    );
    const prevBalances = prevState.map((e) =>
      e.value ? new Args(e.value).nextU256() : 0n
    );
    if (balances[activeBinIndex] === prevBalances[activeBinIndex]) continue;

    // trade activity
    const ownSwaps = await prisma.swap.findMany({
      where: {
        timestamp: { gte: date },
        poolAddress,
        userAddress: maker.address,
      },
    });
    const susBehaviour =
      ownSwaps.some((swap) => swap.swapForY) &&
      ownSwaps.some((swap) => !swap.swapForY);
    // const ownVolume = ownSwaps.reduce((acc, swap) => acc + swap.usdValue, 0);
    if (!susBehaviour) continue;

    const supplies = await pair.getSupplies(userBins);
    const activeBinTotalPerc = new Percent(
      balances[activeBinIndex],
      supplies[activeBinIndex]
    );
    if (activeBinTotalPerc.lessThan(MAX_ACTIVE_BIN_TOTAL_PERC)) continue;
    if (WHITELIST.includes(maker.address)) continue;

    console.log(
      `${printAddress(
        maker.address
      )} has ${activeBinOwnPerc.toSignificant()}% in active bin (${activeBinTotalPerc.toSignificant()}% of total)`
    );
    await prisma.maker
      .update({
        where: {
          address_poolAddress_date: {
            address: maker.address,
            poolAddress,
            date,
          },
        },
        data: { accruedFeesUsdEffective: 0 },
      })
      .then(() => console.log(`Reset maker ${printAddress(maker.address)}`))
      .catch(handlePrismaError);
  }
};

(async () => {
  await checkMakersEligibility(masUsdcPairV1);
  await checkMakersEligibility(masUsdcPairV2);
  await checkMakersEligibility(masEthPairV1);
  await checkMakersEligibility(masEthPairV2);
})();
