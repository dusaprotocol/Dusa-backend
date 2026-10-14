import { ChainId } from "@dusalabs/sdk";
import dotenv from "dotenv";
dotenv.config({ path: "../.env" }); // loads env variables

const ONE_HOUR = 60 * 60 * 1000;
const ONE_DAY = 24 * ONE_HOUR;

function getEnvVariable(key: string, defaultValue?: string): string {
  const value = process.env[key];
  if (!value) {
    if (defaultValue) return defaultValue;
    throw new Error(`Missing ${key} in .env file`);
  }

  return value;
}

/* ENV VARIABLES */

export const CHAIN_URL = getEnvVariable("CHAIN_URL");
export const CHAIN_ID = Number(getEnvVariable("CHAIN_ID")) as ChainId;
export const isBuildnet = CHAIN_ID === ChainId.BUILDNET;
export const networkName = isBuildnet ? "buildnet" : "mainnet";

export const grpcDefaultHost = getEnvVariable("GRPC_HOST");
export const grpcPort = Number(getEnvVariable("GRPC_PORT"));

export const trackLiquidityTxs =
  getEnvVariable("TRACK_LIQUIDITY_TXS", "true") === "true";

/* POINTS/AIRDROP */
export const WEEKLY_POINTS = 1_000_000;
export const REFERRAL_BONUS = 10; // base 100
export const MAKER_MULTIPLIER = 4; // swap value multiplier
export const SUPPLY = 100_000_000;
export const MCAP = 10_000_000;
export const BASE_ALLOCATION_PCT = 1.5;
export const ALLOCATION_PCT_PER_SEASON = 0.5;
export const NUMBERS_OF_SEASONS = 8;
export const ALLOCATION_PERCENTAGE =
  BASE_ALLOCATION_PCT + ALLOCATION_PCT_PER_SEASON * (NUMBERS_OF_SEASONS - 1);
export const AIRDROP_VALUE = MCAP * (ALLOCATION_PERCENTAGE / 100);
const POINTS_PROGRAM_LAUNCH = new Date("2024-04-12");
const weeksElapsed = Math.round(
  (Date.now() - POINTS_PROGRAM_LAUNCH.getTime()) / (7 * 24 * 60 * 60 * 1000)
);
export const TOTAL_POINTS = weeksElapsed * WEEKLY_POINTS;
export const POINT_VALUE = AIRDROP_VALUE / TOTAL_POINTS;

// 30% points only. Kept out of the repository: comma-separated list in SYBIL_ADDRESSES.
export const SYBILS = (process.env.SYBIL_ADDRESSES ?? "")
  .split(",")
  .map((a) => a.trim())
  .filter(Boolean);

// No points for these addresses
export const BLACKLIST = [
  "AU1Vy3NyCGaZe8r84C4J5bGuCVbcQfaSZMftWWNRZUSTBmLWsxmc",
  "AU1P3VLNRVcT5BT9Gax6ndB1AVvaHtfNnNKfYJx6quRRWPPbh57F",
  "AU1N5omXKidm4YQsiCP9fCw1NgxDKEwNruzcLRSeWfgRWHfXzQob",
];
export const GREYLIST = [
  "AU13FQ2yFWoZE8g7B1nexpi9K6HWmoKaZY8gbCz58Yfr9rmmNQZQ",
  "AU1UQiPimhzxm2g3wE7uozATiP2uXS3YHqGuXj4den3TDTb1bFoT",
  "AU1zvmmP8epRx9i4Wc6DwNJGpCSEJWVpJK5VaB1i6LwtcJkwYsab",
  "AU1CEgenUUUagyvdyqpn6QKDRQwrXSDZzaxaV46c9eL3L5q5Vi5o",
  "AU12YwEYQYrPGSEjKMtoFv3i92zF149yFarnxyTYe5Ze8E7tn2CLJ",
  "AU1LhKv5T3Dp1kSGJvgRSTZbXcRx51L5i8GeTddakXyhDMcaihcn",
  "AU1RGLYMzMmm2CHjpfmgpMEUz2LbknLHEBZ9AAbmyf5o3A38Wssp",
];

// excluded from DUSA circulating supply
export const EXCL_DUSA_CIRCULATING = [
  "AU1FcqrjNCePHhBBHknCLf15uH9ajM9my1Q1oNdAU8TWfy9sTbzS",
  "AU1CEgenUUUagyvdyqpn6QKDRQwrXSDZzaxaV46c9eL3L5q5Vi5o",
  "AS12fgnFfweZ8Qrwsry9k6Stdv2PZDH5hCEsK9ZMMRt1yduUZ4mD8", // vesting
  "AS1kvD1VnfKGVfztHQgC45TcwDbtrD8g7r8JHTxpSjzWpfDnP4T3", // rewarder
  "AS1DADmvUTWcm36enMD643xMqiJKCbhmHWuDsy1mZkd1LmuqEetF", // staking
];

export const NO_VALUE_TOKENS = [
  "AS1pUweebhuqQisMZJZcfy35gZqYKLSwjvFdcYTNNWM2jBR4xpwt",
  "AS1R876U2UYiPNc1RmrprnJP16697ddBP8fbNtS1znWQRVXK9dqq",
  "AS12AAiAZfVxgApf1PG2hAng2Wg73dpMu54hW2YsCx8hnChtuqJR8",
  "AS12A9iN7mPYV1TCVSfEGaJDeEdBKnU3C87T5i6NNgd3R6hPLikcW",
  "AS12WirWdurggUQSnRTx6cJ5DqwkdWJAkgBXx95yZhzxaWs5eSoaK",
  "AS12fWp8S9tZYSxxV9m1Gkqjsruzbh38UdSu4JRx7JduCj6248VcY",
  "AS12apXTcyWabTSYA8SPU5M5RgU4gduPBF8R8wjahN4K3kEdHP1xN",
  "AS12V2SvvB8vSUUq7Y3RX2cFtM2qyadWRqqvRr64QWKkaxEbEGnji",
];

/* MISC */
export const FEE_WEIGHT = 0.7;
export const GUILD_ID = "1004760013111316501";
export const MAX_BINS_PER_EVENT = 10;

// export const indexerApi = `https://indexer-${networkName}-dusa.up.railway.app`;
export const indexerApi = `http://localhost:3001`;

/* EPOCHS (copy-paste from interface) */

interface Epoch {
  id: number;
  from: Date;
  to: Date;
}

const genesisEpoch: Epoch = {
  id: 0,
  from: new Date("2024-04-15T00:00:00Z"),
  to: new Date("2024-04-21T23:59:59Z"),
};

export const calculateEpochDates = (
  epochId: number
): { from: Date; to: Date } => {
  if (epochId === 0) return genesisEpoch;
  else if (epochId < 73) {
    // Regular epochs before transition (Monday to Sunday)
    return {
      from: new Date(genesis + (epochId - 1) * epochDuration),
      to: new Date(genesis + epochId * epochDuration - 1),
    };
  } else if (epochId === 73) {
    // Transition epoch: Monday to Wednesday only (3 days)
    const startDate = new Date(genesis + (epochId - 1) * epochDuration);
    const endDate = new Date(startDate.getTime() + 3 * ONE_DAY - 1);
    return { from: startDate, to: endDate };
  } else {
    // New cycle epochs (Thursday to Wednesday)
    // Calculate base date for epoch 74 (starts on Thursday after epoch 73 ends)
    const epoch73Start = new Date(genesis + 72 * epochDuration + 1000);
    const epoch74Start = new Date(epoch73Start.getTime() + 3 * ONE_DAY); // Thursday after epoch 73's Wednesday

    const epochsSince74 = epochId - 74;
    const startDate = new Date(
      epoch74Start.getTime() + epochsSince74 * epochDuration
    );
    const endDate = new Date(startDate.getTime() + epochDuration - 1);

    return { from: startDate, to: endDate };
  }
};

// epoch 0 to 90, with special handling for epoch 73+ transition
export const epochDuration = 7 * ONE_DAY;
export const genesis = genesisEpoch.to.getTime();

const elapsedWeeks = Math.floor((Date.now() - genesis) / epochDuration);
const numberOfEpochs = elapsedWeeks + 1;
export const everyEpochs: Epoch[] = [
  ...Array.from({ length: numberOfEpochs + 5 }, (_, i) => {
    // add 5 epochs buffer to avoid issues
    const { from, to } = calculateEpochDates(i);
    return {
      id: i,
      from,
      to,
    };
  }),
];

const now = Date.now();

// past and current epochs (last 5)
export const epochs = everyEpochs
  .filter((epoch) => now >= epoch.from.getTime())
  .slice(-5);

export const currentEpoch =
  epochs.find(
    (epoch) => now >= epoch.from.getTime() && now <= epoch.to.getTime()
  ) || epochs[epochs.length - 1];
export const lastEpoch =
  epochs.find((epoch) => epoch.id === currentEpoch.id - 1) ||
  epochs[epochs.length - 2];
export const nextEpoch: Epoch = {
  id: currentEpoch.id + 1,
  from: new Date(currentEpoch.to.getTime() + 1),
  to: new Date(currentEpoch.to.getTime() + epochDuration),
};
