import { describe, it, expect } from "vitest";
import {
  computeSwapEvents,
  decodeComputeLiquidityEvents,
  decodeSwapEvents,
} from "../decoder";
import { swapEvents, withdrawEvents, depositEvents } from "./placeholder";

describe("event decoder", () => {
  it("should decode a simple swap", () => {
    const decoded = decodeSwapEvents(swapEvents);
    const { feesIn, amountIn, amountOut, startId, endId } =
      computeSwapEvents(decoded);

    expect(feesIn).toStrictEqual(283n * 3n);
    expect(amountIn).toStrictEqual(999717n * 3n + feesIn);
    expect(amountOut).toStrictEqual(199222843n * 3n);
    expect(startId).toStrictEqual(8391258);
    expect(endId).toStrictEqual(8391260);
  });
  it("should decode events for a simple add liquidity", () => {
    const decoded = decodeComputeLiquidityEvents(depositEvents);

    expect(decoded.amountX).toStrictEqual(917501n * 3n);
    expect(decoded.amountY).toStrictEqual(4561880455n * 3n);
    expect(decoded.upperBound).toStrictEqual(8391260);
    expect(decoded.lowerBound).toStrictEqual(8391258);
  });
  it("should decode events for a simple remove liquidity MAS", () => {
    const decoded = decodeComputeLiquidityEvents(withdrawEvents);

    expect(decoded.upperBound).toStrictEqual(8391259);
    expect(decoded.lowerBound).toStrictEqual(8391239);
  });
});
