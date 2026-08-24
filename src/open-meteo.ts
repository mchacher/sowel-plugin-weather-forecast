/**
 * Open-Meteo request building and response parsing.
 *
 * Kept free of `fetch` so every parser is testable against captured payloads.
 */

const DAILY_BASE_URL = "https://api.open-meteo.com/v1/forecast";
const ENSEMBLE_BASE_URL = "https://ensemble-api.open-meteo.com/v1/ensemble";

/** Daily variables requested from the deterministic endpoint. */
export const DAILY_VARIABLES = [
  "weather_code",
  "temperature_2m_min",
  "temperature_2m_max",
  "wind_gusts_10m_max",
  // Null on every Meteo-France model, so it is never the primary source for the
  // rain probability. Requested anyway as the fallback when the ensemble call
  // fails (spec 159 FR4).
  "precipitation_probability_max",
] as const;

/** Daily variables requested from the ensemble endpoint. */
export const ENSEMBLE_VARIABLES = ["temperature_2m_max", "precipitation_sum"] as const;

/** Model id reported when the response carries no model suffix (no `models` parameter). */
export const IMPLICIT_MODEL = "best_match";

export interface DailyResponse {
  /** ISO dates, index 0 is today. */
  time: string[];
  /** model id -> variable -> values aligned on `time`. */
  byModel: Record<string, Record<string, (number | null)[]>>;
}

export interface EnsembleResponse {
  time: string[];
  /** variable -> per-day array of member values. */
  members: Record<string, (number | null)[][]>;
}

/** Raised when Open-Meteo answers with something we cannot use. */
export class OpenMeteoResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenMeteoResponseError";
  }
}

export function buildDailyUrl(
  latitude: string,
  longitude: string,
  models: readonly string[],
  forecastDays: number,
): string {
  const params = new URLSearchParams({
    latitude,
    longitude,
    daily: DAILY_VARIABLES.join(","),
    timezone: "auto",
    forecast_days: String(forecastDays),
  });
  // An empty model list means "let Open-Meteo pick", i.e. the pre-2.0 behaviour.
  if (models.length > 0) params.set("models", models.join(","));
  return `${DAILY_BASE_URL}?${params.toString()}`;
}

export function buildEnsembleUrl(
  latitude: string,
  longitude: string,
  model: string,
  forecastDays: number,
): string {
  const params = new URLSearchParams({
    latitude,
    longitude,
    daily: ENSEMBLE_VARIABLES.join(","),
    models: model,
    timezone: "auto",
    forecast_days: String(forecastDays),
  });
  return `${ENSEMBLE_BASE_URL}?${params.toString()}`;
}

/**
 * Open-Meteo emits a bare `nan` literal for latitude/longitude when part of the
 * requested model set does not cover the point (verified on a New York request
 * carrying French regional models). `JSON.parse` rejects that, so the whole poll
 * would fail on a payload that is otherwise perfectly usable.
 *
 * Only a `nan` token sitting in a value position is rewritten, never one inside
 * a string.
 */
export function parseJsonLenient(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    const repaired = body.replace(/([:,[]\s*)nan(?=\s*[,\]}])/g, "$1null");
    try {
      return JSON.parse(repaired);
    } catch {
      throw new OpenMeteoResponseError("Response is not valid JSON");
    }
  }
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OpenMeteoResponseError(`Expected an object for ${what}`);
  }
  return value as Record<string, unknown>;
}

function assertNoApiError(root: Record<string, unknown>): void {
  if (root.error === true) {
    const reason = typeof root.reason === "string" ? root.reason : "unknown reason";
    throw new OpenMeteoResponseError(`Open-Meteo rejected the request: ${reason}`);
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function toSeries(value: unknown): (number | null)[] | null {
  return Array.isArray(value) ? value.map(numberOrNull) : null;
}

/**
 * Demultiplex `<variable>_<model_id>` keys back into `model -> variable -> values`.
 *
 * A key equal to a bare variable name (no `models` parameter was sent) is
 * attributed to {@link IMPLICIT_MODEL}.
 */
export function parseDaily(json: unknown): DailyResponse {
  const root = asRecord(json, "the response");
  assertNoApiError(root);

  // A payload with no `daily` block means not one requested model covers the
  // point. That is a hard failure for the caller, not a partial result.
  if (root.daily === undefined) {
    throw new OpenMeteoResponseError("Response carries no daily block");
  }
  const daily = asRecord(root.daily, "the daily block");
  const time = Array.isArray(daily.time) ? daily.time.map(String) : null;
  if (!time) throw new OpenMeteoResponseError("Daily block carries no time axis");

  const byModel: Record<string, Record<string, (number | null)[]>> = {};
  for (const [key, raw] of Object.entries(daily)) {
    if (key === "time") continue;
    const variable = DAILY_VARIABLES.find((v) => key === v || key.startsWith(`${v}_`));
    if (!variable) continue;
    const series = toSeries(raw);
    if (!series) continue;
    const model = key === variable ? IMPLICIT_MODEL : key.slice(variable.length + 1);
    (byModel[model] ??= {})[variable] = series;
  }

  return { time, byModel };
}

/**
 * Collect every member series per variable. The unsuffixed key is the control
 * run and is kept alongside the numbered members: it is one more equally valid
 * realisation for the quantiles we compute from them.
 */
export function parseEnsembleDaily(json: unknown): EnsembleResponse {
  const root = asRecord(json, "the response");
  assertNoApiError(root);

  if (root.daily === undefined) {
    throw new OpenMeteoResponseError("Ensemble response carries no daily block");
  }
  const daily = asRecord(root.daily, "the daily block");
  const time = Array.isArray(daily.time) ? daily.time.map(String) : null;
  if (!time) throw new OpenMeteoResponseError("Ensemble daily block carries no time axis");

  const members: Record<string, (number | null)[][]> = {};
  for (const variable of ENSEMBLE_VARIABLES) {
    const perDay: (number | null)[][] = time.map(() => []);
    for (const [key, raw] of Object.entries(daily)) {
      if (key !== variable && !key.startsWith(`${variable}_`)) continue;
      // `precipitation_sum` is not a prefix of another requested variable, and
      // `temperature_2m_max` only ever carries `_memberNN` suffixes here.
      const series = toSeries(raw);
      if (!series) continue;
      series.forEach((value, day) => {
        if (day < perDay.length) perDay[day].push(value);
      });
    }
    members[variable] = perDay;
  }

  return { time, members };
}
