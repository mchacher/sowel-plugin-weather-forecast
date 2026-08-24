/**
 * Assembly of the published device data from the two Open-Meteo responses.
 *
 * Pure on purpose: this is the heart of spec 159 and it must be verifiable
 * against captured payloads without touching the network.
 */

import { level, spread, type ConfidenceThresholds } from "./confidence.js";
import { quantiles, rainProbability } from "./ensemble.js";
import type { DailyResponse, EnsembleResponse } from "./open-meteo.js";
import { resolveCategoricalDay, resolveDay } from "./models.js";

/** Days published, J+1 to J+5. Index 0 of the API arrays is today. */
export const FORECAST_DAYS = 5;

/**
 * Confidence is published for the first three days only. Beyond J+3 the spread
 * is wide enough that the index would read `low` permanently, which carries no
 * information.
 */
export const CONFIDENCE_DAYS = 3;

export type WeatherCondition =
  | "sunny"
  | "partly_cloudy"
  | "cloudy"
  | "foggy"
  | "rainy"
  | "snowy"
  | "stormy";

/** WMO code to the enum Sowel's `weather_condition` category expects. */
export function mapWeatherCode(code: number): WeatherCondition {
  if (code === 0) return "sunny";
  if (code === 1 || code === 2) return "partly_cloudy";
  if (code === 3) return "cloudy";
  if (code === 45 || code === 48) return "foggy";
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return "rainy";
  if ((code >= 71 && code <= 77) || (code >= 85 && code <= 86)) return "snowy";
  if (code >= 95 && code <= 99) return "stormy";
  return "cloudy";
}

/**
 * Round to a tenth, the precision Open-Meteo itself publishes.
 *
 * A median over an even number of models produces values like
 * 56.150000000000006, which would reach the UI and InfluxDB as they are.
 */
function round1(value: number | null): number | null {
  return value === null ? null : Math.round(value * 10) / 10;
}

function roundInt(value: number | null): number | null {
  return value === null ? null : Math.round(value);
}

/** Both values or neither, smallest first. */
function orderedPair(a: number | null, b: number | null): [number | null, number | null] {
  if (a === null || b === null) return [a, b];
  return a <= b ? [a, b] : [b, a];
}

/** One variable, one day, gathered across every model that answered. */
export function valuesAt(
  daily: DailyResponse,
  variable: string,
  dayIndex: number,
): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const [model, variables] of Object.entries(daily.byModel)) {
    out[model] = variables[variable]?.[dayIndex] ?? null;
  }
  return out;
}

/**
 * A frequency over ensemble members, which is a genuine probability, falling
 * back to whichever deterministic model carries
 * `precipitation_probability_max`. Every Meteo-France model returns null for
 * that variable, so the fallback always resolves to a global model.
 */
export function rainProbabilityAt(
  daily: DailyResponse,
  ensemble: EnsembleResponse | null,
  dayIndex: number,
): number | null {
  if (ensemble) {
    const fromMembers = rainProbability(ensemble.members.precipitation_sum?.[dayIndex] ?? []);
    if (fromMembers !== null) return fromMembers;
  }
  return resolveDay(valuesAt(daily, "precipitation_probability_max", dayIndex), dayIndex).value;
}

export interface ForecastPayload extends Record<string, unknown> {
  model_used: string;
}

/** Resolve every published key from the models that answered, day by day. */
export function buildForecastPayload(
  daily: DailyResponse,
  ensemble: EnsembleResponse | null,
  thresholds: ConfidenceThresholds,
): ForecastPayload {
  const payload: Record<string, unknown> = {};
  let modelUsed = "none";

  for (let day = 1; day <= FORECAST_DAYS; day++) {
    const code = resolveCategoricalDay(valuesAt(daily, "weather_code", day));
    const tempMin = resolveDay(valuesAt(daily, "temperature_2m_min", day), day);
    const tempMax = resolveDay(valuesAt(daily, "temperature_2m_max", day), day);
    const gusts = resolveDay(valuesAt(daily, "wind_gusts_10m_max", day), day);

    // temp_min and temp_max are resolved independently, so on a day where the
    // two land on different models a min above the max is arithmetically
    // possible. Order them rather than publishing an impossible pair.
    const [low, high] = orderedPair(tempMin.value, tempMax.value);

    payload[`j${day}_condition`] = code.value === null ? null : mapWeatherCode(code.value);
    payload[`j${day}_temp_min`] = round1(low);
    payload[`j${day}_temp_max`] = round1(high);
    payload[`j${day}_wind_gusts`] = round1(gusts.value);
    // A probability is a whole percentage, as it was before 2.0: a median over
    // an even number of models would otherwise publish 2.5 %.
    payload[`j${day}_rain_prob`] = roundInt(rainProbabilityAt(daily, ensemble, day));

    // The J+1 temperature is what a household reads first, so it is the source
    // worth naming.
    if (day === 1) modelUsed = tempMax.source;

    if (day <= CONFIDENCE_DAYS) {
      const modelValues = Object.values(valuesAt(daily, "temperature_2m_max", day)).filter(
        (v): v is number => typeof v === "number",
      );
      const band = ensemble
        ? quantiles(ensemble.members.temperature_2m_max?.[day] ?? [])
        : null;
      const spreadC = spread(modelValues, band);
      payload[`j${day}_temp_max_spread`] = round1(spreadC);
      payload[`j${day}_confidence`] = level(spreadC, thresholds);
    }
  }

  payload.model_used = modelUsed;
  return payload as ForecastPayload;
}
