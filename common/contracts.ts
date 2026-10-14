import {
  DCA_MANAGER_ADDRESS,
  DCA_MANAGER_ADDRESS_V2,
  LB_FACTORY_ADDRESS,
  LB_ROUTER_ADDRESS,
  LIMIT_ORDER_MANAGER_ADDRESS,
  USDC as _USDC,
  WMAS as _WMAS,
  WETH as _WETH,
  WETH_B as _WETH_B,
  USDT as _USDT,
  DAI as _DAI,
  WBTC as _WBTC,
  DUSA as _DUSA,
  LB_QUOTER_ADDRESS,
  Token,
  IBaseContract,
  MULTICALL_ADDRESS,
  ChainId,
  V2_LB_QUOTER_ADDRESS,
  V2_LB_ROUTER_ADDRESS,
  V2_LB_FACTORY_ADDRESS,
  V0_ROUTER_ADDRESS,
  V0_FACTORY_ADDRESS,
} from "@dusalabs/sdk";

import { CHAIN_ID, isBuildnet } from "./config";
import { web3Client } from "./client";
import { bytesToStr, strToBytes } from "@massalabs/massa-web3";
import { prisma } from "./db";

/* CORE */

export const v0RouterSC = V0_ROUTER_ADDRESS[CHAIN_ID];
export const v0FactorySC = V0_FACTORY_ADDRESS[CHAIN_ID];

export const quoterSC = LB_QUOTER_ADDRESS[CHAIN_ID];
export const routerSC = LB_ROUTER_ADDRESS[CHAIN_ID];
export const factorySC = LB_FACTORY_ADDRESS[CHAIN_ID];

export const v2QuoterSC = V2_LB_QUOTER_ADDRESS[CHAIN_ID];
export const v2RouterSC = V2_LB_ROUTER_ADDRESS[CHAIN_ID];
export const deprecatedV2RouterSC =
  "AS1fodax6ZWcmJQ2FDrV5MUsc111WQuWDhFtF1CjbEsvH8CjCz4y";
export const v2FactorySC = V2_LB_FACTORY_ADDRESS[CHAIN_ID];

export const V0_CORE: string[] = [v0RouterSC, v0FactorySC];
export const V1_CORE: string[] = [routerSC, factorySC];
export const V2_CORE: string[] = [
  v2RouterSC,
  v2FactorySC,
  deprecatedV2RouterSC,
];
export const FACTORIES: string[] = [v0FactorySC, factorySC, v2FactorySC];
export const ROUTERS: string[] = [
  v0RouterSC,
  routerSC,
  v2RouterSC,
  deprecatedV2RouterSC,
];
export const CORE: string[] = [...V0_CORE, ...V1_CORE, ...V2_CORE];

/* PERIPHERY */
export const dcaSC = DCA_MANAGER_ADDRESS[CHAIN_ID];
export const dcaSCV2 = DCA_MANAGER_ADDRESS_V2[CHAIN_ID];

export const orderSC = {
  [ChainId.BUILDNET]: ["AS1Gfy1wx7DuPZhbH9N1W9H7q5Sdjn51zMNP6sDpCdozT6F715kP"],
  [ChainId.MAINNET]: [""],
}[CHAIN_ID]; // LIMIT_ORDER_MANAGER_ADDRESS[CHAIN_ID];
export const rewarderSC =
  "AS1mviXQDY1QW2poumXD89EkXasyeGx4qSCXdcGH5p4pXmur5zEv";
export const v2RewarderSC =
  "AS1kvD1VnfKGVfztHQgC45TcwDbtrD8g7r8JHTxpSjzWpfDnP4T3";
export const deprecatedMulticallSC =
  "AS1FJrNBtZ5oXK9y6Wcmiio5AV6rR2UopqqdQWhBH4Fss9JNMySm";
export const multicallSC = MULTICALL_ADDRESS[CHAIN_ID];
export const stakingSC = isBuildnet
  ? ""
  : "AS1DADmvUTWcm36enMD643xMqiJKCbhmHWuDsy1mZkd1LmuqEetF";
export const PERIPHERY: string[] = [
  dcaSC,
  dcaSCV2,
  ...orderSC,
  rewarderSC,
  v2RewarderSC,
  deprecatedMulticallSC,
  multicallSC,
  stakingSC,
];

/* GOVERNANCE */
export const votingEscrowSC = isBuildnet
  ? "AS1MH6eJ4XGvw4Lsq7qS8UDjVzAgcHBSSTdc6z3odppM9Q134UzT"
  : "AS1q76iSMJ8Dj5gVBVK26y11yuFi9eVzUmTzwf5ANgoypMVcNjXj";
export const voterSC = isBuildnet
  ? "AS1UxmVYxof8cKDhjjALpJTSY3ZWviV1NquZg4ovXU5ycrkpQogD"
  : "AS1rg37d1cFXrSXbEaKbGPBKRXahshk6VgvwJXjg48MbyuwM1ea6";
export const daoSC = isBuildnet
  ? "AS11LdeWiMcM3J2MmcSmH17VZ8qg2jZPHDapHGK4Bx5HaygVJTDB"
  : "AS1dX2DyCSBRPZU1CTaZbqfnYw9HswrB5rBgJgW14JyB4SfewxoP";
export const GOVERNANCE: string[] = [votingEscrowSC, voterSC, daoSC];

/* TOKENS */
export const USDC = _USDC[CHAIN_ID];
export const WMAS = _WMAS[CHAIN_ID];
export const DAI = _DAI[CHAIN_ID];
export const WETH = _WETH[CHAIN_ID];
export const WETH_B = _WETH_B[CHAIN_ID];
export const USDT = _USDT[CHAIN_ID];
export const WBTC = _WBTC[CHAIN_ID];
export const DUSA = _DUSA[CHAIN_ID];

const jellyTokenAddress = isBuildnet
  ? "AS1fSJMwRMhwZW7vndDjARo47r3zHdAUMRiNh617pyN15YR1ddgu"
  : "AS1kVpmFjPeyamyBJ77x24M2r764hd651kEZ9GjiR6uZbEQTqdrk";
export const JELLY = new Token(CHAIN_ID, jellyTokenAddress, 18, "JELLY");
// prettier-ignore
const purTokenAddress = "AS133eqPPaPttJ6hJnk3sfoG5cjFFqBDi1VGxdo2wzWkq8AfZnan" // isBuildnet ? "" : ""
export const PUR = new Token(CHAIN_ID, purTokenAddress, 18, "PUR");
// prettier-ignore
const pomTokenAddress = "AS1nqHKXpnFXqhDExTskXmBbbVpVpUbCQVtNSXLCqUDSUXihdWRq" // isBuildnet ? "" : ""
export const POM = new Token(CHAIN_ID, pomTokenAddress, 18, "POM");
// prettier-ignore
const fpomTokenAddress = "AS12GDtiLRQELN8e6cYsCiAGLqdogk59Z9HdhHRsMSueDA8qYyhib" // isBuildnet ? "" : ""
export const FPOM = new Token(CHAIN_ID, fpomTokenAddress, 18, "FPOM");
// prettier-ignore
export const tokenList = [USDC, WMAS, DAI, WETH, WETH_B, USDT, JELLY, DUSA, PUR, POM, WBTC, FPOM];
export const TOKENS = tokenList.map((t) => t.address);

/* PAIRS */
export const getAllPairs = async (v2 = false): Promise<string[]> =>
  new IBaseContract(v2 ? v2FactorySC : factorySC, web3Client)
    .extract(["ALL_PAIRS"])
    .then((res) => {
      const bs = res[0];
      if (!bs || !bs.length) return [];
      // prettier-ignore
      return bytesToStr(bs).split(":").filter((s) => s);
    });
export const getAllPumpPairs = async (): Promise<string[]> => {
  const filterPrefix = "pairMapping::";
  return web3Client
    .getStorageKeys(pumpFactorySC, filterPrefix, false)
    .then(async (res) => {
      const keys = res.map((key) => String.fromCharCode(...key));
      const pairKeys = keys.filter((key) => key.startsWith(filterPrefix));
      return new IBaseContract(pumpFactorySC, web3Client)
        .extract(pairKeys)
        .then((r) => r.map((bs) => (bs ? bytesToStr(bs) : "")));
      // const tokens = pairKeys.map(
      //   (key) => key.split(filterPrefix)[1].split(":")[0]
      // );
      // return tokens;
    });
};

export const masUsdcPairV1 = isBuildnet
  ? "AS112Wdy9pM4fvLNLHQXyf7uam9waMPdG5ekr4vxCyQHPkrMMPPY"
  : "AS12Q5NyCQUtEBTnnqqBwcGyYb18szbbKv5GArcdk9tm2HitTupHw";
export const masUsdcPairV2 = isBuildnet
  ? ""
  : "AS1TVRnzkRZCeWW32tEiymnz3ghkRB28ijBPczTM5BjCrKxbazm1";
export const masUsdcPairBs = 20;
export const masEthPairV1 = isBuildnet
  ? "AS14AxjeYA1K51wwyLexL67atzS75eTCAjUm3GDYTpMeZsarEhp3"
  : "AS1Ba1T2mMpHvLEhTvsNkSDqm4djno2ezVojGrtLf1wRd8ThfZD3";
export const masEthPairV2 = isBuildnet
  ? ""
  : "AS146g616AcTMnqxP1hL2pt75ui4suY8Fq6mYPHYvCx94WKnfW9Q";
export const masEthPairBs = 15;
export const usdcUsdtPairV1 = isBuildnet
  ? ""
  : "AS1F2SAbhvknGLQKzfjaizKiZhEEd6mS1HLpZqPc2atzKE4VTNv9";
export const usdcUsdtPairV2 = isBuildnet
  ? ""
  : "AS12FjoDGyUvDGq5E4AdyaJMZ9eT8Kcgxdi5QAkmaX7rvozYBS3XQ";
export const stableEthPairV1 = isBuildnet
  ? ""
  : "AS1vQsWBLPdJFdAu75Cgh2eAqYp2rvcaurRjSfHjcfirxboLT3mG";
export const stableEthPairV2 = isBuildnet
  ? ""
  : "AS12Z25g7rM2ASuNh8TaepyFQ9pvNtLf4ioKQDuer4Ljwza7ifRCK";
export const usdcDaiPairV1 = isBuildnet
  ? ""
  : "AS12QDpZFi8szHCfyNsvB3JWT9dmHbvDx9uSjMLQ8rHVPN67rrG9n";
export const usdcDaiPairV2 = isBuildnet
  ? ""
  : "AS1mEuqfdGoTEneLxCXifS7dckshu714roZcv9nJGk5dVzVoXJSV";
export const dusaMasPairV2 = isBuildnet
  ? ""
  : "AS1GgHvg6fpaHD2i5JZC5ijEDYzpNFbCE5B3GwFLGJy5KtPLH7Ly";
export const btcUsdcPairV2 = isBuildnet
  ? ""
  : "AS186T6EhKppUa1foy61So9z8ZPgxevZHWRpzBXvhujhsMwSNcAM";
export const stablePairsV1: string[] = [
  usdcUsdtPairV1,
  stableEthPairV1,
  usdcDaiPairV1,
];
export const stablePairsV2: string[] = [
  usdcUsdtPairV2,
  stableEthPairV2,
  usdcDaiPairV2,
];
export const stablePairs: string[] = [
  ...stablePairsV1.filter((p) => p),
  ...stablePairsV2.filter((p) => p),
];
export const stablePairBs = 1;

export const V0_PAIRS: string[] = []; // TODO
export const V1_PAIRS: string[] = await getAllPairs().catch(
  () => [] as string[]
);
export const V2_PAIRS: string[] = await getAllPairs(true).catch(
  () => [] as string[]
);
export const PAIRS: string[] = [...V0_PAIRS, ...V1_PAIRS, ...V2_PAIRS];

/* PUMP */
const pumpFactorySC = isBuildnet
  ? "AS1BU12yT6f9d95jbut1B1dUkpbwqrKuW3TErh9bFa1TgZ5TwFQv"
  : "AS1fu1DMTxKohuuXKB9WYjJURvBEbiQyJZ3TWT4uVoYRqfgPLRAk";
const pumpDeployerSC = isBuildnet
  ? "AS1UQk1E1fEwBehodN1dw7ZzRc49b6ohgwQYwbcRjekTH2v1pNDC"
  : "AS12fGDZbe8aEPnUsPeHWyehppxGELn2nJ9XeuFx7NeC2cQWD9W1K";
export const PUMP_PAIRS: string[] = await getAllPumpPairs().catch(
  () => [] as string[]
);
export const PUMP: string[] = [pumpFactorySC, pumpDeployerSC];

/* MULTISIGS */
const MULTISIGS: string[] = await prisma.multisig
  .findMany()
  .then((res) => res.map((m) => m.address));

/* MISC */
export const casinoSC = "AS12sUv4W3w4nDKnQWnR74TqLVEzK5ThwAqHkkgaHRHYPEyxNK9Sw";
export const bridgeSC = "AS12ZFbbwEckKkkyGYsdJA5CbSZBWxZJoQvZth2qCm1EoseS97FM7";
export const MISC: string[] = [casinoSC, bridgeSC];

export const EOAs: string[] = [
  "AU127B3fdQwhpbUfee44HgDUzQ4UhGC9nV21sTohcwJRWvyGQpupi",
  "AU1UQiPimhzxm2g3wE7uozATiP2uXS3YHqGuXj4den3TDTb1bFoT",
  "AU1zvmmP8epRx9i4Wc6DwNJGpCSEJWVpJK5VaB1i6LwtcJkwYsab",
  "AU1CEgenUUUagyvdyqpn6QKDRQwrXSDZzaxaV46c9eL3L5q5Vi5o",
  "AU12YwEYQYrPGSEjKMtoFv3i92zF149yFarnxyTYe5Ze8E7tn2CLJ",
  "AU1LhKv5T3Dp1kSGJvgRSTZbXcRx51L5i8GeTddakXyhDMcaihcn",
  "AU1RGLYMzMmm2CHjpfmgpMEUz2LbknLHEBZ9AAbmyf5o3A38Wssp",
  "AU12MfrijnSLhhMumhnniaXRkRZ4f8GDjC3NwvBjtKqCqek8Q3mQg",
  "AU1q1Zt6po5RwwbubY3hNbShaDAqJpK7taqfR9PPA2JGq5bFhuek",
  "AU12adTRD7EFCdtRnuoqkzC6pYGfJ2fMuP4PFL8kuohxPnMrNfRyh",
  "AU1FcqrjNCePHhBBHknCLf15uH9ajM9my1Q1oNdAU8TWfy9sTbzS",
  "AU12Z9RBxzcHrrcGJacaGhnhRq2CfMfmyeXAkTTSR7fuBDwrpZ3Uy",
  "AU1GkftgcEZdjv1KRCqBDCWgZfnFPf8ftwHDxACA3MZsU2DbMCWY",
];

export const ADDRESSES: string[] = [
  ...CORE,
  ...PERIPHERY,
  ...GOVERNANCE,
  ...TOKENS,
  ...PAIRS,
  ...PUMP,
  ...PUMP_PAIRS,
  ...MULTISIGS,
  ...MISC,
];
