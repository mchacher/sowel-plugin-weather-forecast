import { describe, expect, it } from "vitest";
import { MIN_MEMBERS, quantiles, rainProbability } from "./ensemble.js";

/** n members, the first `wet` of them above the rain threshold. */
function members(n: number, wet: number): number[] {
  return Array.from({ length: n }, (_, i) => (i < wet ? 2.0 : 0.0));
}

describe("rainProbability", () => {
  it("counts the share of members above the threshold", () => {
    expect(rainProbability(members(40, 30))).toBe(75);
  });

  it("returns 0 when every member is dry", () => {
    expect(rainProbability(members(40, 0))).toBe(0);
  });

  it("returns 100 when every member is wet", () => {
    expect(rainProbability(members(40, 40))).toBe(100);
  });

  it("ignores nulls and computes over the rest", () => {
    const withNulls = [...members(20, 10), null, null, null];
    expect(rainProbability(withNulls)).toBe(50);
  });

  it("counts a member exactly at the threshold as wet", () => {
    expect(rainProbability(Array.from({ length: 20 }, () => 0.5))).toBe(100);
  });

  it("honours a custom threshold", () => {
    const values = Array.from({ length: 20 }, (_, i) => i * 0.1); // 0.0 .. 1.9
    expect(rainProbability(values, 1.0)).toBe(50);
  });

  it("refuses to produce a figure below the minimum member count", () => {
    expect(rainProbability(members(MIN_MEMBERS - 1, 5))).toBeNull();
  });

  it("returns null on an empty or all-null series", () => {
    expect(rainProbability([])).toBeNull();
    expect(rainProbability([null, null])).toBeNull();
  });
});

describe("quantiles", () => {
  it("computes nearest-rank quantiles", () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1); // 1..20
    expect(quantiles(values)).toEqual({ p10: 2, p50: 10, p90: 18 });
  });

  it("keeps p10 <= p50 <= p90 on an unsorted input", () => {
    const q = quantiles([5, 1, 9, 3, 7, 2, 8, 4, 6, 10]);
    expect(q).not.toBeNull();
    expect(q!.p10).toBeLessThanOrEqual(q!.p50);
    expect(q!.p50).toBeLessThanOrEqual(q!.p90);
  });

  it("returns the constant value when every member agrees", () => {
    expect(quantiles(Array.from({ length: 15 }, () => 21.5))).toEqual({
      p10: 21.5,
      p50: 21.5,
      p90: 21.5,
    });
  });

  it("ignores nulls", () => {
    const q = quantiles([...Array.from({ length: 12 }, (_, i) => i), null, null]);
    expect(q).not.toBeNull();
  });

  it("returns null below the minimum member count", () => {
    expect(quantiles(Array.from({ length: MIN_MEMBERS - 1 }, (_, i) => i))).toBeNull();
  });

  it("returns null on an empty series", () => {
    expect(quantiles([])).toBeNull();
  });
});
