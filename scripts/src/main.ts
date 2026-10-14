import { prisma } from "../../common/db";
import {
  AIRDROP_VALUE,
  ALLOCATION_PERCENTAGE,
  BASE_ALLOCATION_PCT,
  BLACKLIST,
  CHAIN_ID,
  GREYLIST,
  lastEpoch,
  MCAP,
  SUPPLY,
  TOTAL_POINTS,
} from "../../common/config";
import { abs, printUSD as p, printTA } from "../../common/methods";
import { getId, getUser } from "../../api/src/discord";
import {
  AddLiquidityParameters,
  ChainId,
  EventDecoder,
  IBaseContract,
  IERC20,
  isLiquidtyMethod,
  IVotingEscrow,
  LIQUIDITY_ROUTER_METHODS,
  LiquidityRouterMethod,
  LockedBalance,
  RemoveLiquidityParameters,
  Tx,
} from "@dusalabs/sdk";
import { Address, ONE_DAY } from "../../common/utils";
import {
  Args,
  ArrayTypes,
  bytesToStr,
  strToBytes,
} from "@massalabs/massa-web3";
import {
  EOAs,
  masUsdcPairV1,
  tokenList,
  USDC,
  v2RewarderSC,
  voterSC,
  votingEscrowSC,
  WMAS,
} from "../../common/contracts";
import { getLedgerEntries2 } from "../../indexer/src/db";
import {
  fetchEvents as fetchEventsJSON,
  getDatastoreKeys,
} from "../../common/datastoreFetcher";
import { web3Client } from "../../common/client";
import { fetchEvents as fetchEventsGRPC } from "../../indexer/src/grpc";

const decodeLiquidityTx = (
  method: LiquidityRouterMethod,
  params: Uint8Array,
  chainId: ChainId
): AddLiquidityParameters | RemoveLiquidityParameters => {
  const isAdd = method === "addLiquidity" || method === "addLiquidityMAS";
  const isRemoveMAS = method === "removeLiquidityMAS";
  console.log({ method, isAdd, isRemoveMAS });
  const args = new Args(params);
  const token0 = args.nextString();
  const token1 = isRemoveMAS ? WMAS.address : args.nextString();
  const binStep = Number(args.nextU64());

  if (isAdd) {
    const amount0 = args.nextU256();
    const amount1 = args.nextU256();
    const amount0Min = args.nextU256();
    const amount1Min = args.nextU256();
    const activeIdDesired = Number(args.nextU64());
    const idSlippage = Number(args.nextU64());
    const deltaIds = args.nextArray<bigint>(ArrayTypes.I64).map(Number);
    const distribution0 = args.nextArray<bigint>(ArrayTypes.U256);
    const distribution1 = args.nextArray<bigint>(ArrayTypes.U256);
    const to = args.nextString();
    const deadline = Number(args.nextU64());

    return {
      token0,
      token1,
      binStep,
      amount0,
      amount1,
      amount0Min,
      amount1Min,
      activeIdDesired,
      idSlippage,
      deltaIds,
      distributionX: distribution0, //distribution0,
      distributionY: distribution1, //distribution1,
      to,
      deadline,
    };
  } else {
    const amount0Min = args.nextU256();
    const amount1Min = args.nextU256();
    console.log({ amount0Min, amount1Min });
    const ids = args.nextArray<bigint>(ArrayTypes.U64).map(Number);
    const amounts = args.nextArray<bigint>(ArrayTypes.U256);
    const to = args.nextString();
    const deadline = Number(args.nextU64());

    return {
      token0,
      token1,
      binStep,
      amount0Min,
      amount1Min,
      ids,
      amounts,
      to,
      deadline,
    };
  }
};

/* LOGS */

const log = async () => {
  const decodeOperation = () => {};

  const logs = await prisma.log.findMany({
    orderBy: { createdAt: "desc" },
    take: 100,
  });
  for (const log of logs) {
    const data = JSON.parse(log.data.toString());
    // console.log(log.createdAt);
    console.log(
      log.createdAt,
      log.message.toString(),
      Object.keys(data),
      data["stack"],
      data["name"]
    );
  }
};

const clearDB = async () => {
  const limit = "2025-07-30";
  for (let i = 0; i < 50; i++) {
    // console.time("LedgerChange");
    // await prisma.$executeRaw`
    //   DELETE FROM LedgerChange WHERE createdAt < ${limit} and key191Chars LIKE 'BALANCE%' LIMIT 50000;`.then(
    //   console.log
    // );
    // console.timeEnd("LedgerChange");
    // console.log(new Date());

    console.time("Event");
    await prisma.$executeRaw`
    DELETE FROM Event WHERE createdAt < ${limit} LIMIT 50000;`.then(
      console.log
    );
    console.timeEnd("Event");
    console.log(new Date());
  }
};

const debugPL = async () => {
  const txs = await prisma.operation.findMany({
    where: {
      callerAddress: "AU1CEgenUUUagyvdyqpn6QKDRQwrXSDZzaxaV46c9eL3L5q5Vi5o",
      targetAddress: "AS12UMSUxgpRBB6ArZDJ19arHoxNkkpdfofQGekAiAJqsuE6PEFJy",
      targetFunction: "removeLiquidityMAS",
      createdAt: { gte: new Date(Date.now() - ONE_DAY) },
      // OR: [
      //   { targetFunction: "removeLiquidity" },
      //   { targetFunction: "removeLiquidityMAS" },
      // ],
    },
  });
  const filtered = txs.filter(
    (tx) =>
      (tx.targetFunction as LiquidityRouterMethod) === "removeLiquidityMAS"
  );

  let sum0 = 0n;
  let sum1 = 0n;
  for (const tx of filtered) {
    console.log(Uint8Array.from(tx.data).length);
    const liquidityParams = decodeLiquidityTx(
      tx.targetFunction as LiquidityRouterMethod,
      tx.data as Uint8Array, //Uint8Array.from(tx.data),
      CHAIN_ID
    );
    sum0 += abs(BigInt(liquidityParams.amount0Min));
    sum1 += abs(BigInt(liquidityParams.amount1Min));

    console.log({
      sum0: printTA({ decimals: 18 }, sum0),
      sum1: printTA({ decimals: 9 }, sum1),
    });
  }
};

(async () => {
  // const pools = await prisma.protocolFees.findMany();
  // const globalAmounts = new Map<string, bigint>();
  // for (const { poolAddress, amount0, amount1 } of pools) {
  //   const { token0, token1 } = await prisma.pool.findFirstOrThrow({
  //     where: { address: poolAddress },
  //     include: { token0: true, token1: true },
  //   });
  //   const existingAmount0 = globalAmounts.get(token0.address) || 0n;
  //   globalAmounts.set(token0.address, existingAmount0 + BigInt(amount0));
  //   const existingAmount1 = globalAmounts.get(token1.address) || 0n;
  //   globalAmounts.set(token1.address, existingAmount1 + BigInt(amount1));
  // }
  // for (const entry of globalAmounts.entries()) {
  //   const token = await prisma.token.findFirstOrThrow({
  //     where: { address: entry[0] },
  //   });
  //   console.log(token.symbol, printTA({ decimals: token.decimals }, entry[1]));
  // }
  // const token = "AS12U4TZfNK7qoLyEERBBRDMu8nm5MKoRzPXDXans4v9wdATZedz9";
  // const amount = "12420931604440";
  // const tx = await new IERC20(token, client).transfer(
  //   v2RewarderSC,
  //   BigInt(amount)
  // );
  // console.log(tx.id);
  // await tx.waitSpeculativeExecution();
  // tx.getSpeculativeEvents().then(console.log);
  // const bs = await getLedgerEntries2(masUsdcPairV1, new Date(), [
  //   "PAIR_INFORMATION",
  //   "PAIR_INFORMATIONN",
  //   "FEES_PARAMETERS",
  // ]);
  // console.log(bs);

  // const arr = [4, 23, 26, 27, 61];
  // const ve = new IVotingEscrow(votingEscrowSC, web3Client);
  // for (const id of arr) {
  //   await ve
  //     .extract([`locked::${id}`])
  //     .then((r) => new LockedBalance().deserialize(r[0]).instance);
  // }

  // const keys = Array.from({ length: 75 }, (_, i) => `idToOwner::${i + 1}`);
  // const idToOwners = await getLedgerEntries2(votingEscrowSC, new Date(), keys);
  // const idToOwners = await new IBaseContract(
  //   votingEscrowSC,
  //   web3Client
  // ).extract(keys);
  // idToOwners.map((r, i) =>
  //   console.log(
  //     i + 1,
  //     r.length,
  //     new Address().deserialize(new Uint8Array(r)).instance.value
  //   )
  // );

  // const protocolFees = await prisma.protocolFees.findMany({
  //   where: { epoch: lastEpoch.id },
  // });
  // for (const { poolAddress, amount0, amount1 } of protocolFees) {
  //   const { token0, token1 } = await prisma.pool.findFirstOrThrow({
  //     where: { address: poolAddress },
  //     include: { token0: true, token1: true },
  //   });
  //   console.log(
  //     printTA(token0, amount0),
  //     token0.symbol,
  //     printTA(token1, amount1),
  //     token1.symbol
  //   );
  // }

  const decodeTransfer = async (
    txId: string,
    tokenAddress?: string,
    isTransferFrom = false
  ) => {
    const tx = await prisma.operation.findUniqueOrThrow({
      where: { id: txId },
    });
    if (!tokenAddress) tokenAddress = tx.targetAddress;
    const token = tokenList.find((t) => t.address === tokenAddress);
    if (!token) throw new Error("Token not found: " + tokenAddress);
    const args = new Args(tx.data);
    const from = isTransferFrom ? args.nextString() : tx.callerAddress;
    const to = args.nextString();
    const amount = args.nextU256();
    const amountParsed = printTA(token, amount);
    console.log({ from, to, amountParsed, token: token.symbol });
    return { from, to, amount, token };
  };

  const txId = "O1TsB9PSYEoCnPb2ZJeGe3v71TcmoUWGE9mMk9n1SoCjZEmDSFr";
  const tx = await prisma.operation.findUniqueOrThrow({
    where: { id: txId },
    include: { events: true },
  });
  const args = new Args(tx.data);
  console.log(args.serialize().length);
  const delegator = args.nextU32();
  const delegatee = args.nextU32();
  console.log({ delegator, delegatee });
  const ve = new IVotingEscrow(votingEscrowSC, web3Client);
  const ownerOfDelegator = await ve.ownerOf(Number(delegator));
  const ownerOfDelegatee = await ve.ownerOf(Number(delegatee));
  console.log({ ownerOfDelegator, ownerOfDelegatee });

  // const multicalls = await prisma.operation.findMany({
  //   where: { targetFunction: "multicall" },
  //   include: { events: true },
  // });
  // for (const multicall of multicalls) {
  //   if (!EOAs.includes(multicall.callerAddress)) continue;

  //   const txs = new Args(multicall.data).nextSerializableObjectArray(Tx);
  //   for (const tx of txs) {
  //     if (tx.method !== "transferFrom") continue;

  //     console.log(multicall.id);
  //     const decoded = await decodeTransfer(multicall.id, tx.to, true);
  //   }
  // }
})();
