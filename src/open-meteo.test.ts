import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  IMPLICIT_MODEL,
  OpenMeteoResponseError,
  buildDailyUrl,
  buildEnsembleUrl,
  parseDaily,
  parseEnsembleDaily,
  parseJsonLenient,
} from "./open-meteo.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), "utf8");
}

describe("buildDailyUrl", () => {
  it("lists every requested model and the fixed daily variables", () => {
    const url = new URL(buildDailyUrl("45.17", "5.80", ["icon_eu", "gfs_seamless"], 6));
    expect(url.searchParams.get("models")).toBe("icon_eu,gfs_seamless");
    expect(url.searchParams.get("timezone")).toBe("auto");
    expect(url.searchParams.get("forecast_days")).toBe("6");
    expect(url.searchParams.get("daily")).toContain("temperature_2m_max");
    expect(url.searchParams.get("latitude")).toBe("45.17");
  });

  it("omits the models parameter entirely when the list is empty", () => {
    const url = new URL(buildDailyUrl("45.17", "5.80", [], 6));
    expect(url.searchParams.has("models")).toBe(false);
  });
});

describe("buildEnsembleUrl", () => {
  it("targets the ensemble host with a single model", () => {
    const url = new URL(buildEnsembleUrl("45.17", "5.80", "ecmwf_ifs025", 6));
    expect(url.host).toBe("ensemble-api.open-meteo.com");
    expect(url.searchParams.get("models")).toBe("ecmwf_ifs025");
    expect(url.searchParams.get("daily")).toBe("temperature_2m_max,precipitation_sum");
  });
});

describe("parseJsonLenient", () => {
  it("parses ordinary JSON unchanged", () => {
    expect(parseJsonLenient('{"a":1}')).toEqual({ a: 1 });
  });

  it("repairs the bare nan literal Open-Meteo emits for out-of-domain requests", () => {
    expect(parseJsonLenient('{"latitude":nan,"b":2}')).toEqual({ latitude: null, b: 2 });
  });

  it("leaves a nan inside a string alone", () => {
    expect(parseJsonLenient('{"timezone":"nanjing"}')).toEqual({ timezone: "nanjing" });
  });

  it("throws a typed error on genuinely broken JSON", () => {
    expect(() => parseJsonLenient("{oops")).toThrow(OpenMeteoResponseError);
  });
});

describe("parseDaily", () => {
  it("demultiplexes suffixed keys into model -> variable -> series", () => {
    const parsed = parseDaily(parseJsonLenient(fixture("daily-france.json")));
    expect(parsed.time).toHaveLength(6);
    expect(Object.keys(parsed.byModel).length).toBeGreaterThan(5);
    const arome = parsed.byModel.meteofrance_arome_france;
    expect(arome).toBeDefined();
    expect(arome.temperature_2m_max).toHaveLength(6);
    expect(typeof arome.temperature_2m_max[0]).toBe("number");
  });

  it("keeps only the models that cover the point, out-of-domain ones being absent", () => {
    const parsed = parseDaily(parseJsonLenient(fixture("daily-newyork.json")));
    // The same request that returns AROME in France returns HRRR in New York.
    expect(parsed.byModel.ncep_hrrr_conus).toBeDefined();
    expect(parsed.byModel.meteofrance_arome_france).toBeUndefined();
    expect(parsed.byModel.icon_d2).toBeUndefined();
  });

  it("parses the New York payload despite its bare nan latitude", () => {
    expect(() => parseDaily(parseJsonLenient(fixture("daily-newyork.json")))).not.toThrow();
  });

  it("attributes unsuffixed keys to the implicit model", () => {
    const parsed = parseDaily({
      daily: { time: ["2026-08-24"], temperature_2m_max: [30.5], weather_code: [1] },
    });
    expect(parsed.byModel[IMPLICIT_MODEL].temperature_2m_max).toEqual([30.5]);
    expect(parsed.byModel[IMPLICIT_MODEL].weather_code).toEqual([1]);
  });

  it("maps nulls through instead of dropping the day", () => {
    const parsed = parseDaily({
      daily: { time: ["a", "b"], temperature_2m_max_icon_eu: [30.5, null] },
    });
    expect(parsed.byModel.icon_eu.temperature_2m_max).toEqual([30.5, null]);
  });

  it("throws a typed error when no model covers the point", () => {
    expect(() => parseDaily({ latitude: null, timezone: "America/New_York" })).toThrow(
      OpenMeteoResponseError,
    );
  });

  it("surfaces an API-level error with its reason", () => {
    expect(() => parseDaily({ error: true, reason: "invalid String value nope" })).toThrow(
      /invalid String value nope/,
    );
  });

  it("rejects a non-object payload", () => {
    expect(() => parseDaily("nope")).toThrow(OpenMeteoResponseError);
  });
});

describe("parseEnsembleDaily", () => {
  it("collects every member per day", () => {
    const parsed = parseEnsembleDaily(parseJsonLenient(fixture("ensemble.json")));
    expect(parsed.time).toHaveLength(6);
    const day0 = parsed.members.temperature_2m_max[0];
    // 50 numbered members plus the control run.
    expect(day0.length).toBeGreaterThanOrEqual(50);
    expect(parsed.members.precipitation_sum[0].length).toBe(day0.length);
  });

  it("returns one bucket per day even when a member series is short", () => {
    const parsed = parseEnsembleDaily({
      daily: {
        time: ["a", "b"],
        temperature_2m_max: [1, 2],
        temperature_2m_max_member01: [3],
        precipitation_sum: [0, 0],
      },
    });
    expect(parsed.members.temperature_2m_max[0]).toEqual([1, 3]);
    expect(parsed.members.temperature_2m_max[1]).toEqual([2]);
  });

  it("throws a typed error on a payload with no daily block", () => {
    expect(() => parseEnsembleDaily({ latitude: 45 })).toThrow(OpenMeteoResponseError);
  });
});
