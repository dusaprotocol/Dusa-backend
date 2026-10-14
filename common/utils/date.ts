import { isBuildnet } from "../config";

// Constants (in ms)
export const ONE_MINUTE = 60 * 1000;
export const ONE_HOUR = 60 * ONE_MINUTE;
export const ONE_DAY = 24 * ONE_HOUR;
export const ONE_WEEK = 7 * ONE_DAY;
export const ONE_PERIOD = 16_000;
export const ONE_BLOCK = 500;
export const BLOCKS_PER_PERIOD = ONE_PERIOD / ONE_BLOCK;
export const BLOCKS_PER_MINUTE = ONE_MINUTE / ONE_BLOCK;
export const BLOCKS_PER_HOUR = ONE_HOUR / ONE_BLOCK;

// (changes here should be reflected in the interface)
export const ONE_TICK = 5 * ONE_MINUTE;
export const TICKS_PER_DAY = ONE_DAY / ONE_TICK;

// Cron expressions
export const EVERY_TICK = "*/5 * * * *" as const;
export const EVERY_PERIOD = "*/16 * * * * *" as const;

// UNIX timestamp of the first slot
export const genesisTimestamp = isBuildnet ? 1704289800000 : 1705312800000;
// export const genesisTimestamp = await web3Client
//   .publicApi()
//   .getNodeStatus()
//   .then((r) => r.config.genesis_timestamp);
// UNIX timestamp of Dusa Protocol launch
export const launchTimestamp = 1_713_182_400_000; // new Date("2024-04-15").getTime()

/**
 * Returns the slot corresponding to the given timestamp
 * @param timestamp
 * @returns
 */
export const parseTimestamp = (
  _timestamp: number | Date | string
): { period: bigint; thread: number } => {
  const timestamp = new Date(_timestamp).getTime();
  const elapsedInMs = timestamp - genesisTimestamp;

  return {
    period: BigInt(Math.floor(elapsedInMs / ONE_PERIOD)),
    thread: Math.floor(((elapsedInMs % ONE_PERIOD) / 1000) * 2),
  };
};

export const parseSlot = (thread: number, period: number): number =>
  genesisTimestamp + period * ONE_PERIOD + (thread / 2) * 1000;

/**
 * Returns the number of seconds until next tick
 * @param now
 * @returns
 */
export const secondsUntilNextTick = (timestamp = Date.now()) => {
  const nextTickInMs = getClosestTick(timestamp + ONE_TICK).getTime();
  return Math.floor((nextTickInMs - timestamp) / 1000);
};

/**
 * Returns the number of seconds until next tick
 * @param now
 * @returns
 */
export const secondsUntilNextFriday = (timestamp = Date.now()) => {
  while (new Date(timestamp).getDay() !== 5) {
    timestamp += ONE_DAY;
  }
  const nextFridayInMs = timestamp;
  return Math.floor((nextFridayInMs - timestamp) / 1000);
};

/**
 * Returns the closest tick to the given timestamp (rounded down)
 * @param timestamp
 * @returns
 */
export const getClosestTick = (
  timestamp: number | Date | string = Date.now()
) => getTick(timestamp, ONE_TICK);

export const getHourlyTick = (timestamp: number | Date | string = Date.now()) =>
  getTick(timestamp, ONE_HOUR);

export const getDailyTick = (timestamp: number | Date | string = Date.now()) =>
  getTick(timestamp, ONE_DAY);

const getTick = (timestamp: number | Date | string, x: number) =>
  new Date(Math.floor(new Date(timestamp).getTime() / x) * x);
