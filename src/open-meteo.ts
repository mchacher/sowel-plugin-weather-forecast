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

/**
 * Hourly variables for the irradiance series (spec 160).
 *
 * `direct_radiation` and `diffuse_radiation` separately, never the combined
 * `shortwave_radiation`: the split is what lets a consumer project the beam onto
 * a tilted plane. AROME HD carries none of the three, which is one more reason
 * the 2.5 km variant is the one in the candidate list.
 */
export const HOURLY_VARIABLES = [
  "direct_radiation",
  "diffuse_radiation",
  "temperature_2m",
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

export interface HourlyPoint {
  /**
   * UTC instant, with an explicit `Z`.
   *
   * Open-Meteo answers `timezone=auto` with **offset-less local** timestamps
   * like `2026-08-25T00:00`, and reports the offset separately. Passing those
   * through would leave the consumer to parse them, and ECMAScript parses an
   * offset-less date-time in the *reader's* timezone — so a Sowel container
   * running UTC would shift a French household's whole curve by two hours and
   * pair each production sample with the irradiance of a different hour. The
   * offset is applied here, once, at the boundary that knows it.
   */
  t: string;
  /** Direct radiation on the HORIZONTAL plane, W/m2. Not normal to the sun. */
  direct: number | null;
  /** Diffuse radiation, W/m2. */
  diffuse: number | null;
  /** Air temperature, °C. */
  temp: number | null;
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

export function buildHourlyUrl(
  latitude: string,
  longitude: string,
  model: string,
  forecastDays: number,
): string {
  const params = new URLSearchParams({
    latitude,
    longitude,
    hourly: HOURLY_VARIABLES.join(","),
    timezone: "auto",
    forecast_days: String(forecastDays),
  });
  if (model) params.set("models", model);
  return `${DAILY_BASE_URL}?${params.toString()}`;
}

/**
 * The same hourly variables, over past days instead of future ones (spec 161).
 *
 * `past_days` on the forecast endpoint, deliberately, rather than the archive
 * endpoint: the archive serves a reanalysis, while this returns what the same
 * forecast model itself said. A PV model fitted on reanalysis would be fitted on
 * an input distribution it never sees in operation.
 *
 * `forecast_days=1` because zero is refused; the extra day is harmless, the
 * consumer bounds its own window.
 */
export function buildHistoryUrl(
  latitude: string,
  longitude: string,
  model: string,
  pastDays: number,
): string {
  const params = new URLSearchParams({
    latitude,
    longitude,
    hourly: HOURLY_VARIABLES.join(","),
    timezone: "auto",
    past_days: String(pastDays),
    forecast_days: "1",
  });
  if (model) params.set("models", model);
  return `${DAILY_BASE_URL}?${params.toString()}`;
}

/**
 * Keep only hours the sun was up.
 *
 * 45 days of every hour is about 2 200 points; the ones with no irradiance at
 * all teach a PV model nothing and are two thirds of the payload.
 */
export function daylightOnly(hours: readonly HourlyPoint[]): HourlyPoint[] {
  return hours.filter((h) => (h.direct ?? 0) > 0 || (h.diffuse ?? 0) > 0);
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

/**
 * Flatten the hourly block into one point per hour.
 *
 * Single-model on purpose: a consumer projecting the beam onto a plane needs one
 * coherent series, not a choice to make at every hour. Spec 160 measured that
 * the irradiance forecast is not the bottleneck anyway — feeding the production
 * model the analysis instead of the 24 h forecast barely moved its error.
 */
export function parseHourly(json: unknown): HourlyPoint[] {
  const root = asRecord(json, "the response");
  assertNoApiError(root);

  if (root.hourly === undefined) {
    throw new OpenMeteoResponseError("Response carries no hourly block");
  }
  const offsetSeconds =
    typeof root.utc_offset_seconds === "number" && Number.isFinite(root.utc_offset_seconds)
      ? root.utc_offset_seconds
      : 0;
  const hourly = asRecord(root.hourly, "the hourly block");
  const time = Array.isArray(hourly.time) ? hourly.time.map(String) : null;
  if (!time) throw new OpenMeteoResponseError("Hourly block carries no time axis");

  const pick = (variable: string): (number | null)[] => {
    const key = Object.keys(hourly).find((k) => k === variable || k.startsWith(`${variable}_`));
    return (key ? toSeries(hourly[key]) : null) ?? [];
  };
  const direct = pick("direct_radiation");
  const diffuse = pick("diffuse_radiation");
  const temp = pick("temperature_2m");

  return time.map((local, i) => ({
    t: toUtcIso(local, offsetSeconds),
    direct: direct[i] ?? null,
    diffuse: diffuse[i] ?? null,
    temp: temp[i] ?? null,
  }));
}

/**
 * An offset-less local timestamp plus the response's offset, as a UTC instant.
 *
 * `Date.parse` on a bare `2026-08-25T00:00` is timezone-dependent by
 * specification, so the string is read as UTC and the offset subtracted
 * explicitly rather than left to whatever zone the reader happens to run in.
 */
function toUtcIso(localIso: string, offsetSeconds: number): string {
  const asUtc = Date.parse(`${localIso}Z`);
  if (!Number.isFinite(asUtc)) return localIso;
  return new Date(asUtc - offsetSeconds * 1000).toISOString();
}
