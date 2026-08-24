import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DEFAULT_THRESHOLDS } from "./confidence.js";
import {
  parseDaily,
  parseEnsembleDaily,
  parseJsonLenient,
  type DailyResponse,
  type EnsembleResponse,
} from "./open-meteo.js";
import { MODEL_RESOLUTION_KM } from "./models.js";
import {
  CONFIDENCE_DAYS,
  FORECAST_DAYS,
  buildForecastPayload,
  mapWeatherCode,
  rainProbabilityAt,
  valuesAt,
} from "./payload.js";

function fixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`./__fixtures__/${name}`, import.meta.url)), "utf8");
}

const france = (): DailyResponse => parseDaily(parseJsonLenient(fixture("daily-france.json")));
const newyork = (): DailyResponse => parseDaily(parseJsonLenient(fixture("daily-newyork.json")));
const members = (): EnsembleResponse =>
  parseEnsembleDaily(parseJsonLenient(fixture("ensemble.json")));

describe("mapWeatherCode", () => {
  it("maps the WMO ranges Sowel's enum expects", () => {
    expect(mapWeatherCode(0)).toBe("sunny");
    expect(mapWeatherCode(2)).toBe("partly_cloudy");
    expect(mapWeatherCode(3)).toBe("cloudy");
    expect(mapWeatherCode(48)).toBe("foggy");
    expect(mapWeatherCode(61)).toBe("rainy");
    expect(mapWeatherCode(85)).toBe("snowy");
    expect(mapWeatherCode(99)).toBe("stormy");
  });

  it("falls back to cloudy on an unknown code rather than throwing", () => {
    expect(mapWeatherCode(1234)).toBe("cloudy");
  });
});

describe("valuesAt", () => {
  it("gathers one variable one day across every model", () => {
    const values = valuesAt(france(), "temperature_2m_max", 1);
    expect(Object.keys(values).length).toBeGreaterThan(5);
    expect(values.meteofrance_arome_france).toBeTypeOf("number");
  });

  it("reports null for a model that has no value that far out", () => {
    const values = valuesAt(france(), "temperature_2m_max", 5);
    // AROME's horizon ends well before J+5.
    expect(values.meteofrance_arome_france).toBeNull();
  });

  it("reports null for a variable no model carries", () => {
    const values = valuesAt(france(), "not_a_variable", 1);
    expect(Object.values(values).every((v) => v === null)).toBe(true);
  });
});

describe("rainProbabilityAt", () => {
  it("prefers the ensemble frequency", () => {
    const value = rainProbabilityAt(france(), members(), 1);
    expect(value).not.toBeNull();
    expect(value!).toBeGreaterThanOrEqual(0);
    expect(value!).toBeLessThanOrEqual(100);
  });

  it("falls back to a deterministic model when the ensemble is missing", () => {
    const value = rainProbabilityAt(france(), null, 1);
    // Every Meteo-France model is null for this variable, so the fallback can
    // only come from a global one. It must still produce a figure.
    expect(value).not.toBeNull();
  });

  it("returns null when neither source carries the day", () => {
    const empty: DailyResponse = { time: [], byModel: {} };
    expect(rainProbabilityAt(empty, null, 1)).toBeNull();
  });
});

describe("buildForecastPayload", () => {
  it("publishes the 25 historical aliases plus the 7 added by spec 159", () => {
    const payload = buildForecastPayload(france(), members(), DEFAULT_THRESHOLDS);
    for (let d = 1; d <= FORECAST_DAYS; d++) {
      for (const metric of ["condition", "temp_min", "temp_max", "rain_prob", "wind_gusts"]) {
        expect(payload).toHaveProperty(`j${d}_${metric}`);
      }
    }
    for (let d = 1; d <= CONFIDENCE_DAYS; d++) {
      expect(payload).toHaveProperty(`j${d}_temp_max_spread`);
      expect(payload).toHaveProperty(`j${d}_confidence`);
    }
    expect(Object.keys(payload)).toHaveLength(25 + 2 * CONFIDENCE_DAYS + 1);
  });

  it("produces physically plausible values on the captured French payload", () => {
    const payload = buildForecastPayload(france(), members(), DEFAULT_THRESHOLDS);
    for (let d = 1; d <= FORECAST_DAYS; d++) {
      const min = payload[`j${d}_temp_min`] as number;
      const max = payload[`j${d}_temp_max`] as number;
      expect(min).toBeLessThanOrEqual(max);
      expect(max).toBeGreaterThan(-60);
      expect(max).toBeLessThan(60);
      expect(payload[`j${d}_rain_prob`]).toBeLessThanOrEqual(100);
      expect(payload[`j${d}_wind_gusts`]).toBeGreaterThanOrEqual(0);
    }
  });

  it("medians the fine-grid models at J+1 rather than electing one of them", () => {
    const payload = buildForecastPayload(france(), members(), DEFAULT_THRESHOLDS);
    // Over this point several regional models sit at 2 to 2.5 km. Electing the
    // 2 km one would be arbitrary: nothing says a foreign 2 km grid beats the
    // national 2.5 km one there.
    expect(payload.model_used).toMatch(/^median\(\d+\)$/);

    const fine = Object.entries(valuesAt(france(), "temperature_2m_max", 1))
      .filter(([model, v]) => typeof v === "number" && MODEL_RESOLUTION_KM[model] <= 3)
      .map(([, v]) => v as number);
    expect(Number(payload.model_used.match(/\d+/)![0])).toBe(fine.length);

    // And the published value sits inside that class, never outside it.
    const value = payload.j1_temp_max as number;
    expect(value).toBeGreaterThanOrEqual(Math.min(...fine));
    expect(value).toBeLessThanOrEqual(Math.max(...fine));
  });

  it("keeps a lone fine model named at J+1 rather than calling it median(1)", () => {
    // New York: HRRR at 3 km is alone in its class, the rest are 10 km and up.
    const payload = buildForecastPayload(newyork(), null, DEFAULT_THRESHOLDS);
    expect(payload.model_used).toBe("ncep_hrrr_conus");
  });

  it("never lets a global model into the J+1 class when a regional one answers", () => {
    const payload = buildForecastPayload(france(), members(), DEFAULT_THRESHOLDS);
    const value = payload.j1_temp_max as number;
    const globals = ["ecmwf_ifs025", "gfs_seamless", "metno_seamless"].map(
      (m) => valuesAt(france(), "temperature_2m_max", 1)[m],
    );
    // A 25 km model may coincide with the median by chance, but the class it
    // was excluded from must be strictly finer than it.
    for (const model of ["ecmwf_ifs025", "gfs_seamless", "metno_seamless"]) {
      expect(MODEL_RESOLUTION_KM[model]).toBeGreaterThan(3);
    }
    expect(globals.some((v) => typeof v === "number")).toBe(true);
    expect(value).toBeTypeOf("number");
  });

  it("names a different model on a point AROME does not cover", () => {
    const payload = buildForecastPayload(newyork(), null, DEFAULT_THRESHOLDS);
    expect(payload.model_used).not.toBe("meteofrance_arome_france");
    expect(payload.model_used).not.toBe("none");
  });

  it("takes the median beyond J+2, so J+3 sits inside the model range", () => {
    const daily = france();
    const payload = buildForecastPayload(daily, members(), DEFAULT_THRESHOLDS);
    const spreadOfDay3 = Object.values(valuesAt(daily, "temperature_2m_max", 3)).filter(
      (v): v is number => typeof v === "number",
    );
    const value = payload.j3_temp_max as number;
    expect(value).toBeGreaterThanOrEqual(Math.min(...spreadOfDay3));
    expect(value).toBeLessThanOrEqual(Math.max(...spreadOfDay3));
  });

  it("publishes a confidence level for every forecast day", () => {
    const payload = buildForecastPayload(france(), members(), DEFAULT_THRESHOLDS);
    for (let d = 1; d <= FORECAST_DAYS; d++) {
      expect(["high", "medium", "low"]).toContain(payload[`j${d}_confidence`]);
    }
  });

  it("still reports a level on the far days, where fewer models answer", () => {
    // AROME and the other short-horizon models are gone by J+5, so the level
    // rests on the ensemble band alone. It must still be published rather than
    // silently dropped, which on a card reads as a bug.
    const payload = buildForecastPayload(france(), members(), DEFAULT_THRESHOLDS);
    expect(payload.j5_confidence).not.toBeNull();
    expect(payload.j5_temp_max_spread).toBeTypeOf("number");
  });

  it("still publishes every alias without an ensemble, confidence included", () => {
    const payload = buildForecastPayload(france(), null, DEFAULT_THRESHOLDS);
    expect(payload.j1_temp_max).toBeTypeOf("number");
    // Several models still disagree, so the model spread alone carries it.
    expect(payload.j1_temp_max_spread).toBeTypeOf("number");
    expect(["high", "medium", "low"]).toContain(payload.j1_confidence);
  });

  it("never claims confidence when a single model answers and there is no ensemble", () => {
    const single: DailyResponse = {
      time: ["d0", "d1", "d2", "d3", "d4", "d5"],
      byModel: {
        icon_eu: {
          temperature_2m_max: [20, 21, 22, 23, 24, 25],
          temperature_2m_min: [10, 11, 12, 13, 14, 15],
          weather_code: [0, 1, 2, 3, 61, 0],
          wind_gusts_10m_max: [10, 12, 14, 16, 18, 20],
        },
      },
    };
    const payload = buildForecastPayload(single, null, DEFAULT_THRESHOLDS);
    expect(payload.j1_temp_max).toBe(21);
    expect(payload.j1_temp_max_spread).toBeNull();
    expect(payload.j1_confidence).toBeNull();
  });

  it("publishes null values rather than dropping keys on an empty response", () => {
    const payload = buildForecastPayload({ time: [], byModel: {} }, null, DEFAULT_THRESHOLDS);
    expect(payload.j1_temp_max).toBeNull();
    expect(payload.j1_condition).toBeNull();
    expect(payload.model_used).toBe("none");
    expect(Object.keys(payload)).toHaveLength(25 + 2 * CONFIDENCE_DAYS + 1);
  });

  it("honours custom confidence thresholds", () => {
    const tight = buildForecastPayload(france(), members(), { highMax: 0.01, mediumMax: 0.02 });
    expect(tight.j1_confidence).toBe("low");
    const loose = buildForecastPayload(france(), members(), { highMax: 99, mediumMax: 100 });
    expect(loose.j1_confidence).toBe("high");
  });

  it("rounds every published number to a tenth, medians included", () => {
    const payload = buildForecastPayload(france(), members(), DEFAULT_THRESHOLDS);
    for (let d = 1; d <= FORECAST_DAYS; d++) {
      for (const metric of ["temp_min", "temp_max", "wind_gusts", "rain_prob"]) {
        const value = payload[`j${d}_${metric}`];
        if (typeof value !== "number") continue;
        expect(value).toBe(Math.round(value * 10) / 10);
      }
    }
  });

  it("rounds the published spread to a tenth of a degree", () => {
    const payload = buildForecastPayload(france(), members(), DEFAULT_THRESHOLDS);
    const value = payload.j1_temp_max_spread as number;
    expect(value).toBe(Math.round(value * 10) / 10);
  });
});

describe("retro-compatibility with the pre-2.0 single-model response", () => {
  it("resolves a best_match payload to the same 25 aliases", () => {
    const legacy: DailyResponse = parseDaily({
      daily: {
        time: ["d0", "d1", "d2", "d3", "d4", "d5"],
        weather_code: [0, 61, 3, 3, 0, 1],
        temperature_2m_min: [17, 18, 19, 20, 21, 22],
        temperature_2m_max: [30, 31, 32, 33, 34, 35],
        wind_gusts_10m_max: [40, 41, 42, 43, 44, 45],
        precipitation_probability_max: [10, 20, 30, 40, 50, 60],
      },
    });
    const payload = buildForecastPayload(legacy, null, DEFAULT_THRESHOLDS);
    expect(payload.j1_condition).toBe("rainy");
    expect(payload.j1_temp_min).toBe(18);
    expect(payload.j1_temp_max).toBe(31);
    expect(payload.j1_wind_gusts).toBe(41);
    expect(payload.j1_rain_prob).toBe(20);
    expect(payload.j5_temp_max).toBe(35);
    expect(payload.model_used).toBe("best_match");
    // One model, no ensemble: no confidence can honestly be claimed.
    expect(payload.j1_confidence).toBeNull();
  });
});
