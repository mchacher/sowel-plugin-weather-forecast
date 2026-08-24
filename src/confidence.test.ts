import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS, level, spread } from "./confidence.js";

describe("spread", () => {
  it("takes the ensemble band when it is the wider of the two", () => {
    // Measured J+1: models 2.1 C apart, ensemble p10-p90 2.6 C.
    expect(spread([30.5, 28.8, 30.0, 28.4], { p10: 28.5, p50: 29.8, p90: 31.1 })).toBeCloseTo(
      2.6,
      5,
    );
  });

  it("takes the model range when it is the wider of the two", () => {
    expect(spread([34.1, 29.5], { p10: 32.0, p50: 33.0, p90: 33.5 })).toBeCloseTo(4.6, 5);
  });

  it("reproduces the measured J+3 case where the ensemble is far wider", () => {
    const s = spread([34.1, 29.5, 33.2, 33.1, 32.2], { p10: 26.1, p50: 29.7, p90: 34.2 });
    expect(s).toBeCloseTo(8.1, 5);
  });

  it("falls back to the model range with no ensemble", () => {
    expect(spread([30.5, 28.4], null)).toBeCloseTo(2.1, 5);
  });

  it("falls back to the ensemble band with a single model", () => {
    expect(spread([30.5], { p10: 29, p50: 30, p90: 32 })).toBe(3);
  });

  it("returns null with a single model and no ensemble", () => {
    expect(spread([30.5], null)).toBeNull();
  });

  it("returns null with nothing at all", () => {
    expect(spread([], null)).toBeNull();
  });

  it("reads a large model set as a p10-p90 band, not a min-max range", () => {
    // Ten models clustered around 30 with one outlier at 40. Min-max would
    // report 10 C of disagreement on the strength of a single member.
    const values = [29, 29.5, 30, 30, 30.2, 30.5, 30.5, 31, 31.5, 40];
    const s = spread(values, null);
    expect(s).not.toBeNull();
    expect(s!).toBeLessThan(3);
  });

  it("does not inflate the spread just because more models answered", () => {
    // Same underlying uncertainty, sampled by 5 models then by 10. A min-max
    // range would grow with the count; the band must not.
    const five = [29, 30, 30.5, 31, 31.5];
    const ten = [29, 29.5, 30, 30, 30.2, 30.5, 30.5, 31, 31.2, 31.5];
    const a = spread(five, null)!;
    const b = spread(ten, null)!;
    expect(Math.abs(a - b)).toBeLessThan(1);
  });

  it("keeps the plain range below the robust threshold, where a band is meaningless", () => {
    expect(spread([28, 32], null)).toBe(4);
  });

  it("returns 0 when every model agrees exactly", () => {
    expect(spread([30, 30, 30], null)).toBe(0);
  });
});

describe("level", () => {
  it("classifies a tight spread as high", () => {
    expect(level(0.8)).toBe("high");
  });

  it("classifies a moderate spread as medium", () => {
    expect(level(3.0)).toBe("medium");
  });

  it("classifies a wide spread as low", () => {
    expect(level(6.0)).toBe("low");
  });

  it("treats a threshold value as belonging to the tighter class", () => {
    expect(level(DEFAULT_THRESHOLDS.highMax)).toBe("high");
    expect(level(DEFAULT_THRESHOLDS.mediumMax)).toBe("medium");
  });

  it("returns null on a null spread rather than defaulting to high", () => {
    expect(level(null)).toBeNull();
  });

  it("returns null on a non-finite spread", () => {
    expect(level(Number.NaN)).toBeNull();
    expect(level(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("honours custom thresholds", () => {
    expect(level(1.5, { highMax: 1, mediumMax: 3 })).toBe("medium");
    expect(level(3.5, { highMax: 1, mediumMax: 3 })).toBe("low");
  });
});
