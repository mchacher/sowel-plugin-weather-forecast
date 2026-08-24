import { describe, expect, it } from "vitest";
import {
  CANDIDATE_MODELS,
  MODEL_RESOLUTION_KM,
  median,
  resolveCategoricalDay,
  resolveDay,
} from "./models.js";

describe("median", () => {
  it("returns the middle value on an odd count", () => {
    expect(median([3, 1, 2])).toBe(2);
  });

  it("averages the two middle values on an even count", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
  });

  it("returns the value itself on a single sample", () => {
    expect(median([7.5])).toBe(7.5);
  });

  it("does not mutate its input", () => {
    const input = [3, 1, 2];
    median(input);
    expect(input).toEqual([3, 1, 2]);
  });
});

describe("resolveDay", () => {
  it("picks the finest grid at J+1", () => {
    const r = resolveDay(
      { meteofrance_arome_france: 30.5, icon_eu: 30.0, ecmwf_ifs025: 28.4 },
      1,
    );
    expect(r).toEqual({ value: 30.5, source: "meteofrance_arome_france" });
  });

  it("falls to the next finest grid when the best one has no value that day", () => {
    const r = resolveDay(
      { meteofrance_arome_france: null, icon_eu: 30.0, ecmwf_ifs025: 28.4 },
      1,
    );
    expect(r).toEqual({ value: 30.0, source: "icon_eu" });
  });

  it("takes the median from J+2 on", () => {
    const r = resolveDay(
      { meteofrance_arpege_europe: 32.4, icon_eu: 33.2, gfs_seamless: 31.4 },
      2,
    );
    expect(r).toEqual({ value: 32.4, source: "median(3)" });
  });

  it("absorbs an outlier at J+3 instead of following it", () => {
    // The measured case: ARPEGE and ICON-EU 4.6 C apart on the same day.
    const r = resolveDay(
      {
        meteofrance_arpege_europe: 34.1,
        icon_eu: 29.5,
        gfs_seamless: 33.2,
        ecmwf_ifs025: 33.1,
        ukmo_global_deterministic_10km: 32.2,
      },
      3,
    );
    expect(r.value).toBe(33.1);
    expect(r.source).toBe("median(5)");
    expect(r.value).not.toBe(34.1);
    expect(r.value).not.toBe(29.5);
  });

  it("reports the model rather than median(1) when only one model answers", () => {
    expect(resolveDay({ icon_eu: 21, gfs_seamless: null }, 3)).toEqual({
      value: 21,
      source: "icon_eu",
    });
  });

  it("returns none when every model is null", () => {
    expect(resolveDay({ icon_eu: null, gfs_seamless: null }, 1)).toEqual({
      value: null,
      source: "none",
    });
  });

  it("returns none on an empty set", () => {
    expect(resolveDay({}, 1)).toEqual({ value: null, source: "none" });
  });

  it("ranks an unknown model id last rather than crashing", () => {
    const r = resolveDay({ some_new_model: 20, icon_eu: 25 }, 1);
    expect(r).toEqual({ value: 25, source: "icon_eu" });
  });
});

describe("resolveCategoricalDay", () => {
  it("never averages a WMO code, even beyond J+2", () => {
    const r = resolveCategoricalDay({ meteofrance_arome_france: 61, icon_eu: 3 });
    expect(r).toEqual({ value: 61, source: "meteofrance_arome_france" });
  });

  it("returns none when nothing carries the code", () => {
    expect(resolveCategoricalDay({ meteofrance_arome_france_hd: null })).toEqual({
      value: null,
      source: "none",
    });
  });
});

describe("CANDIDATE_MODELS", () => {
  it("carries a resolution for every candidate", () => {
    for (const model of CANDIDATE_MODELS) {
      expect(MODEL_RESOLUTION_KM[model]).toBeGreaterThan(0);
    }
  });

  it("includes at least one global model so every point is covered", () => {
    expect(CANDIDATE_MODELS).toContain("ecmwf_ifs025");
    expect(CANDIDATE_MODELS).toContain("gfs_seamless");
  });

  it("uses the 2.5 km AROME variant, never the HD one which carries no weather_code", () => {
    expect(CANDIDATE_MODELS).toContain("meteofrance_arome_france");
    expect(CANDIDATE_MODELS).not.toContain("meteofrance_arome_france_hd");
  });
});
