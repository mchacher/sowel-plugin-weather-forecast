import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS } from "./confidence.js";
import { CANDIDATE_MODELS } from "./models.js";
import {
  DEFAULT_POLL_INTERVAL_MIN,
  MIN_POLL_INTERVAL_MIN,
  parseModelsSetting,
  parsePollingInterval,
  parseThresholds,
} from "./settings.js";

describe("parseModelsSetting", () => {
  it("gives the candidate superset when unset", () => {
    expect(parseModelsSetting(undefined).models).toBe(CANDIDATE_MODELS);
    expect(parseModelsSetting("").models).toBe(CANDIDATE_MODELS);
    expect(parseModelsSetting("  ").models).toBe(CANDIDATE_MODELS);
  });

  it("treats `auto` as the superset, case-insensitively", () => {
    expect(parseModelsSetting("AUTO").models).toBe(CANDIDATE_MODELS);
  });

  it("sends no models at all for best_match, which is the escape hatch", () => {
    expect(parseModelsSetting("best_match").models).toEqual([]);
    expect(parseModelsSetting(" best_match ").models).toEqual([]);
  });

  it("keeps an explicit list of known ids, whitespace tolerated", () => {
    const { models, unknown } = parseModelsSetting(" icon_eu , gfs_seamless ");
    expect(models).toEqual(["icon_eu", "gfs_seamless"]);
    expect(unknown).toEqual([]);
  });

  it("drops one unknown id and keeps the valid ones, naming what it dropped", () => {
    // The failing case: one typo must not take the whole request down, because
    // Open-Meteo rejects the entire call on a single unknown id.
    const { models, unknown } = parseModelsSetting("meteofrance_arome_france,arome");
    expect(models).toEqual(["meteofrance_arome_france"]);
    expect(unknown).toEqual(["arome"]);
  });

  it("falls back to the superset when every id is wrong, never to an empty list", () => {
    const { models, unknown } = parseModelsSetting("nope,also_nope");
    // An empty list would silently mean best_match, which is a different setting.
    expect(models).toBe(CANDIDATE_MODELS);
    expect(unknown).toEqual(["nope", "also_nope"]);
  });

  it("ignores empty entries from a trailing comma", () => {
    expect(parseModelsSetting("icon_eu,,").models).toEqual(["icon_eu"]);
  });
});

describe("parseThresholds", () => {
  it("uses the defaults when unset", () => {
    expect(parseThresholds(undefined, undefined)).toEqual(DEFAULT_THRESHOLDS);
  });

  it("reads valid numbers", () => {
    expect(parseThresholds("1.5", "4")).toEqual({ highMax: 1.5, mediumMax: 4 });
  });

  it("falls back per field on a non-numeric or non-positive value", () => {
    expect(parseThresholds("abc", "4")).toEqual({
      highMax: DEFAULT_THRESHOLDS.highMax,
      mediumMax: 4,
    });
    expect(parseThresholds("-1", "4")).toEqual({
      highMax: DEFAULT_THRESHOLDS.highMax,
      mediumMax: 4,
    });
    expect(parseThresholds("0", "4").highMax).toBe(DEFAULT_THRESHOLDS.highMax);
  });

  it("keeps `medium` reachable when the two are inverted", () => {
    expect(parseThresholds("5", "2")).toEqual({ highMax: 5, mediumMax: 5 });
  });
});

describe("parsePollingInterval", () => {
  it("defaults when unset or unparseable", () => {
    expect(parsePollingInterval(undefined)).toBe(DEFAULT_POLL_INTERVAL_MIN);
    expect(parsePollingInterval("abc")).toBe(DEFAULT_POLL_INTERVAL_MIN);
  });

  it("floors at the API-friendly minimum", () => {
    expect(parsePollingInterval("1")).toBe(MIN_POLL_INTERVAL_MIN);
    expect(parsePollingInterval("-5")).toBe(MIN_POLL_INTERVAL_MIN);
  });

  it("keeps a longer interval as asked", () => {
    expect(parsePollingInterval("60")).toBe(60);
  });
});
