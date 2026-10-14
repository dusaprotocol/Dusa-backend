import { handlePrismaError, prisma } from "../common/db";
import { getDailyTick, ONE_DAY } from "../common/utils";
import { IBaseContract, Token, TokenAmount } from "@dusalabs/sdk";
import { web3Client } from "../common/client";
import {
  calculateUSDValue,
  fetchUserLiquidity,
  roundFraction,
  toFraction,
  toToken,
} from "../common/methods";
import { getTokenValueRaw } from "../common/datastoreFetcher";
import { Args, ArrayTypes, bytesToArray } from "@massalabs/massa-web3";
import { WMAS, tokenList, POM, PUR } from "../common/contracts";
import { getPools } from "../indexer/src/db";
import { Prisma } from "@prisma/client";

const balanceKey = (account: string) => "BALANCE" + account;

const balanceOfBatch = async (
  tokens: string[],
  accounts: string[]
): Promise<bigint[][]> => {
  const promises = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    // const batchSize = 100;
    // for (let j = 0; j < accounts.length; j += batchSize) {
    const keys = accounts.map((account) => balanceKey(account));
    const promise = new IBaseContract(token, web3Client).extract(keys);
    promises.push(promise);
    // }
  }
  const entries = await Promise.all(promises);

  const erc20Balances = entries.map((entryGroup) => {
    return entryGroup.map((entry) => {
      try {
        return entry?.length ? new Args(entry).nextU256() : 0n;
      } catch {
        return 0n;
      }
    });
  });

  return erc20Balances;
};

// const fetchKeys = (address: string, prefix: string): Promise<string[]> =>
//   fetch(
//     indexerApi + `/datastore-keys?address=${address}&prefix=${prefix}`
//   ).then((r) => r.json());
// const fetchEntries = (address: string, keys: string[]): Promise<Uint8Array[]> =>
//   fetch(
//     indexerApi +
//       `/datastore-entries?address=${address}&keys=${keys
//         .map(encodeURIComponent)
//         .join(",")}`
//   ).then((r) => r.json());

const main = async () => {
  console.time("portfolio");
  const gte = new Date(Date.now() - ONE_DAY * 30);
  const txs = { some: { timestamp: { gte } } };
  const users = await prisma.user.findMany({
    select: { address: true },
    where: { OR: [{ swapTxs: txs, liquidityTxs: txs }] },
    take: 100,
  });
  console.log(`Processing ${users.length} users`);

  const date = getDailyTick();
  const tokens = tokenList;
  const wmasIndex = tokens.findIndex((t) => t.address === WMAS.address);
  const tokenPrices = await Promise.all(tokens.map((t) => getTokenValueRaw(t)));
  console.log(tokenPrices);
  const masPrice = tokenPrices[wmasIndex];
  const pools = await getPools(true);
  // remove meme pools
  const pomPoolIndex = pools.findIndex(
    (p) => p.token0Address === POM.address || p.token1Address === POM.address
  );
  const purPoolIndex = pools.findIndex(
    (p) => p.token0Address === PUR.address || p.token1Address === PUR.address
  );
  if (pomPoolIndex !== -1) pools.splice(pomPoolIndex, 1);
  if (purPoolIndex !== -1) pools.splice(purPoolIndex, 1);

  const globalERC20Balances = await balanceOfBatch(
    tokens.map((t) => t.address),
    users.map((u) => u.address)
  );

  // pool
  for (const pool of pools) {
    // get distinct bin ids
    const depositedBinsPrefix = "deposited_bins::";
    const depositedBinsKeys = users.map((u) => depositedBinsPrefix + u.address);
    const depositedBinsRaw = await new IBaseContract(
      pool.address,
      web3Client
    ).extract(depositedBinsKeys);
    const depositedBins = depositedBinsRaw.map((entry) =>
      entry?.length ? bytesToArray<number>(entry, ArrayTypes.U32) : []
    );
    const distinctBins = new Set(depositedBins.flat());
    console.log(distinctBins.size + " distinct bins for pool " + pool.address);

    // get reserves,
  }

  let i = 0;
  for (const user of users) {
    // console.log(`Processing user ${user.address}`);

    const erc20Balances = globalERC20Balances.map((subArray) => subArray[i]);

    const masBalance = await web3Client
      .balanceOf([user.address], false)
      .then((r) => r[0].balance)
      .catch(() => 0n);

    const x = (tok: Token, bal: bigint, price: number) =>
      roundFraction(new TokenAmount(tok, bal).multiply(toFraction(price)));

    const tokenValues = erc20Balances.map((balance, j) =>
      x(tokens[j], balance, tokenPrices[j])
    );
    const masValue = x(WMAS, masBalance, masPrice);

    const tokenBalances: Prisma.UserAnalyticsCreateInput["tokenBalances"] = {
      createMany: {
        data: erc20Balances
          .map((balance, j) => ({
            tokenAddress: tokens[j].address,
            balance: balance.toString(),
            value: tokenValues[j],
          }))
          .concat({
            tokenAddress: "0x0",
            balance: masBalance.toString(),
            value: masValue,
          }),
      },
    };
    const tokensValue = tokenValues.reduce((a, b) => a + b, masValue);

    console.time("poolPositions");
    const poolPositions = await Promise.all(
      pools.map((pool) => fetchUserLiquidity(pool, pool.address, user.address))
    );
    console.timeEnd("poolPositions");

    const poolValues = poolPositions.map((position, j) => {
      if (!position.amount0 && !position.amount1) return 0;

      const t0 = toToken(pools[j].token0);
      const t1 = toToken(pools[j].token1);
      const token0Index = tokens.findIndex((t) => t.address === t0.address);
      const token1Index = tokens.findIndex((t) => t.address === t1.address);
      const token0Price = tokenPrices[token0Index] || 0;
      const token1Price = tokenPrices[token1Index] || 0;

      return calculateUSDValue(
        new TokenAmount(t0, position.amount0),
        token0Price,
        new TokenAmount(t1, position.amount1),
        token1Price
      );
    });
    const poolBalances: Prisma.UserAnalyticsCreateInput["poolBalances"] = {
      createMany: {
        data: poolPositions.map((position, j) => ({
          poolAddress: pools[j].address,
          balance0: position.amount0.toString(),
          balance1: position.amount1.toString(),
          fees0: position.fees0.toString(),
          fees1: position.fees1.toString(),
          value: poolValues[j],
        })),
      },
    };

    const poolsValue = poolValues.reduce((a, b) => a + b, 0);

    const totalValue = tokensValue + poolsValue;

    prisma.userAnalytics
      .create({
        data: {
          userAddress: user.address,
          totalValue,
          tokenBalances,
          poolBalances,
          date,
        },
      })
      // .then(() => logger.info(`User ${user.address} analytics saved`))
      .catch(handlePrismaError);

    i++;
  }
  console.timeEnd("portfolio");
};

(async () => {
  await prisma.poolBalance.deleteMany();
  await prisma.tokenBalance.deleteMany();
  await prisma.userAnalytics.deleteMany();
  await main();
})();
