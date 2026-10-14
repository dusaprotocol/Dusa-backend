import { it, expect, test, describe } from "vitest";
import * as d from "./date";

describe("getTick", () => {
  const now = new Date();
  it("return proper closest tick", () => {
    const tick = d.getClosestTick();
    expect(tick.getMinutes() % (d.ONE_TICK / d.ONE_MINUTE)).toEqual(0);
    expect(tick.getUTCHours()).toEqual(now.getUTCHours());
  });
  it("return proper hourly tick", () => {
    const tick = d.getHourlyTick();
    expect(tick.getMinutes()).toEqual(0);
    expect(tick.getUTCHours()).toEqual(now.getUTCHours());
  });
  it("return proper daily tick", () => {
    const tick = d.getDailyTick();
    expect(tick.getMinutes()).toEqual(0);
    expect(tick.getUTCHours()).toEqual(0);
    expect(tick.getDay()).toEqual(now.getDay());
  });
});
describe("secondsUntilNextTick", () => {
  it("return proper value before", () => {
    const shift = 1;
    let now = d.getClosestTick();
    now = new Date(now.getTime() - shift * 1000);
    const s = d.secondsUntilNextTick(now.getTime());
    expect(s).toEqual(shift);
  });
  it("return proper value atm", () => {
    let now = d.getClosestTick();
    const s = d.secondsUntilNextTick(now.getTime());
    expect(s).toEqual(300);
  });
  it("return proper value after", () => {
    const shift = 1;
    let now = d.getClosestTick();
    now = new Date(now.getTime() + shift * 1000);
    const s = d.secondsUntilNextTick(now.getTime());
    expect(s).toEqual(d.ONE_TICK / 1000 - shift);
  });
});
