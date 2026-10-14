import { Token as PrismaToken } from "@prisma/client";
import { handlePrismaError, prisma } from "../../common/db";
import { readFileSync, writeFile } from "fs";
import {
  EventDecoder,
  Fraction,
  IBaseContract,
  ILBPair,
  TokenAmount,
  IERC20,
  Token,
  parseUnits,
  IMulticall,
  Tx,
  IVotingEscrow,
  LockedBalance,
} from "@dusalabs/sdk";
import { Address, ONE_DAY, ONE_HOUR, ONE_MINUTE } from "../../common/utils";
import {
  abs,
  isAddressValid,
  printTA,
  toFraction,
  toToken,
} from "../../common/methods";
import { BigintIsh } from "@dusalabs/sdk/dist/constants";
import {
  calculateEpochDates,
  EXCL_DUSA_CIRCULATING,
  lastEpoch,
} from "../../common/config";
import {
  btcUsdcPairV2,
  DUSA,
  V2_PAIRS,
  voterSC,
  votingEscrowSC,
  multicallSC,
  v2RewarderSC,
  usdcDaiPairV2,
  TOKENS,
  JELLY,
  tokenList,
} from "../../common/contracts";
import { web3Client } from "../../common/client";
import { getLedgerEntries2, getLedgerEntries3 } from "../../indexer/src/db";
import {
  fetchEvents,
  fetchTokenFromAddress,
  getDatastoreKeys,
  getTokenValueRaw,
} from "../../common/datastoreFetcher";
import {
  Args,
  bytesToStr,
  U256,
  U64,
  Account,
  Web3Provider,
} from "@massalabs/massa-web3";
import * as T from "../src/rewards";
import { MASSA_EXEC_ERROR } from "../../common/eventPoller";
import path from "path";
import { convertJsonToDataRoot } from "./rewarderClasses";

// TYPES
type UserData = T.UserData;
type RewardData = T.RewardData;
type MarketData = T.MarketData;
type JSONData = T.JSONData;

type ProtocolFees = { amount0: bigint; amount1: bigint };

// CONSTANTS

const gov = "AU1GkftgcEZdjv1KRCqBDCWgZfnFPf8ftwHDxACA3MZsU2DbMCWY";
const team = "AU1cBirTno1FrMVpUMT96KiQ97wBqqM1z9uJLr3XZKQwJjFLPEar";
const argsDelimiter = ";?!";
const now = Date.now();

const epoch = lastEpoch.id;
const { from, to } = calculateEpochDates(epoch);

const WEEKLY_EMISSIONS = parseUnits("39000", 18); // 39,000 DUSA per week total
const LOW_VOLUME_POOLS = [btcUsdcPairV2, usdcDaiPairV2];
// Pools whose protocol fees are collected and paid to voters. Collecting makes
// the pair call its tokens inside a gov-signed operation, and gov owns the
// rewarder: only add a pool whose tokens are trusted and can't change code.
const FEE_COLLECTION_POOLS = new Set<string>([
  "AS1TVRnzkRZCeWW32tEiymnz3ghkRB28ijBPczTM5BjCrKxbazm1", // WMAS/USDC.e
  "AS1GgHvg6fpaHD2i5JZC5ijEDYzpNFbCE5B3GwFLGJy5KtPLH7Ly", // DUSA/WMAS
  "AS146g616AcTMnqxP1hL2pt75ui4suY8Fq6mYPHYvCx94WKnfW9Q", // WETH.e/WMAS
  "AS186T6EhKppUa1foy61So9z8ZPgxevZHWRpzBXvhujhsMwSNcAM", // WBTC.e/USDC.e
  "AS1mEuqfdGoTEneLxCXifS7dckshu714roZcv9nJGk5dVzVoXJSV", // DAI.e/USDC.e
  "AS12FjoDGyUvDGq5E4AdyaJMZ9eT8Kcgxdi5QAkmaX7rvozYBS3XQ", // USDT.b/USDC.e
  "AS12Z25g7rM2ASuNh8TaepyFQ9pvNtLf4ioKQDuer4Ljwza7ifRCK", // WETH.b/WETH.e
  "AS12LVBd1eRUqdh42476VMgWiFTM9vZfLX6hDXQuEMaffXsZFNXij", // FPOM/WMAS
  "AS12Yn9aHfLMoavtdb9vXhhpq8qXvDrC2LGWqxPqPwk5VLW6qJcLq", // POM/WMAS
  "AS123os7LmfBD6yrXmhJv4ruc9BmPcGfmZbhBE1n7VEeTvynFBDpJ", // PUR/WMAS
  "AS12LUx1SYarpu5vRrrMHQE7DX2z4U5We3XFTE54QP7so8h6Gj9DP", // PUR/USDC.e
  "AS1tnZc9iWKrE77on7sVqZ5FqaHw81jVXjLChVT8vnmyxBKRRE93", // MC/WMAS
]);
const VE_MAXTIME = BigInt(4 * 365 * ONE_DAY); // veDUSA max lock duration (ms)

// CONFIG

const saveToDB = true;
const sendTxs = true;

// Wallets whose voting rewards are summed in the logs (monitoring only, no effect on
// payouts). Kept out of the repository: comma-separated list in SPECIAL_USERS.
const specialUsers = (process.env.SPECIAL_USERS ?? "")
  .split(",")
  .map((a) => a.trim())
  .filter(Boolean);
let specialUsersSum: number[] = Array<number>(specialUsers.length).fill(0);
const specialUsersRewards = new Map<string, Map<string, bigint>>();
const specialUser = process.env.SPECIAL_USER ?? ""; // one wallet logged in detail
let specialUserSum = 0;
const specialUserRewards = new Map<string, bigint>();

// TOKEN VALUES

const uniqueTokens = tokenList;

const _globalDollarValues = await Promise.allSettled(
  uniqueTokens.map((token) => getTokenValueRaw(token))
);
const rejected = _globalDollarValues.filter((v) => v.status === "rejected");
if (rejected.length)
  console.log(
    `Failed to fetch dollar value for ${rejected.length} tokens: ${rejected
      .map((r, i) => uniqueTokens[i])
      .join(", ")}`
  );
const globalDollarValues = _globalDollarValues.map((v) =>
  v.status === "fulfilled" ? v.value : 0
);

// SAVE FILE

const saveJSONFile = (data: JSONData, filename: string) => {
  writeFile(
    filename,
    JSON.stringify(data, null, 2),
    (err) => err && console.error(err)
  );
};

// COMPARE JSON

const compareJSON = async (file1: string, file2: string) => {
  const data1: JSONData = JSON.parse(readFileSync(file1, "utf-8"));
  const data2: JSONData = JSON.parse(readFileSync(file2, "utf-8"));
  const maxLength = Math.max(data1.length, data2.length);
  const is1stLonger = data1.length > data2.length;
  const totalSum1 = new Map<string, bigint>();
  const totalSum2 = new Map<string, bigint>();
  let count = 0;

  for (let i = 0; i < maxLength; i++) {
    let sum1 = 0n;
    let sum2 = 0n;

    const market1 = data1.markets[i];
    const market2 = data2.markets[i];
    const market = is1stLonger ? market1 : market2;
    const split = market.address.split("vote-");
    const poolAddress = split[split.length - 1];
    const reward = market.rewards[0];
    const rewardToken = await fetchTokenFromAddress(reward.address);
    const rewardTokenIndex = uniqueTokens.findIndex(
      (token) => token.address === reward.address
    );
    const rewardTokenValue = globalDollarValues[rewardTokenIndex];
    const { token0, token1 } = await prisma.pool.findUniqueOrThrow({
      where: { address: poolAddress },
      include: { token0: true, token1: true },
    });
    console.log(token0.symbol, token1.symbol, `(${rewardToken.symbol})`);

    const correspondingMarket = (is1stLonger ? data2 : data1).markets.find(
      (m) =>
        m.address === market.address && m.rewards[0].address === reward.address
    );
    const emptyMarket: T.MarketData = {
      address: market.address,
      duration: 0,
      epoch: 0,
      start: 0,
      length: 1,
      rewards: [
        { totalRewards: 0n, users: [], address: reward.address, length: 0 },
      ],
    };
    const otherMarket = correspondingMarket || emptyMarket;
    const otherReward = otherMarket.rewards[0];

    const distinctUsers = new Set([
      ...reward.users.map((u) => u.address),
      ...otherReward.users.map((u) => u.address),
    ]);
    for (const user of distinctUsers) {
      const reward1 = BigInt(
        reward.users.find((u) => u.address === user)?.amount || 0
      );
      const reward2 = BigInt(
        otherReward.users.find((u) => u.address === user)?.amount || 0
      );
      if (reward1 === reward2) continue;

      const diff = abs(reward1 - reward2);
      const diffValue = Number(
        new TokenAmount(rewardToken, diff)
          .multiply(toFraction(rewardTokenValue))
          .toFixed(2)
      );
      if (user === specialUser) console.log(diffValue);

      if (reward1 > reward2) {
        if (diffValue < 0.25) continue;

        count++;
        if (!sendTxs) continue;

        console.time("db");
        const existingTransfer = await prisma.operation.findFirst({
          where: {
            callerAddress: gov,
            targetAddress: reward.address,
            targetFunction: "transfer",
            data: Buffer.from(
              new Args().addString(user).addU256(diff).serialize()
            ),
          },
          include: { events: true },
        });
        console.timeEnd("db");
        if (
          existingTransfer &&
          existingTransfer.events.every(
            (e) => !e.data.includes(MASSA_EXEC_ERROR)
          )
        )
          continue;

        const tx = await new IERC20(reward.address, web3Client).transfer(
          user,
          diff
        );
        console.log(
          `Transfer ${printTA(rewardToken, diff)} ${rewardToken.symbol} ($${diffValue}) to ${user}`,
          tx.id
        );
        await tx.waitSpeculativeExecution();
        const { isError, events } = await fetchEvents(tx.id);
        if (isError) throw new Error(events[0].data);
      } else {
        console.log("too much", diffValue);
      }
      sum1 += reward1;
      sum2 += reward2;
      totalSum1.set(
        rewardToken.address,
        (totalSum1.get(rewardToken.address) || 0n) + reward1
      );
      totalSum2.set(
        rewardToken.address,
        (totalSum2.get(rewardToken.address) || 0n) + reward2
      );
    }
    // console.log(
    //   printTA(rewardToken, sum1),
    //   "vs",
    //   printTA(rewardToken, sum2),
    //   rewardToken.symbol,
    //   "\n"
    // );
  }

  // for (const [address, amount] of totalSum1) {
  //   const t = await fetchTokenFromAddress(address);
  //   console.log(t.symbol);
  //   console.log(
  //     printTA(t, amount),
  //     "vs",
  //     printTA(t, totalSum2.get(address) || 0n),
  //     "\n"
  //   );
  // }

  console.log({ count });
};

// REGEN PROTOCOL FEES
const regenFeesBatch = async (e: number, save: boolean) => {
  // Track totals by token address for each method
  const bddTotals = new Map<string, Fraction>();
  const accTotals = new Map<string, Fraction>();
  const swpTotals = new Map<string, Fraction>();

  for (const pairAddress of V2_PAIRS) {
    const d = await regenFees(pairAddress, e, save);

    // Accumulate values by token
    const addToMap = (
      map: Map<string, Fraction>,
      token: string,
      value: Fraction
    ) => {
      const current = map.get(token) || new Fraction(0n);
      map.set(token, current.add(value));
    };

    // if (d.bddValues) {
    //   addToMap(bddTotals, d.token0Address, d.bddValues.value0);
    //   addToMap(bddTotals, d.token1Address, d.bddValues.value1);
    // }
    // if (d.accValues) {
    //   addToMap(accTotals, d.token0Address, d.accValues.value0);
    //   addToMap(accTotals, d.token1Address, d.accValues.value1);
    // }
    // if (d.swpValues) {
    //   addToMap(swpTotals, d.token0Address, d.swpValues.value0);
    //   addToMap(swpTotals, d.token1Address, d.swpValues.value1);
    // }
  }

  // Print totals
  console.log("\n" + "=".repeat(60));
  console.log("TOTAL FEES ACROSS ALL POOLS");
  console.log("=".repeat(60));

  const printTotals = async (title: string, totals: Map<string, Fraction>) => {
    console.log(`\n${title}:`);
    const sortedEntries = Array.from(totals.entries()).sort(
      (a, b) => Number(b[1].toSignificant(6)) - Number(a[1].toSignificant(6))
    );
    let grandTotal = new Fraction(0n);
    for (const [tokenAddress, value] of sortedEntries) {
      if (value.quotient === 0n) continue;

      const token = await prisma.token.findUnique({
        where: { address: tokenAddress },
      });
      console.log(`  ${token?.symbol || tokenAddress}: $${value.toFixed(2)}`);
      grandTotal = grandTotal.add(value);
    }
    console.log(`  TOTAL: $${grandTotal.toFixed(2)}`);
  };

  await printTotals("BDD (Database)", bddTotals);
  await printTotals("ACC (Accumulated)", accTotals);
  await printTotals("SWP (Swaps)", swpTotals);
  console.log("=".repeat(60));
};

/**
 * Regenerate protocol fees for a specific pair and save to database
 * @param pairAddress
 * @param e
 * @param save
 * @returns
 */
const regenFees = async (pairAddress: string, e: number, save: boolean) => {
  const { from, to } = calculateEpochDates(e);
  console.log(`Epoch ${e}: from ${from.toISOString()} to ${to.toISOString()}`);
  const { token0, token1 } = await prisma.pool.findUniqueOrThrow({
    where: { address: pairAddress },
    include: { token0: true, token1: true },
  });

  const token0Index = uniqueTokens.findIndex(
    (t) => t.address === token0.address
  );
  const token1Index = uniqueTokens.findIndex(
    (t) => t.address === token1.address
  );
  const t0 = toToken(token0);
  const t1 = toToken(token1);
  const token0Value = globalDollarValues[token0Index];
  const token1Value = globalDollarValues[token1Index];
  console.log(`Pair ${token0.symbol}/${token1.symbol}`);

  const feesFrom = await _getProtocolFees(pairAddress, from.getTime());
  const feesTo = await _getProtocolFees(pairAddress, to.getTime());
  console.log(
    `Fees: from ${printTA(token0, feesFrom.amount0)} ${token0.symbol}, ${printTA(token1, feesFrom.amount1)} ${token1.symbol} to ${printTA(token0, feesTo.amount0)} ${token0.symbol}, ${printTA(token1, feesTo.amount1)} ${token1.symbol}`
  );

  // const swaps = await prisma.swap.findMany({
  //   where: {
  //     poolAddress: pairAddress,
  //     timestamp: { gte: from, lt: to },
  //   },
  // });
  // const swapsFees = swaps.reduce(
  //   (acc, swap) => {
  //     if (swap.swapForY) acc.amount0 += BigInt(swap.feesIn);
  //     else acc.amount1 += BigInt(swap.feesIn);
  //     return acc;
  //   },
  //   { amount0: 0n, amount1: 0n }
  // );

  // console.log(
  //   `Swaps: ${printTA(token0, swapsFees.amount0)} ${token0.symbol}, ${printTA(token1, swapsFees.amount1)} ${token1.symbol}`
  // );

  const collectOps = await prisma.operation.findMany({
    where: {
      targetAddress: pairAddress,
      targetFunction: "collectProtocolFees",
      createdAt: { gte: from, lt: to },
    },
    orderBy: { createdAt: "asc" },
  });

  let lastSnapshot = feesFrom;
  let accumulatedFees = { amount0: 0n, amount1: 0n };
  let collectedFees = { amount0: 0n, amount1: 0n };
  let i = 0;
  for (const op of collectOps) {
    const events = await prisma.event.findMany({
      where: { operationId: op.id },
    });
    if (events.some((e) => e.data.toString().includes(MASSA_EXEC_ERROR))) {
      console.log("failed tx");
      continue; // skip failed tx
    }

    const ts = op.createdAt.getTime();
    const lastTs = collectOps[i - 1]?.createdAt.getTime() || 0;
    if (i > 0 && lastTs + ONE_MINUTE > ts) {
      console.log("duplicate tx", new Date(ts), new Date(lastTs));
      continue; // skip duplicate collects within 1 minute
    }

    for (const event of events) {
      const eventData = event.data.toString();
      if (eventData.startsWith("PROTOCOL_FEES_COLLECTED:")) {
        const args = EventDecoder.decodeCollectFees(eventData);
        collectedFees.amount0 += args.amountX;
        collectedFees.amount1 += args.amountY;
      }
    }
    console.log(
      `Tx ${op.id}: ${printTA(token0, collectedFees.amount0)} ${token0.symbol}, ${printTA(token1, collectedFees.amount1)} ${token1.symbol}`
    );
    if (collectedFees.amount0 === 0n && collectedFees.amount1 === 0n) continue; // handle duplicate collects with no fees

    const fees = await _getProtocolFees(
      pairAddress,
      op.createdAt.getTime() - ONE_MINUTE
    );
    console.log(
      `Fees at ${op.createdAt.toISOString()}: ${printTA(token0, fees.amount0)} ${token0.symbol}, ${printTA(token1, fees.amount1)} ${token1.symbol}`
    );
    accumulatedFees.amount0 += fees.amount0 - lastSnapshot.amount0;
    accumulatedFees.amount1 += fees.amount1 - lastSnapshot.amount1;
    lastSnapshot = { amount0: 0n, amount1: 0n };
    i++;
  }
  if (collectOps.length) {
    console.log(
      `Collected ${printTA(token0, collectedFees.amount0)} ${token0.symbol}, ${printTA(token1, collectedFees.amount1)} ${token1.symbol} at ${collectOps[0].createdAt.toISOString()}`
    );

    // take into account fees generated between last collect and end of epoch
    accumulatedFees.amount0 += feesTo.amount0;
    accumulatedFees.amount1 += feesTo.amount1;
  } else {
    accumulatedFees.amount0 = feesTo.amount0 - feesFrom.amount0;
    accumulatedFees.amount1 = feesTo.amount1 - feesFrom.amount1;
  }

  // const epochFees = await prisma.dailyAnalytics.findMany({
  //   where: { poolAddress: pairAddress, date: { gte: from, lt: to } },
  // });
  // // prettier-ignore
  // const epochFees0 = epochFees.reduce((acc, fee) => acc + BigInt(fee.fees0), 0n);
  // // prettier-ignore
  // const epochFees1 = epochFees.reduce((acc, fee) => acc + BigInt(fee.fees1), 0n);
  // const bddEpoch0Value = new TokenAmount(t0, epochFees0).multiply(
  //   toFraction(token0Value)
  // );
  // const bddEpoch1Value = new TokenAmount(t1, epochFees1).multiply(
  //   toFraction(token1Value)
  // );
  const accEpoch0Value = new TokenAmount(t0, accumulatedFees.amount0).multiply(
    toFraction(token0Value)
  );
  const accEpoch1Value = new TokenAmount(t1, accumulatedFees.amount1).multiply(
    toFraction(token1Value)
  );
  // const swpEpoch0Value = new TokenAmount(t0, swapsFees.amount0).multiply(
  //   toFraction(token0Value)
  // );
  // const swpEpoch1Value = new TokenAmount(t1, swapsFees.amount1).multiply(
  //   toFraction(token1Value)
  // );

  const print = (
    t: { decimals: number; symbol: string },
    a: BigintIsh,
    v: Fraction
  ) => `${printTA(t, a)} ${t.symbol} ($${v.toFixed(2)})`;
  // console.log(
  //   `Generated fees (BDD): ${print(token0, epochFees0, bddEpoch0Value)}, ${print(token1, epochFees1, bddEpoch1Value)}`
  // );
  console.log(
    `Generated fees (acc): ${print(token0, accumulatedFees.amount0, accEpoch0Value)}, ${print(token1, accumulatedFees.amount1, accEpoch1Value)}`
  );
  // console.log(
  //   `Generated fees (swp): ${print(token0, swapsFees.amount0, swpEpoch0Value)}, ${print(token1, swapsFees.amount1, swpEpoch1Value)}`
  // );
  console.log("---");

  const sourceOfTruth = accumulatedFees;
  const amount0 = sourceOfTruth.amount0.toString();
  const amount1 = sourceOfTruth.amount1.toString();

  const d = {
    poolAddress: pairAddress,
    epoch: e,
    amount0,
    amount1,
    token0Address: token0.address,
    token1Address: token1.address,
    // bddValues: { value0: bddEpoch0Value, value1: bddEpoch1Value },
    // accValues: { value0: accEpoch0Value, value1: accEpoch1Value },
    // swpValues: { value0: swpEpoch0Value, value1: swpEpoch1Value },
  };
  if (save) {
    await prisma.protocolFees.upsert({
      where: { poolAddress_epoch: { poolAddress: pairAddress, epoch: e } },
      update: { amount0, amount1 },
      create: { poolAddress: pairAddress, epoch: e, amount0, amount1 },
    });
  }
  return d;
};

// HELPERS

type R = Buffer | Uint8Array;

const fetchDatastoreEntry = async (
  contractAddress: string,
  key: string,
  at: Date
): Promise<R> => {
  const isHistory = at.getTime() !== now;
  if (isHistory) {
    // 1st, try latest entry before <at>
    const bs = await getLedgerEntries2(contractAddress, at, [key]);
    // console.log("bs", bs[0].value?.length);
    if (bs[0].value) return bs[0].value;

    // 2nd, try newest entry after <at>
    const bs2 = await getLedgerEntries3(contractAddress, at, key);
    // console.log("bs2", bs2?.value.length, bs2?.createdAt);
    if (bs2?.value) return bs2.value;

    // 3rd, fetch current value
    // console.log("Falling back to current value...", key);
    const bs3 = await fetchDatastoreEntries(contractAddress, [key], at);
    // console.log("bs3", bs3[0].length);
    return bs3[0];
  } else
    return fetchDatastoreEntries(contractAddress, [key], at).then(
      (bs) => bs[0]
    );
};

const fetchDatastoreEntries = async (
  contractAddress: string,
  keys: string[],
  at: Date,
  opts?: {
    fetchMissing?: boolean; // TODO:
    beyond?: Date;
  }
): Promise<R[]> => {
  const isHistory = at.getTime() !== now;
  let bs: Array<Uint8Array | Buffer> = [];

  if (isHistory) {
    const bss = await getLedgerEntries2(
      contractAddress,
      at,
      keys,
      opts?.beyond
    ).then((res) => res.map((r) => r.value));
    bs = bss.map((b) => (b ? b : Buffer.from([])));
    // const nullEntries = keys.filter((key, i) => !bss[i]);
    // @ts-ignore
    // if (!nullEntries.length) bs = bss;
    // else {
    //   const fetched = await new IBaseContract(
    //     contractAddress,
    //     web3Client
    //   ).extract(nullEntries);
    //   let fetchIndex = 0;
    //   bs = bss.map((b, i) => (b ? b : fetched[fetchIndex++]));
    // }
  } else
    bs = await new IBaseContract(contractAddress, web3Client).extract(keys);
  return bs;
};

// FETCHERS

const fetchPoolWeight = async (
  poolAddress: string,
  at: number
): Promise<bigint> => {
  const bs = await fetchDatastoreEntry(
    voterSC,
    `weights::${poolAddress}`,
    new Date(at)
  );

  return bs.length ? U256.fromBytes(new Uint8Array(bs)) : 0n;
};

const fetchGlobalWeight = async (at: number): Promise<bigint> => {
  const bs = await fetchDatastoreEntry(voterSC, "totalWeight", new Date(at));
  return bs.length ? U256.fromBytes(new Uint8Array(bs)) : 0n;
};

const fetchAllLockOwners = async (at: number): Promise<Map<number, string>> => {
  const date = new Date(at);

  const lockOwners = new Map<number, string>();

  // Get the number of tokenIds (locks)
  const numLocksBs = await fetchDatastoreEntry(votingEscrowSC, "tokenId", date);
  const numLocks = numLocksBs.length
    ? Number(U64.fromBytes(new Uint8Array(numLocksBs)))
    : 0;

  console.log(`Total locks: ${numLocks}`);

  // Build all owner keys to fetch in one batch
  const ownerKeys = Array.from(
    { length: numLocks },
    (_, i) => `idToOwner::${i + 1}`
  );

  // Batch fetch all owners
  const ownerDataBs = await fetchDatastoreEntries(
    votingEscrowSC,
    ownerKeys,
    date
  );
  // const ownerDataBsAtm = await new IBaseContract(
  //   votingEscrowSC,
  //   web3Client
  // ).extract(ownerKeys);
  const ownerData = ownerDataBs.map(
    (r) => new Address().deserialize(new Uint8Array(r)).instance.value
  );

  // Map lockId to owner address
  for (let i = 1; i <= numLocks; i++) {
    const addr = ownerData[i - 1];
    if (!isAddressValid(addr)) continue;

    lockOwners.set(i, addr);
  }

  return lockOwners;
};

type InvalidLock = { votes: Map<string, bigint>; usedWeight: bigint };

/**
 * Finds the locks whose votes add up to more than their voting power.
 * Voter._vote uses unchecked u256 math, so crafted weights can record more
 * votes than a lock holds. Votes are only written at or after lastVoted, and a
 * voted lock's amount and end can only grow, so the power at lastVoted
 * (amount * (end - lastVoted) / MAXTIME, or amount if permanent) bounds every
 * honest vote and poke.
 * @returns Map of lockId to the votes (per pool) and used weight to ignore
 */
const fetchInvalidLocks = async (
  lockOwners: Map<number, string>,
  at: number
): Promise<Map<number, InvalidLock>> => {
  const date = new Date(at);
  const toBigint = (bs: R): bigint =>
    bs.length ? U256.fromBytes(new Uint8Array(bs)) : 0n;

  const lockIds = Array.from(lockOwners.keys());
  const poolVoteData = await fetchDatastoreEntries(
    voterSC,
    lockIds.map((lockId) => `poolVote::${lockId}`),
    date
  );
  const votingLocks = lockIds
    .map((lockId, i) => ({
      lockId,
      pools: bytesToStr(new Uint8Array(poolVoteData[i]))
        .split(",")
        .filter((pool) => pool),
    }))
    .filter(({ pools }) => pools.length > 0);
  if (!votingLocks.length) return new Map();

  const lastVotedData = await fetchDatastoreEntries(
    voterSC,
    votingLocks.map(({ lockId }) => `lastVoted::${lockId}`),
    date
  );
  const usedWeightData = await fetchDatastoreEntries(
    voterSC,
    votingLocks.map(({ lockId }) => `usedWeights::${lockId}`),
    date
  );
  const lockData = await fetchDatastoreEntries(
    votingEscrowSC,
    votingLocks.map(({ lockId }) => `locked::${lockId}`),
    date
  );
  const voteData = await fetchDatastoreEntries(
    voterSC,
    votingLocks.flatMap(({ lockId, pools }) =>
      pools.map((pool) => `votes::${lockId}${argsDelimiter}${pool}`)
    ),
    date
  );

  const invalidLocks = new Map<number, InvalidLock>();
  let voteIndex = 0;
  for (const [i, { lockId, pools }] of votingLocks.entries()) {
    const votes = new Map<string, bigint>();
    let totalVotes = 0n;
    for (const pool of pools) {
      const vote = toBigint(voteData[voteIndex++]);
      votes.set(pool, vote);
      totalVotes += vote;
    }

    let votingPower = 0n;
    if (lockData[i].length) {
      const lock = new LockedBalance().deserialize(
        new Uint8Array(lockData[i])
      ).instance;
      const amount = BigInt(lock.amount);
      const lastVoted = lastVotedData[i].length
        ? U64.fromBytes(new Uint8Array(lastVotedData[i]))
        : 0n;
      const remaining = BigInt(lock.end) - lastVoted;
      if (lock.isPermanent) votingPower = amount;
      else if (remaining > 0n) {
        const decayed = (amount * remaining) / VE_MAXTIME;
        votingPower = decayed < amount ? decayed : amount;
      }
    }

    if (totalVotes > votingPower) {
      console.warn(
        `Ignoring lock ${lockId}: votes ${totalVotes} exceed voting power ${votingPower}`
      );
      invalidLocks.set(lockId, {
        votes,
        usedWeight: toBigint(usedWeightData[i]),
      });
    }
  }

  return invalidLocks;
};

const fetchVoterWeights = async (
  poolAddress: string,
  lockOwners: Map<number, string>,
  at: number,
  invalidLocks: Map<number, InvalidLock>
): Promise<Map<string, bigint>> => {
  const date = new Date(at);

  const voterWeights = new Map<string, bigint>();

  const voteKeys: string[] = [];
  const lockIds: number[] = [];

  // Build all vote keys for this pool in one batch
  const poolVoteKeys: string[] = Array.from(lockOwners.keys()).map(
    (lockId) => `poolVote::${lockId}`
  );
  const poolVoteData = await fetchDatastoreEntries(
    voterSC,
    poolVoteKeys,
    date
  ).then((r) => r.map((r) => bytesToStr(new Uint8Array(r)).split(",")));

  let index = 0;
  for (const [lockId, owner] of lockOwners) {
    const poolVotes = poolVoteData[index];
    index++;
    if (invalidLocks.has(lockId)) continue;
    if (!poolVotes?.includes(poolAddress)) continue;
    const voteKey = `votes::${lockId}${argsDelimiter}${poolAddress}`;
    voteKeys.push(voteKey);
    lockIds.push(lockId);
  }
  const voteData = await fetchDatastoreEntries(voterSC, voteKeys, date);

  // Process the results
  for (let i = 0; i < voteKeys.length; i++) {
    if (!voteData[i].length) continue;

    const weight = U256.fromBytes(new Uint8Array(voteData[i]));
    if (weight === 0n) continue;

    const lockId = lockIds[i];
    const owner = lockOwners.get(lockId)!;
    const currentWeight = voterWeights.get(owner) || 0n;
    voterWeights.set(owner, currentWeight + weight); // Sum weights if the owner has multiple locks
  }

  return voterWeights;
};

/**
 * Fetches and deserializes all lock data from the voting escrow contract
 * @param numLocks Number of locks to fetch
 * @param at Timestamp for historical data (current time fetches current state)
 * @returns Map of lockId to LockedBalance
 */
const fetchAllLocksData = async (
  numLocks: number,
  at?: number
): Promise<Map<number, LockedBalance>> => {
  const locks = new Map<number, LockedBalance>();

  // Build lock keys
  const lockKeys = Array.from(
    { length: numLocks },
    (_, i) => `locked::${i + 1}`
  );

  // Fetch lock data (historical or current)
  const lockDataBs = at
    ? await fetchDatastoreEntries(votingEscrowSC, lockKeys, new Date(at))
    : await new IVotingEscrow(votingEscrowSC, web3Client).extract(lockKeys);

  // Parse and deserialize all locks
  for (let i = 0; i < numLocks; i++) {
    const lockId = i + 1;
    if (!lockDataBs[i]?.length) continue;

    try {
      const lock = new LockedBalance().deserialize(
        new Uint8Array(lockDataBs[i])
      ).instance;
      locks.set(lockId, lock);
    } catch (error) {
      console.warn(`Failed to deserialize lock ${lockId}:`, error);
      continue;
    }
  }

  return locks;
};

/**
 * Fetches the veDUSA balance (voting power) for each lock using multicall
 * Note: For historical data, this calls the current contract state, not historical state
 * @param lockOwners Map of lockId to owner address
 * @param _at Timestamp (currently unused, always fetches current state)
 * @returns Map of lockId to veDUSA balance (voting power)
 */
const fetchAllLockVotingPower = async (
  lockOwners: Map<number, string>,
  _at: number
): Promise<Map<number, bigint>> => {
  const votingPowers = new Map<number, bigint>();

  // Prepare multicall txs for balanceOfNFT
  const lockIds = Array.from(lockOwners.keys());
  const txs: Tx[] = lockIds.map(
    (id) =>
      new Tx(
        "balanceOfNFT",
        Uint8Array.from(new Args().addU64(BigInt(id)).serialize()),
        votingEscrowSC,
        0n
      )
  );

  // Batch multicall for balanceOfNFT (in chunks to avoid gas limits)
  const chunkSize = 100;
  const multicall = new IMulticall(multicallSC, web3Client);

  for (let i = 0; i < txs.length; i += chunkSize) {
    const batch = txs.slice(i, i + chunkSize);
    const batchLockIds = lockIds.slice(i, i + chunkSize);

    try {
      const res = await multicall.aggregateMulticall(batch);
      const bs = new Args(res.value);

      for (let j = 0; j < batch.length; j++) {
        try {
          const votingPower = U256.fromBytes(bs.nextUint8Array());
          if (votingPower > 0n) {
            votingPowers.set(batchLockIds[j], votingPower);
          }
        } catch (error) {
          console.warn(
            `Failed to parse voting power for lock ${batchLockIds[j]}:`,
            error
          );
          continue;
        }
      }
    } catch (error) {
      console.error(`Failed to fetch voting powers for batch ${i}:`, error);
      continue;
    }
  }

  return votingPowers;
};

const fetchAllLockBalances = async (
  lockOwners: Map<number, string>,
  at: number
): Promise<Map<number, bigint>> => {
  const locks = await fetchAllLocksData(lockOwners.size, at);
  const lockBalances = new Map<number, bigint>();

  // Extract balances from locks
  for (const [lockId, lock] of locks) {
    if (lock.amount > 0n) {
      lockBalances.set(lockId, lock.amount);
    }
  }

  return lockBalances;
};

/**
 * Aggregates lock values (balances, voting powers, etc.) by user address
 * @param lockValues Map of lockId to value (can be balance, voting power, etc.)
 * @param lockOwners Map of lockId to owner address
 * @returns Map of userAddress to total aggregated value
 */
const aggregateLockBalancesByUser = (
  lockValues: Map<number, bigint>,
  lockOwners: Map<number, string>
): Map<string, bigint> => {
  const userBalances = new Map<string, bigint>();

  for (const [lockId, value] of lockValues) {
    const owner = lockOwners.get(lockId);
    if (!owner) continue;

    const currentBalance = userBalances.get(owner) || 0n;
    userBalances.set(owner, currentBalance + value);
  }

  return userBalances;
};

type Bribe = { token: Token; amount: bigint; by: string };
const fetchBribes = async (
  poolAddress: string,
  epochId: number
): Promise<Bribe[]> => {
  const prefix = "bribes::";
  const allKeys = await getDatastoreKeys(voterSC, prefix);

  const epochStr = epochId.toString();
  const poolBribeKeys = allKeys.filter((key) => {
    // Remove 'bribes::' prefix and split by delimiter
    const keyWithoutPrefix = key.replace(prefix, "");
    const parts = keyWithoutPrefix.split(argsDelimiter);

    if (parts.length !== 4) return false;

    const [poolAddr, epoch, token, user] = parts;
    return poolAddr === poolAddress && epoch === epochStr;
  });

  if (!poolBribeKeys.length) return [];

  // Fetch bribe amounts from voter contract
  const contract = new IBaseContract(voterSC, web3Client);
  const bribeData = await contract.extract(poolBribeKeys).catch(() => []);

  // Group bribes by token address and sum amounts
  const bribeMap = new Map<string, Omit<Bribe, "token">>();

  poolBribeKeys.forEach((key, index) => {
    const data = bribeData[index];
    if (!data?.length) return;

    // Parse the U256 amount from storage
    const amount = new Args(data).nextU256();
    if (amount === 0n) return;

    // Extract token address from key
    const keyWithoutPrefix = key.replace(prefix, "");
    const parts = keyWithoutPrefix.split(argsDelimiter);
    if (parts.length !== 4) return;

    const tokenAddress = parts[2];
    const existingAmount = bribeMap.get(tokenAddress)?.amount || 0n;
    bribeMap.set(tokenAddress, {
      amount: existingAmount + amount,
      by: parts[3],
    });
  });

  // Convert to Bribe array with token info
  const bribes: Bribe[] = [];
  for (const [tokenAddress, bribe] of bribeMap) {
    const token = await fetchTokenFromAddress(tokenAddress);
    bribes.push({ ...bribe, token });
  }

  return bribes;
};

const _getProtocolFees = async (
  poolAddress: string,
  at: number
): Promise<ProtocolFees> => {
  const res = await fetchDatastoreEntry(
    poolAddress,
    "PAIR_INFORMATION",
    new Date(at)
  );
  if (!res.length) {
    if (!LOW_VOLUME_POOLS.includes(poolAddress))
      throw new Error(
        `No pair information found for ${poolAddress} at ${new Date(at).toISOString()}`
      );
    return { amount0: 0n, amount1: 0n };
  }
  const args = new Args(res ? new Uint8Array(res) : new Uint8Array());
  Number(args.nextU32()); // activeId
  args.nextU256(); // reserveX
  args.nextU256(); // reserveY
  const feesX = { total: args.nextU256(), protocol: args.nextU256() };
  const feesY = { total: args.nextU256(), protocol: args.nextU256() };

  return { amount0: feesX.protocol, amount1: feesY.protocol };
};

const collectProtocolFees = async (poolAddress: string) => {
  if (web3Client.account.address.toString() !== gov)
    throw new Error("Not governance account");
  if (!FEE_COLLECTION_POOLS.has(poolAddress))
    throw new Error(`Pool ${poolAddress} is not in FEE_COLLECTION_POOLS`);

  const targetFunction = "collectProtocolFees";
  const existing = await prisma.operation.findFirst({
    where: {
      callerAddress: gov,
      targetAddress: poolAddress,
      targetFunction,
      createdAt: { gte: new Date(Date.now() - ONE_HOUR) },
    },
  });
  if (existing) {
    console.log("Protocol fees already collected");
    return existing.id;
  }

  const pair = new ILBPair(poolAddress, web3Client);
  const tx = await pair.call({
    targetFunction,
    parameter: [],
  });
  await tx.waitSpeculativeExecution();
  return tx.id;
};

// LP REWARDS GENERATION

const generateLPRewards = async (at: number) => {
  console.log(
    `Generating LP rewards distribution based on database emissions for epoch ${epoch}...`
  );

  const jsonData: JSONData = { length: 0, markets: [] };

  // Fetch emissions from database for current epoch
  const emissionsFromDb = await prisma.rewardPool.findMany({
    where: { epoch },
    include: {
      rewardTokens: { include: { token: true } },
      pool: { include: { token0: true, token1: true } },
    },
  });

  if (emissionsFromDb.length === 0) {
    console.log(`No emissions found in database for epoch ${epoch}`);
    console.log("LP rewards generation skipped.");
    return;
  }

  console.log(
    `Found emissions for ${emissionsFromDb.length} pools in database`
  );

  for (const rewardPool of emissionsFromDb) {
    const { pool, rewardTokens } = rewardPool;

    for (const rewardToken of rewardTokens) {
      const token = rewardToken.token;
      const poolEmissions = BigInt(rewardToken.amount);
      console.log(
        `\nProcessing LP rewards for pool: ${pool.token0.symbol}/${pool.token1.symbol}/${pool.binStep}`
      );

      console.log(
        `Database emissions: ${printTA(token, poolEmissions)} ${token.symbol}`
      );

      // Get makers (LPs) from this pool who generated volume
      const makers = await prisma.maker.groupBy({
        where: {
          poolAddress: pool.address,
          date: { gte: from, lt: to },
        },
        by: ["address"],
        _sum: { volume: true },
      });

      // Calculate total volume generated
      const totalVolumeGenerated = makers.reduce(
        (acc, maker) => acc + (maker._sum.volume || 0),
        0
      );

      if (totalVolumeGenerated === 0) {
        console.log(
          `No LP activity in pool ${pool.address}, skipping rewards...`
        );
        continue;
      }

      // Distribute pool emissions to LPs based on fees they generated
      const users: UserData[] = [];
      let totalDistributed = 0n;

      for (const maker of makers) {
        const makerVolume = maker._sum.volume || 0;

        // Calculate LP's share of emissions based on fees generated
        const lpShare = makerVolume / totalVolumeGenerated;
        // console.log(
        //   `  Maker ${maker.address} generated $${makerVolume.toFixed(
        //     2
        //   )} in volume (${((lpShare || 0) * 100).toFixed(4)}% of total volume)`
        // );
        const lpReward = new Fraction(poolEmissions).multiply(
          toFraction(lpShare)
        ).quotient;

        if (lpReward > 0n) {
          users.push({
            address: maker.address,
            amount: lpReward,
          });
          totalDistributed += lpReward;
        }
      }

      // Fix rounding differences by adding remainder to last user
      if (users.length > 0) {
        const difference = poolEmissions - totalDistributed;
        if (difference !== 0n) {
          const lastUser = users[users.length - 1];
          lastUser.amount += difference;
          totalDistributed += difference;
        }
      }

      console.log(`Distributing to ${users.length} liquidity providers`);

      // Create reward data if there are recipients
      if (users.length > 0) {
        const rewardData: RewardData = {
          address: token.address,
          totalRewards: totalDistributed,
          length: users.length,
          users,
        };

        const marketData: MarketData = {
          address: pool.address,
          epoch,
          start: at,
          duration: 7 * ONE_DAY,
          length: 1, // smart contract only supports 1 reward token per market
          rewards: [rewardData],
        };

        jsonData.markets.push(marketData);
        jsonData.length++;
      }
    }
  }

  // Print summary
  console.log("\n=== LP Rewards Summary ===");
  console.log(`Total pools with LP rewards: ${jsonData.length}`);

  let totalUsers = new Set<string>();
  let totalDistributed = 0n;
  for (const market of jsonData.markets) {
    for (const reward of market.rewards) {
      if (reward.address === DUSA.address)
        totalDistributed += reward.totalRewards;
      for (const user of reward.users) {
        totalUsers.add(user.address);
      }
    }
  }
  console.log(`Total unique LPs rewarded: ${totalUsers.size}`);
  console.log(
    `Total DUSA actually distributed: ${printTA(DUSA, totalDistributed)}`
  );

  if (totalDistributed > WEEKLY_EMISSIONS) {
    throw new Error(
      `LP rewards total (${printTA(DUSA, totalDistributed)}) exceeds WEEKLY_EMISSIONS (${printTA(DUSA, WEEKLY_EMISSIONS)}). Aborting.`
    );
  }

  // Save the JSON file
  const filename = `lp_rewards_epoch_${epoch}.json`;
  saveJSONFile(jsonData, filename);
  console.log(`\nLP rewards distribution saved to ${filename}`);
};

// GOVERNANCE REWARDS GENERATION

const generateGovernanceRewards = async (at: number) => {
  console.log(
    "Generating governance rewards distribution based on protocol fees..."
  );
  console.log(
    `Epoch: ${epoch}, From: ${from.toISOString()}, To: ${to.toISOString()}`
  );

  const jsonData: JSONData = { length: 0, markets: [] };

  const pools = V2_PAIRS.filter((pool) => {
    if (FEE_COLLECTION_POOLS.has(pool)) return true;
    console.warn(`Skipping pool ${pool}: not in FEE_COLLECTION_POOLS`);
    return false;
  });

  // Fetch all lock owners once at the beginning
  const lockOwners = await fetchAllLockOwners(at);
  console.log(`Fetched ${lockOwners.size} lock owners`);
  const invalidLocks = await fetchInvalidLocks(lockOwners, at);

  let globalWeight = await fetchGlobalWeight(at);
  for (const { usedWeight } of invalidLocks.values())
    globalWeight -= usedWeight;
  console.log("Global voting weight:", globalWeight.toString());

  // Track total collected fees across all pools
  const totalCollectedFees = new Map<string, bigint>();

  const voterRewardsData: {
    userAddress: string;
    poolAddress: string;
    token: string;
    amount: string;
    veEpoch: number;
  }[] = [];
  const bribesData: {
    poolAddress: string;
    token: string;
    amount: string;
    by: string;
    epoch: number;
  }[] = [];

  for (const pool of pools) {
    const { token0, token1, binStep } = await prisma.pool.findUniqueOrThrow({
      where: { address: pool },
      include: { token0: true, token1: true },
    });

    console.log(
      `\nProcessing pool: ${pool} (${token0.symbol}/${token1.symbol}/${binStep})`
    );

    // 1. Get pool voting weight
    let poolWeight = await fetchPoolWeight(pool, at);
    for (const { votes } of invalidLocks.values())
      poolWeight -= votes.get(pool) ?? 0n;
    if (poolWeight <= 0n) {
      console.log(`No votes, skipping...`);
      continue;
    }

    const poolShare = new Fraction(poolWeight, globalWeight);
    console.log(
      `Pool voting share: ${poolShare.multiply(100n).toSignificant(4)}%`
    );

    // 2. Collect protocol fees from the pool (current epoch for database storage)
    await regenFees(pool, epoch, saveToDB);
    if (sendTxs) {
      const txId = await collectProtocolFees(pool);
      console.log(`Collected protocol fees, txId: ${txId}`);
    }

    // 2b. Get previous epoch's protocol fees from database for voter rewards
    const previousEpochFees = await prisma.protocolFees.findUnique({
      where: { poolAddress_epoch: { poolAddress: pool, epoch: epoch - 1 } },
    });

    const rewardProtocolFees = previousEpochFees
      ? {
          amount0: BigInt(previousEpochFees.amount0),
          amount1: BigInt(previousEpochFees.amount1),
        }
      : { amount0: 0n, amount1: 0n };

    if (previousEpochFees) {
      console.log(
        `Using previous epoch (${epoch - 1}) protocol fees for voter rewards:`
      );
      if (rewardProtocolFees.amount0 > 0n)
        console.log(
          `  ${token0.symbol}: ${printTA(token0, rewardProtocolFees.amount0)}`
        );
      if (rewardProtocolFees.amount1 > 0n)
        console.log(
          `  ${token1.symbol}: ${printTA(token1, rewardProtocolFees.amount1)}`
        );
    } else
      console.log(`No previous epoch protocol fees found for voter rewards`);

    // 3. Get voter weights
    const voterWeights = await fetchVoterWeights(
      pool,
      lockOwners,
      at,
      invalidLocks
    );
    const sumVoterWeights = Array.from(voterWeights.values()).reduce(
      (acc, w) => acc + w,
      0n
    );

    console.log(`Found ${voterWeights.size} voters for this pool`);
    if (voterWeights.size === 0) continue;

    // 4. Fetch bribes for this pool and epoch
    const bribes = await fetchBribes(pool, epoch);
    if (bribes.length > 0) {
      console.log(`Found ${bribes.length} bribe token(s) for this pool`);
      for (const bribe of bribes) {
        console.log(
          `  ${bribe.token.symbol}: ${printTA(bribe.token, bribe.amount)} (by: ${bribe.by})`
        );

        // Save bribe data for database
        bribesData.push({
          poolAddress: pool,
          token: bribe.token.address,
          amount: bribe.amount.toString(),
          by: bribe.by,
          epoch: epoch,
        });
      }
    }

    // 5. Calculate individual rewards based on voting weight
    const rewards: RewardData[] = [];

    // Process protocol fees and bribes
    const allRewardTokens = new Map<
      string,
      { token: PrismaToken | Token; amount: bigint }
    >();

    // Add protocol fees from previous epoch
    if (rewardProtocolFees.amount0 > 0n) {
      allRewardTokens.set(token0.address, {
        token: token0,
        amount: rewardProtocolFees.amount0,
      });
    }
    if (rewardProtocolFees.amount1 > 0n) {
      allRewardTokens.set(token1.address, {
        token: token1,
        amount: rewardProtocolFees.amount1,
      });
    }

    // Add bribes
    for (const bribe of bribes) {
      const existing = allRewardTokens.get(bribe.token.address);
      if (existing)
        // Add to existing amount if token already has protocol fees
        allRewardTokens.set(bribe.token.address, {
          token: bribe.token,
          amount: existing.amount + bribe.amount,
        });
      else allRewardTokens.set(bribe.token.address, bribe);
    }

    // Distribute all rewards proportionally to voters
    for (const [tokenAddress, { token, amount }] of allRewardTokens) {
      const users: UserData[] = [];

      // Update total collected fees/bribes
      const currentTotal = totalCollectedFees.get(tokenAddress) || 0n;
      const newTotal = currentTotal + amount;
      totalCollectedFees.set(tokenAddress, newTotal);

      let sumAmount = 0n;
      let sumScore = new Fraction(0n);
      // Distribute proportionally to voters
      for (const [voter, weight] of voterWeights) {
        // if (voter === specialUser) console.log({ weight });
        const votingScore = new Fraction(weight, sumVoterWeights);
        sumScore = sumScore.add(votingScore);

        // Calculate user's share of the rewards
        const userReward = new Fraction(amount).multiply(votingScore).quotient;
        sumAmount += userReward;

        const rewardTokenIndex = uniqueTokens.findIndex(
          (token) => token.address === tokenAddress
        );
        const rewardTokenValue = globalDollarValues[rewardTokenIndex];
        const rewardValue = new TokenAmount(
          toToken(token),
          userReward
        ).multiply(toFraction(rewardTokenValue));

        if (specialUsers.includes(voter)) {
          const userIndex = specialUsers.indexOf(voter);
          specialUsersSum[userIndex] += Number(rewardValue.toSignificant(4));
          // specialUsersRewards.set(
          //   voter,
          //   tokenAddress,
          //   (specialUserRewards.get(tokenAddress) || 0n) + userReward
          // );

          // console.log(
          //   "userReward",
          //   userReward,
          //   printUSD(Number(rewardValue.toSignificant(4)), true),
          //   token.symbol,
          //   votingScore.multiply(100n).toFixed(4),
          //   printTA({ decimals: 18 }, weight)
          // );
        }

        if (userReward > 0n) {
          users.push({
            address: voter,
            amount: userReward,
          });

          // Save voter rewards for database
          voterRewardsData.push({
            userAddress: voter,
            poolAddress: pool,
            token: tokenAddress,
            amount: userReward.toString(),
            veEpoch: epoch,
          });
        }
      }

      if (users.length > 0) {
        // Fix rounding differences by adding remainder to last user
        const difference = amount - sumAmount;
        if (difference !== 0n) {
          const lastUser = users[users.length - 1];
          lastUser.amount += difference;

          // Update the last database entry as well
          const lastDbEntry = voterRewardsData[voterRewardsData.length - 1];
          if (lastDbEntry && lastDbEntry.userAddress === lastUser.address) {
            lastDbEntry.amount = lastUser.amount.toString();
          }
        }

        rewards.push({
          address: tokenAddress,
          totalRewards: amount,
          length: users.length,
          users,
        });
      }
    }

    // 6. Create market data entries - one for each reward type
    if (rewards.length > 0) {
      for (const reward of rewards) {
        const marketData: MarketData = {
          address: "vote-" + pool,
          epoch,
          start: at,
          duration: 7 * ONE_DAY,
          length: 1, // Each market has exactly 1 reward
          rewards: [reward],
        };

        jsonData.markets.push(marketData);
        jsonData.length++;
      }
    }
  }

  // Save the JSON file
  const filename = `governance_rewards_epoch_${epoch}.json`;
  saveJSONFile(jsonData, filename);
  console.log(`\nRewards distribution saved to ${filename}`);

  // Print summary
  console.log("\n=== Summary ===");
  console.log(`Total markets with rewards: ${jsonData.length}`);
  console.log("\nTotal protocol fees and bribes collected and distributed:");

  for (const [tokenAddress, amount] of totalCollectedFees) {
    // Get token info
    const token = await prisma.token.findUnique({
      where: { address: tokenAddress },
    });
    if (token) {
      const formattedAmount = printTA(token, amount);
      console.log(`  ${token.symbol}: ${formattedAmount}`);
    } else {
      console.log(`  ${tokenAddress}: ${amount.toString()}`);
    }
  }

  let totalUsers = new Set<string>();
  for (const market of jsonData.markets)
    for (const reward of market.rewards)
      for (const user of reward.users) totalUsers.add(user.address);

  console.log(`\nTotal unique recipients: ${totalUsers.size}`);
  console.log(totalUsers.has(specialUser));

  if (voterRewardsData.length > 0 && saveToDB) {
    console.log("\nSaving voter rewards to database...");
    await prisma.voterRewards.createMany({
      data: voterRewardsData,
    });
    console.log(
      `${voterRewardsData.length} voter rewards saved to database successfully`
    );
  }

  if (bribesData.length > 0 && saveToDB) {
    console.log("\nSaving bribes to database...");
    for (const bribe of bribesData) {
      await prisma.bribes
        .create({
          data: {
            ...bribe,
            date: new Date(at),
          },
        })
        .catch(handlePrismaError);
    }
    console.log(`${bribesData.length} bribes saved to database successfully`);
  }

  const totalSpecialUserRewards = specialUsersSum.reduce(
    (acc, curr) => acc + curr,
    0
  );
  console.log("Special users sum:", totalSpecialUserRewards);
  // for (const [tokenAddress, amount] of specialUserRewards) {
  //   const token = await prisma.token.findUniqueOrThrow({
  //     where: { address: tokenAddress },
  //   });
  //   const t = toToken(token);
  //   const tokenIndex = uniqueTokens.findIndex(
  //     (token) => token.address === tokenAddress
  //   );
  //   const tokenValue = globalDollarValues[tokenIndex];
  //   const rewardValue = new TokenAmount(t, amount).multiply(
  //     toFraction(tokenValue)
  //   );
  //   console.log(
  //     printTA(token, amount),
  //     token.symbol,
  //     "$" + printUSD(Number(rewardValue.toSignificant(4)), true)
  //   );
  // }
};

// SAVE NEXT EPOCH EMISSIONS

const saveNextEpochEmissions = async (at: number) => {
  const nextEpoch = epoch + 1;

  // Idempotency guard: this runs as a weekly cron and must write each epoch's
  // emissions exactly once. A duplicate/retry run for the same nextEpoch would
  // re-process every pool and corrupt the stored amounts (this is what doubled
  // epoch 114). It would also wipe/inflate any out-of-band manual top-up made
  // on RewardToken. So skip if this epoch was already saved. To intentionally
  // recompute an epoch, delete its Emissions/RewardPool/RewardToken rows first.
  const alreadySaved = await prisma.emissions.findFirst({
    where: { epoch: nextEpoch },
  });
  if (alreadySaved) {
    console.log(
      `Emissions for epoch ${nextEpoch} already saved, skipping (idempotent).`
    );
    return;
  }

  const lockOwners = await fetchAllLockOwners(at);
  const invalidLocks = await fetchInvalidLocks(lockOwners, at);

  let globalWeight = await fetchGlobalWeight(at);
  for (const { usedWeight } of invalidLocks.values())
    globalWeight -= usedWeight;
  if (globalWeight <= 0n) {
    console.log(
      "No global voting weight found, skipping next epoch emissions."
    );
    return;
  }

  console.log("Global voting weight:", globalWeight.toString());

  const pools = V2_PAIRS;
  const emissionsData: {
    poolAddress: string;
    amount: string;
    epoch: number;
  }[] = [];

  for (const pool of pools) {
    const poolInfo = await prisma.pool.findUnique({
      where: { address: pool },
      include: { token0: true, token1: true },
    });
    if (!poolInfo) {
      console.warn(`Skipping pool ${pool}: not in the database`);
      continue;
    }
    let poolWeight = await fetchPoolWeight(pool, at);
    for (const { votes } of invalidLocks.values())
      poolWeight -= votes.get(pool) ?? 0n;

    if (poolWeight <= 0n) {
      console.log(
        `No votes for pool ${poolInfo.token0.symbol}/${poolInfo.token1.symbol}, no emissions for next epoch...`
      );
      continue;
    }

    // Calculate pool's share of total emissions based on voting weight
    const poolShare = new Fraction(poolWeight, globalWeight);
    const poolEmissions = new Fraction(WEEKLY_EMISSIONS).multiply(
      poolShare
    ).quotient;

    console.log(
      `Pool ${poolInfo.token0.symbol}/${poolInfo.token1.symbol}: ${poolShare.multiply(100n).toSignificant(4)}% = ${printTA(
        DUSA,
        poolEmissions
      )} DUSA`
    );

    emissionsData.push({
      poolAddress: pool,
      amount: poolEmissions.toString(),
      epoch: nextEpoch,
    });
  }

  // Save emissions for next epoch
  if (emissionsData.length && saveToDB) {
    for (const emission of emissionsData) {
      // Save to Emissions table
      await prisma.emissions
        .upsert({
          where: {
            poolAddress_epoch: {
              poolAddress: emission.poolAddress,
              epoch: emission.epoch,
            },
          },
          update: {
            amount: emission.amount,
            date: new Date(at),
          },
          create: {
            poolAddress: emission.poolAddress,
            amount: emission.amount,
            epoch: emission.epoch,
            date: new Date(at),
          },
        })
        .catch(handlePrismaError);

      // Save to RewardPool and RewardToken tables
      await prisma.rewardPool
        .upsert({
          where: {
            poolAddress_epoch: {
              poolAddress: emission.poolAddress,
              epoch: emission.epoch,
            },
          },
          update: {},
          create: {
            poolAddress: emission.poolAddress,
            epoch: emission.epoch,
          },
        })
        .catch(handlePrismaError);

      await prisma.rewardToken
        .upsert({
          where: {
            rewardPoolAddress_rewardEpoch_address: {
              rewardPoolAddress: emission.poolAddress,
              rewardEpoch: emission.epoch,
              address: DUSA.address,
            },
          },
          // Replace, don't accumulate: emission.amount is always the full DUSA
          // emission computed for this pool/epoch. Adding it to the existing
          // value doubled the rewards whenever this script ran twice for the
          // same epoch (see Emissions upsert above, which already replaces).
          update: {
            amount: emission.amount,
          },
          create: {
            rewardPoolAddress: emission.poolAddress,
            rewardEpoch: emission.epoch,
            address: DUSA.address,
            amount: emission.amount,
          },
        })
        .catch(handlePrismaError);
    }

    console.log(
      `Saved ${emissionsData.length} pool emissions for epoch ${nextEpoch}`
    );
  }
};

// SEND PROTOCOL FEES TO REWARDER CONTRACT

const sendProtocolFees = async () => {
  if (!sendTxs) return;
  if (web3Client.account.address.toString() !== gov)
    throw new Error("Not governance account");

  const tokens = await prisma.token.findMany({
    where: { address: { in: TOKENS } },
  });

  for (const token of tokens) {
    if (token.address === JELLY.address) continue; // skip JELLY

    const tokenContract = new IERC20(token.address, web3Client);
    const balance = await tokenContract.balanceOf(gov);
    if (balance === 0n) continue;

    console.log(`Sending ${printTA(token, balance)} ${token.symbol}...`);
    const tx = await tokenContract.transfer(v2RewarderSC, balance);
    await tx.waitSpeculativeExecution();
    console.log(`Sent, txId: ${tx.id}`);
  }
};

// POKE LOCKS

const pokeAllTokens = async (batchSize = 5) => {
  const privKey = process.env.PRIV_KEY_POKE;
  if (!privKey) throw new Error("No private key provided");
  if (!sendTxs) return;

  const baseAccount = await Account.fromPrivateKey(privKey);
  const web3Client = Web3Provider.mainnet(baseAccount);
  if (web3Client.account.address.toString() !== team)
    throw new Error("Not team account");

  // Get the number of tokenIds (locks)
  const numLocksBs = await new IVotingEscrow(
    votingEscrowSC,
    web3Client
  ).extract(["tokenId"]);
  const numLocks = numLocksBs[0]
    ? Number(U64.fromBytes(new Uint8Array(numLocksBs[0])))
    : 0;

  console.log(`Found ${numLocks} total locks`);

  if (numLocks === 0) {
    console.log("No locks found, skipping poke operation");
    return;
  }

  // Batch read all lock details to filter out withdrawn/permanent locks
  console.log("Reading lock details to filter active locks...");
  const locks = await fetchAllLocksData(numLocks);

  // Filter token IDs where lock end is not 0 (skip withdrawn or permanent locks)
  const activeTokenIds: number[] = [];
  for (const [lockId, lock] of locks) {
    // Skip if end is 0 (withdrawn or permanent lock)
    if (Number(lock.end) !== 0) {
      activeTokenIds.push(lockId);
    }
  }

  const skippedCount = numLocks - activeTokenIds.length;
  console.log(
    `Found ${activeTokenIds.length} active locks (skipped ${skippedCount} withdrawn/permanent locks)`
  );

  if (activeTokenIds.length === 0) {
    console.log("No active locks to poke");
    return;
  }

  // Create multicall instance
  const multicall = new IMulticall(multicallSC, web3Client);

  // Process tokens in batches
  const batches = Math.ceil(activeTokenIds.length / batchSize);
  console.log(
    `Processing ${activeTokenIds.length} tokens in ${batches} batches of ${batchSize}`
  );

  for (let batchIndex = 0; batchIndex < batches; batchIndex++) {
    const startIdx = batchIndex * batchSize;
    const endIdx = Math.min(
      (batchIndex + 1) * batchSize,
      activeTokenIds.length
    );
    const batchTokenIds = activeTokenIds.slice(startIdx, endIdx);
    const currentBatchSize = batchTokenIds.length;

    console.log(
      `\nProcessing batch ${
        batchIndex + 1
      }/${batches}: tokens [${batchTokenIds.join(", ")}]`
    );

    // Create poke transactions for this batch
    const pokeTxs: Tx[] = [];
    for (const tokenId of batchTokenIds) {
      pokeTxs.push(
        new Tx(
          "poke",
          new Args().addU64(BigInt(tokenId)).serialize(),
          voterSC,
          0n
        )
      );
    }

    try {
      // Execute multicall for this batch
      const existingTx = await prisma.operation.findFirst({
        where: {
          callerAddress: team,
          targetAddress: multicallSC,
          targetFunction: "multicall",
          data: Buffer.from(
            new Args().addSerializableObjectArray(pokeTxs).serialize()
          ),
          createdAt: { gte: new Date(Date.now() - ONE_DAY) },
        },
      });
      if (existingTx) {
        console.log(`Skipping batch ${batchIndex + 1} (already executed)`);
        continue;
      }

      const tx = await multicall.executeMulticall(pokeTxs, 0n);

      console.log(`Batch ${batchIndex + 1} transaction submitted: ${tx.id}`);
      console.log(`Waiting for execution...`);

      // Wait for transaction to be executed
      await tx.waitSpeculativeExecution();

      console.log(
        `✅ Successfully poked ${currentBatchSize} tokens in batch ${
          batchIndex + 1
        }`
      );

      // Add a small delay between batches to avoid overwhelming the network
      if (batchIndex < batches - 1) {
        console.log("Waiting 1 second before next batch...");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    } catch (error) {
      console.error(`❌ Error processing batch ${batchIndex + 1}:`, error);
      // Continue with next batch instead of stopping
      continue;
    }
  }

  console.log(
    `\n🎉 Completed poking ${activeTokenIds.length} active tokens across ${batches} batches`
  );
};

const writeJSONOnchain = async (type: "lp" | "governance") => {
  if (!saveToDB) return;
  if (web3Client.account.address.toString() !== gov)
    throw new Error("Not governance account");

  const rewarder = new IBaseContract(v2RewarderSC, web3Client);
  const filename = `${type}_rewards_epoch_${epoch}.json`;
  const jsonString = readFileSync(filename, "utf-8");
  const dataJson = convertJsonToDataRoot(jsonString);
  const args = new Args().addSerializable(dataJson);
  const tx = await rewarder.call({
    targetFunction: "setNewEpoch",
    parameter: args.serialize(),
  });
  console.log("Transaction submitted:", tx.id);
  await tx.waitSpeculativeExecution();
  console.log(`✅ Successfully set ${type} epoch ${epoch} onchain`);
};

const rebaseDUSA = async (at: number) => {
  // if (!sendTxs) return;
  // if (web3Client.account.address.toString() !== gov)
  //   throw new Error("Not governance account");

  const dusa = new IERC20(DUSA.address, web3Client);
  const ve = new IVotingEscrow(votingEscrowSC, web3Client);

  const dusaTotalSupply = await dusa.totalSupply();
  const keys = EXCL_DUSA_CIRCULATING.map((address) => "BALANCE" + address);
  const balances = await dusa
    .extract(keys)
    .then((entries) =>
      entries.map((entry) => (entry.length ? new Args(entry).nextU256() : 0n))
    );
  const sumBalances = balances.reduce((acc, balance) => acc + balance, 0n);
  const dusaCirculatingSupply = dusaTotalSupply - sumBalances;
  const veSupply = await ve.totalSupply();
  const t = { decimals: 18 };
  console.log(`DUSA circulating supply: ${printTA(t, dusaCirculatingSupply)}`);
  console.log(`veDUSA total supply: ${printTA(t, veSupply)}`);

  const fra = new Fraction(veSupply, dusaCirculatingSupply);
  const rebaseAmount = fra
    .multiply(fra)
    .multiply(fra)
    // (veSupply / dusaSupply) ^ 3
    .multiply(new Fraction(1n, 2n))
    .multiply(WEEKLY_EMISSIONS);
  console.log(`Rebase amount: ${printTA(t, rebaseAmount.quotient)}`);

  if (rebaseAmount.quotient === 0n)
    throw new Error("No rebase amount to distribute");

  // Fetch all lock owners
  const lockOwners = await fetchAllLockOwners(at);
  console.log(`Fetched ${lockOwners.size} lock owners`);

  if (lockOwners.size === 0) throw new Error("No lock owners found");

  // Fetch all veDUSA voting powers (not locked amounts, as voting power decays over time)
  const lockVotingPowers = await fetchAllLockVotingPower(lockOwners, at);
  const totalVeBalance = Array.from(lockVotingPowers.values()).reduce(
    (acc, balance) => acc + balance,
    0n
  );

  console.log(
    `Found ${lockVotingPowers.size} locks with voting power, total: ${printTA(t, totalVeBalance)}`
  );

  // Aggregate voting powers by user address (users can have multiple locks)
  const userBalances = aggregateLockBalancesByUser(
    lockVotingPowers,
    lockOwners
  );
  console.log(`Aggregated into ${userBalances.size} unique lock owners`);

  // Calculate proportional distribution
  const users: UserData[] = [];
  let totalDistributed = 0n;

  for (const [userAddress, balance] of userBalances) {
    // Calculate user's share based on their veDUSA balance
    const userShare = new Fraction(balance, totalVeBalance);
    const userReward = new Fraction(rebaseAmount.quotient).multiply(
      userShare
    ).quotient;

    if (userReward == 0n) continue;

    users.push({
      address: userAddress,
      amount: userReward,
    });
    totalDistributed += userReward;

    // Log for special user if needed
    if (userAddress === specialUser)
      console.log(
        `Special user rebase reward: ${printTA(DUSA, userReward)} (${userShare.multiply(100n).toFixed(4)}%)`
      );
  }

  // Fix rounding differences by adding remainder to last user
  if (users.length > 0) {
    const difference = rebaseAmount.quotient - totalDistributed;
    if (difference !== 0n) {
      const lastUser = users[users.length - 1];
      lastUser.amount += difference;
      totalDistributed += difference;
    }
  }

  console.log(
    `Distributing ${printTA(DUSA, totalDistributed)} DUSA to ${users.length} users`
  );

  // Create reward data structure
  const rewardData: RewardData = {
    address: DUSA.address,
    totalRewards: totalDistributed,
    length: users.length,
    users,
  };

  // Create market data for rebase (using a special address identifier)
  const marketData: MarketData = {
    address: "rebase-vedusa",
    epoch,
    start: at,
    duration: 7 * ONE_DAY,
    length: 1,
    rewards: [rewardData],
  };

  const jsonData: JSONData = {
    length: 1,
    markets: [marketData],
  };

  // Save to JSON file
  const filename = `rebase_rewards_epoch_${epoch}.json`;
  saveJSONFile(jsonData, filename);
  console.log(`\nRebase distribution saved to ${filename}`);

  // Print summary
  console.log("\n=== Rebase Summary ===");
  console.log(`Total DUSA distributed: ${printTA(DUSA, totalDistributed)}`);
  console.log(`Total unique recipients: ${users.length}`);

  // Save to database if enabled (using VoterRewards table with special poolAddress)
  if (!saveToDB) return;

  console.log("\nSaving rebase rewards to database...");
  const rebaseRewardsData = users.map((user) => ({
    userAddress: user.address,
    poolAddress: "rebase-vedusa", // Special identifier for rebase rewards
    token: DUSA.address,
    amount: user.amount.toString(),
    veEpoch: epoch,
  }));

  for (const rebaseReward of rebaseRewardsData) {
    await prisma.voterRewards
      .create({ data: rebaseReward })
      .catch(handlePrismaError);
  }

  console.log(
    `${rebaseRewardsData.length} rebase rewards saved to database successfully`
  );
};

// MAIN

const main = async (at = now) => {
  console.log("=".repeat(60));
  console.log("DUSA Protocol Rewards Generation");
  console.log(`Epoch: ${epoch}`);
  console.log(`Period: ${from.toISOString()} to ${to.toISOString()}`);
  console.log("=".repeat(60));

  // Generate governance rewards (protocol fees + bribes to voters)
  console.log("\n[1/7] Generating governance rewards...");
  await generateGovernanceRewards(at).catch((err) => console.error(err));

  // Generate LP rewards (DUSA emissions from database)
  console.log("\n[2/7] Generating LP rewards...");
  await generateLPRewards(at).catch((err) => console.error(err));

  // Save next epoch emissions based on current voting weights
  console.log("\n[3/7] Saving next epoch emissions...");
  await saveNextEpochEmissions(at).catch((err) => console.error(err));

  // Send protocol fees to rewarder contract
  console.log("\n[4/7] Sending protocol fees to rewarder SC...");
  await sendProtocolFees().catch((err) => console.error(err));

  // Poke every lock id
  console.log("\n[5/7] Poking all locks in voting escrow SC...");
  await pokeAllTokens().catch((err) => console.error(err));

  // Write JSON onchain
  console.log("\n[6/7] Writing JSON onchain...");
  await writeJSONOnchain("lp").catch((err) => console.error(err));
  await writeJSONOnchain("governance").catch((err) => console.error(err));

  // Rebase DUSA
  // console.log("\n[7/7] Rebasing DUSA...");
  // await rebaseDUSA(at).catch((err) => console.error(err));

  console.log("\n" + "=".repeat(60));
  console.log("All rewards generated successfully!");
  console.log("=".repeat(60));
};

(async () => {
  const at = to.getTime();
  console.log("Using state at:", new Date(at).toISOString());

  await main(at);
  // await regenFeesBatch(85, true);
  // await compareJSON(`./governance_rewards_epoch_${epoch}.json`, `old_gov.json`);
})();

// @ts-expect-error: Property 'toJSON' does not exist on type 'BigInt'
BigInt.prototype.toJSON = function (): string {
  return this.toString();
};

// TLDR: This script generates JSON files detailing the distribution of governance and liquidity provider (LP) rewards for a decentralized exchange protocol.
// It runs every Thursday at midnight UTC, covering the previous week's activity.
// Save fees of epoch n
// Save voter rewards of epoch n (using fees of epoch n-1)
// Save emissions (& reward pool/token) of epoch n+1 (based on votes at epoch n)
// Save bribes of epoch n
//
// Let's say epoch 75 just ended
// At the start of epoch 76 (Thursday midnight UTC):
// 1. Collect and save protocol fees generated in epoch 75 to the database
// 2. Get epoch 74 protocol fees from database for voter rewards
