import { describe, it, expect } from "vitest";
import * as DF from "./datastoreFetcher";
import { DAI, USDC, USDT, WETH, WMAS, PUR, DUSA } from "../common/contracts";

// Live sanity checks against the network in CHAIN_ID / CHAIN_URL (mainnet in CI), with
// ranges wide enough to survive normal market moves (see common/datastoreFetcher.test.ts)
describe("getTokenValue", () => {
  const testCases = [
    { token: USDC, expectedMin: 1, expectedMax: 1 },
    { token: WMAS, expectedMin: 0.0001, expectedMax: 1 },
    { token: WETH, expectedMin: 500, expectedMax: 20000 },
    { token: DAI, expectedMin: 0.8, expectedMax: 1.2 },
    { token: DUSA, expectedMin: 0.00001, expectedMax: 1 },
    // { token: USDT, expectedMin: 0.9, expectedMax: 1.1 },
    // { token: PUR, expectedMin: 1e-8, expectedMax: 1 },
  ];

  testCases.forEach(({ token, expectedMin, expectedMax }) => {
    it(`returns value between ${expectedMin} and ${expectedMax} for ${token.symbol}`, async () => {
      const value = await DF.getTokenValue(token);
      const quoterValue = await DF.getTokenValueUsingQuoter(token);
      expect(value).toBeGreaterThanOrEqual(expectedMin);
      expect(value).toBeLessThanOrEqual(expectedMax);
    });
  });
});
