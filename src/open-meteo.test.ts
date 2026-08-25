import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  HOURLY_VARIABLES,
  IMPLICIT_MODEL,
  OpenMeteoResponseError,
  buildDailyUrl,
  buildEnsembleUrl,
  buildHourlyUrl,
  parseDaily,
  parseEnsembleDaily,
  parseHourly,
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

describe("buildHourlyUrl", () => {
  it("asks for the three variables a plane projection needs", () => {
    const url = new URL(buildHourlyUrl("45.17", "5.80", "", 5));
    const hourly = url.searchParams.get("hourly");
    for (const v of HOURLY_VARIABLES) expect(hourly).toContain(v);
    expect(url.searchParams.get("forecast_days")).toBe("5");
  });

  it("never asks for the combined shortwave radiation", () => {
    // The direct/diffuse split is the whole point: a combined figure cannot be
    // projected onto a tilted plane.
    expect(buildHourlyUrl("45.17", "5.80", "", 5)).not.toContain("shortwave");
  });

  it("omits the models parameter when none is forced", () => {
    expect(new URL(buildHourlyUrl("45.17", "5.80", "", 5)).searchParams.has("models")).toBe(false);
  });

  it("passes a forced model through", () => {
    const url = new URL(buildHourlyUrl("45.17", "5.80", "icon_eu", 5));
    expect(url.searchParams.get("models")).toBe("icon_eu");
  });
});

describe("parseHourly", () => {
  it("emits UTC instants, not the offset-less local strings Open-Meteo returns", () => {
    // The fixture carries utc_offset_seconds 7200 and times like
    // "2026-08-25T00:00". Passed through, a reader in UTC would place them two
    // hours late and pair every production sample with the wrong hour.
    const hours = parseHourly(parseJsonLenient(fixture("irradiance.json")));
    for (const h of hours) expect(h.t.endsWith("Z")).toBe(true);
    expect(hours[0].t).toBe("2026-08-24T22:00:00.000Z");
  });

  it("applies the offset rather than assuming the reader's timezone", () => {
    const hours = parseHourly({
      utc_offset_seconds: 7200,
      hourly: { time: ["2026-08-25T12:00"], direct_radiation: [500] },
    });
    expect(hours[0].t).toBe("2026-08-25T10:00:00.000Z");
  });

  it("treats a missing offset as UTC rather than guessing", () => {
    const hours = parseHourly({
      hourly: { time: ["2026-08-25T12:00"], direct_radiation: [500] },
    });
    expect(hours[0].t).toBe("2026-08-25T12:00:00.000Z");
  });

  it("handles a negative offset", () => {
    const hours = parseHourly({
      utc_offset_seconds: -14400,
      hourly: { time: ["2026-08-25T12:00"], direct_radiation: [500] },
    });
    expect(hours[0].t).toBe("2026-08-25T16:00:00.000Z");
  });

  it("flattens the captured payload into one point per hour", () => {
    const hours = parseHourly(parseJsonLenient(fixture("irradiance.json")));
    expect(hours).toHaveLength(120);
    for (const h of hours) {
      expect(typeof h.t).toBe("string");
      expect(typeof h.direct).toBe("number");
      expect(typeof h.diffuse).toBe("number");
      expect(typeof h.temp).toBe("number");
    }
  });

  it("keeps the hours in order and spanning five days", () => {
    const hours = parseHourly(parseJsonLenient(fixture("irradiance.json")));
    const days = new Set(hours.map((h) => h.t.slice(0, 10)));
    expect(days.size).toBeGreaterThanOrEqual(5);
    expect(hours[0].t < hours[hours.length - 1].t).toBe(true);
  });

  it("reads radiation as zero at night rather than as missing", () => {
    const hours = parseHourly(parseJsonLenient(fixture("irradiance.json")));
    const night = hours.find((h) => h.t.endsWith("T00:00:00.000Z"));
    expect(night?.direct).toBe(0);
    expect(night?.diffuse).toBe(0);
  });

  it("accepts a model-suffixed response", () => {
    const hours = parseHourly({
      hourly: {
        time: ["2026-08-25T00:00"],
        direct_radiation_icon_eu: [12],
        diffuse_radiation_icon_eu: [34],
        temperature_2m_icon_eu: [18],
      },
    });
    expect(hours[0]).toEqual({
      t: "2026-08-25T00:00:00.000Z",
      direct: 12,
      diffuse: 34,
      temp: 18,
    });
  });

  it("nulls a variable the response does not carry rather than throwing", () => {
    const hours = parseHourly({ hourly: { time: ["a"], direct_radiation: [5] } });
    expect(hours[0]).toEqual({ t: "a", direct: 5, diffuse: null, temp: null });
    // An unparseable stamp is passed through rather than turned into an epoch.
  });

  it("throws a typed error with no hourly block", () => {
    expect(() => parseHourly({ latitude: 45 })).toThrow(OpenMeteoResponseError);
  });
});
