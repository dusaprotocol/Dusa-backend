import { describe, it, expect } from "vitest";
import * as DF from "./datastoreFetcher";
import { DAI, USDC, USDT, WETH, WETH_B, WMAS, PUR } from "./contracts";

// Live sanity checks: they quote real prices on the network in CHAIN_ID / CHAIN_URL, so
// they are meant for mainnet (CI runs them against the public mainnet RPC). The ranges
// are deliberately wide: they catch broken pricing, not market moves.
describe("getTokenValue", () => {
  const testCases = [
    { token: USDC, expectedMin: 1, expectedMax: 1 },
    { token: WMAS, expectedMin: 0.0001, expectedMax: 1 },
    { token: WETH, expectedMin: 500, expectedMax: 20000 },
    // { token: DAI, expectedMin: 0.8, expectedMax: 1.2 },
    // { token: USDT, expectedMin: 0.9, expectedMax: 1.1 },
    // { token: WETH_B, expectedMin: 1000, expectedMax: 4000 },
    // { token: PUR, expectedMin: 1e-8, expectedMax: 1 },
  ];

  testCases.forEach(({ token, expectedMin, expectedMax }) => {
    it(`returns value between ${expectedMin} and ${expectedMax} for ${token.symbol}`, async () => {
      const value = await DF.getTokenValue(token);
      expect(value).toBeGreaterThanOrEqual(expectedMin);
      expect(value).toBeLessThanOrEqual(expectedMax);
      console.log(`${token.symbol} value: $${value}`);
    });
  });
});
