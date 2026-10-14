import * as Methods from "./methods";
import { describe, expect, it } from "vitest";
import {
  depositEvents,
  swapEvents,
  withdrawEvents,
} from "../indexer/src/__tests__/placeholder";
import { ONE_DAY, getDailyTick } from "./utils";
import { TokenAmount, parseUnits } from "@dusalabs/sdk";
import { USDC } from "./contracts";
import { Maker } from "@prisma/client";
import { OutputEvents } from "@massalabs/massa-web3/dist/esm/generated/client-types";

describe("isEvent", () => {
  const context: OutputEvents[number]["context"] =
    {} as OutputEvents[number]["context"];
  it("returns true for remove liquidity event", () => {
    const poolAddress = "0x";
    const event: OutputEvents[number] = {
      context: {
        ...context,
        call_stack: [poolAddress],
      },
      data: withdrawEvents[0],
    };

    expect(Methods.isLiquidityEvent(event, poolAddress)).toBe(true);
  });
  it("returns true for add liquidity event", () => {
    const poolAddress = "0x";
    const event: OutputEvents[number] = {
      context: {
        ...context,
        call_stack: [poolAddress],
      },
      data: depositEvents[0],
    };

    expect(Methods.isLiquidityEvent(event, poolAddress)).toBe(true);
  });
  it("returns true for remove liquidity event", () => {
    const poolAddress = "0x";
    const event: OutputEvents[number] = {
      context: {
        ...context,
        call_stack: [poolAddress],
      },
      data: swapEvents[0],
    };

    expect(Methods.isLiquidityEvent(event, poolAddress)).toBe(false);
  });
});
describe("calculateWeeklyStreak", () => {
  const now = Date.now();

  it("returns 0 for a single record two weeks ago", () => {
    const p1 = new Date(now - ONE_DAY * 14);
    expect(Methods.calculateWeeklyStreak([p1])).toBe(0);
  });
  it("returns 0 for a single record today", () => {
    const p1 = new Date();
    expect(Methods.calculateWeeklyStreak([p1])).toBe(0);
  });
  it("returns 1 for a single record last week", () => {
    const p1 = new Date(now - ONE_DAY * 7);
    expect(Methods.calculateWeeklyStreak([p1])).toBe(1);
  });
  it("returns 1 for two records in the same week", () => {
    const p1 = new Date(now - ONE_DAY * 5);
    const p2 = new Date(now - ONE_DAY * 6);

    expect(Methods.calculateWeeklyStreak([p1, p2])).toBe(1);
  });
  it("returns 1 for one record last week and one record today", () => {
    const p1 = new Date(now - ONE_DAY * 7);
    const p2 = new Date();

    expect(Methods.calculateWeeklyStreak([p1, p2])).toBe(1);
  });
  it("returns 2 for two records in two consecutive weeks", () => {
    const p1 = new Date(now - ONE_DAY * 14);
    const p2 = new Date(now - ONE_DAY * 7);

    expect(Methods.calculateWeeklyStreak([p1, p2])).toBe(2);
  });
  it("returns 1 for one record last week and calculating streak on monday", () => {
    const prevMonday = getDailyTick();
    prevMonday.setDate(prevMonday.getDate() - ((prevMonday.getDay() + 6) % 7));

    const p1 = new Date(prevMonday.getTime() - ONE_DAY * 3);

    expect(Methods.calculateWeeklyStreak([p1], prevMonday.getTime())).toBe(1);
  });
});
// Streak = number of consecutive days with activity, counting back from the day of `now`
// (default: today). A day without activity ends the streak, so it is 0 when there is no
// activity on the day of `now`.
describe("calculateDailyStreak", () => {
  const now = Date.now();

  it("returns 0 without records", () => {
    expect(Methods.calculateDailyStreak([])).toBe(0);
  });
  it("returns 1 for a single record today", () => {
    expect(Methods.calculateDailyStreak([new Date(now)])).toBe(1);
  });
  it("returns 0 for a single record yesterday (no activity today)", () => {
    expect(Methods.calculateDailyStreak([new Date(now - ONE_DAY)])).toBe(0);
  });
  it("returns 0 for a single record two days ago", () => {
    expect(Methods.calculateDailyStreak([new Date(now - ONE_DAY * 2)])).toBe(0);
  });
  it("counts two records on the same day once", () => {
    const p1 = new Date(now);
    const p2 = new Date(now);
    expect(Methods.calculateDailyStreak([p1, p2])).toBe(1);
  });
  it("returns 2 for one record yesterday and one record today", () => {
    const p1 = new Date(now - ONE_DAY);
    const p2 = new Date(now);
    expect(Methods.calculateDailyStreak([p1, p2])).toBe(2);
  });
  it("returns 0 for consecutive days that end before today", () => {
    const p1 = new Date(now - ONE_DAY * 2);
    const p2 = new Date(now - ONE_DAY);
    expect(Methods.calculateDailyStreak([p1, p2])).toBe(0);
  });
  it("stops at the first day without activity", () => {
    const p1 = new Date(now - ONE_DAY * 3);
    const p2 = new Date(now - ONE_DAY);
    const p3 = new Date(now);
    expect(Methods.calculateDailyStreak([p1, p2, p3])).toBe(2);
  });
  it("counts back from the given `now`", () => {
    const monday = getDailyTick();
    monday.setDate(monday.getDate() - ((monday.getDay() + 6) % 7));
    const sunday = new Date(monday.getTime() - ONE_DAY);

    expect(Methods.calculateDailyStreak([sunday], monday.getTime())).toBe(0);
    expect(Methods.calculateDailyStreak([sunday], sunday.getTime())).toBe(1);
    expect(
      Methods.calculateDailyStreak([sunday, monday], monday.getTime())
    ).toBe(2);
  });
});
describe("calculateUSDValue", () => {
  it("handle worthless tokens", () => {
    const amount0 = new TokenAmount(USDC, parseUnits("10", USDC.decimals));
    const value0 = 1;
    const amount1 = new TokenAmount(
      Methods.toToken({ address: "", decimals: 18 }),
      parseUnits("10", 18)
    );
    const value1 = 0;
    expect(Methods.calculateUSDValue(amount0, value0, amount1, value1)).toBe(
      10
    );
  });
});
