/**
 * Candidate models and per-day value resolution (spec 159, FR1 and FR2).
 *
 * No geography is encoded here. The superset below is sent on every request and
 * Open-Meteo simply omits the models that do not cover the coordinates, so a
 * French household ends up on AROME, a German one on ICON-D2 and an American one
 * on HRRR without a line of configuration. Every id was verified against the
 * live API: an unknown id makes Open-Meteo reject the *whole* request, so this
 * list must never be extended from memory.
 */

/**
 * Grid resolution in km, used to rank models at short range.
 *
 * The figure is the resolution a model is *guaranteed* to have wherever it
 * answers, which is not always its headline number. A domain-limited model such
 * as AROME or ICON-D2 is simply absent from the response outside its area, so
 * its nominal resolution is honest. A `_seamless` product answers everywhere and
 * silently falls back to a global model outside its region, so it is ranked at
 * that global fallback instead: ranking `metno_seamless` at its Nordic 1 km made
 * it outrank AROME over France, where it is really ECMWF.
 */
export const MODEL_RESOLUTION_KM: Record<string, number> = {
  knmi_harmonie_arome_netherlands: 2,
  italia_meteo_arpae_icon_2i: 2,
  dmi_harmonie_arome_europe: 2,
  icon_d2: 2.2,
  meteofrance_arome_france: 2.5,
  ncep_hrrr_conus: 3,
  icon_eu: 7,
  ukmo_global_deterministic_10km: 10,
  meteofrance_arpege_europe: 11,
  // Seamless products: ranked at their global fallback, not their best region.
  gfs_seamless: 25,
  metno_seamless: 25,
  ecmwf_ifs025: 25,
};

/** Sent on every deterministic request; whatever answers covers the point. */
export const CANDIDATE_MODELS: readonly string[] = Object.keys(MODEL_RESOLUTION_KM);

/** The single global ensemble used for probabilities and spread, worldwide. */
export const ENSEMBLE_MODEL = "ecmwf_ifs025";

/** Beyond this horizon, every available model enters the median. */
export const MEDIAN_FROM_DAY = 2;

/**
 * At J+1 only the models within this factor of the finest available grid take
 * part. Electing the single finest would be arbitrary where several are
 * comparable: over one point three models sit at 2, 2 and 2.5 km, and nothing
 * says the 2 km one is better there. A median over that class is robust; a 7 km
 * model has no business in it.
 */
export const FINE_CLASS_FACTOR = 1.5;

export interface ResolvedValue {
  value: number | null;
  /** Model id, `median(<n>)`, or `none`. Feeds the `model_used` data point. */
  source: string;
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Coarse rank for an unknown model id: worse than anything we know about. */
function resolutionOf(model: string): number {
  return MODEL_RESOLUTION_KM[model] ?? Number.POSITIVE_INFINITY;
}

/** Declaration index, used only to break a resolution tie deterministically. */
const DECLARATION_ORDER = new Map(CANDIDATE_MODELS.map((m, i) => [m, i]));

/**
 * Pick the finest grid, breaking a tie by declaration order.
 *
 * The tie-break has to come from us, not from the response: the candidates
 * arrive in whatever order Open-Meteo emitted its keys, so relying on iteration
 * order would let `j1_condition` flip between two equally fine models from one
 * poll to the next and re-trigger every bound recipe on ordering noise alone.
 */
/** The models within {@link FINE_CLASS_FACTOR} of the finest grid available. */
function fineClass(available: [string, number][]): [string, number][] {
  const finestResolution = Math.min(...available.map(([model]) => resolutionOf(model)));
  if (!Number.isFinite(finestResolution)) return available;
  return available.filter(
    ([model]) => resolutionOf(model) <= finestResolution * FINE_CLASS_FACTOR,
  );
}

function finest(available: [string, number][]): [string, number] {
  let best = available[0];
  for (const candidate of available) {
    const dr = resolutionOf(candidate[0]) - resolutionOf(best[0]);
    if (dr < 0) {
      best = candidate;
      continue;
    }
    if (dr === 0) {
      const ci = DECLARATION_ORDER.get(candidate[0]) ?? Number.MAX_SAFE_INTEGER;
      const bi = DECLARATION_ORDER.get(best[0]) ?? Number.MAX_SAFE_INTEGER;
      if (ci < bi) best = candidate;
    }
  }
  return best;
}

/**
 * Resolve one variable, one day, across the models that carry it.
 *
 * At J+1 the finest grid wins outright: over its own domain a 2.5 km model is
 * not in the same class as a 25 km one. From J+2 no model has a clear edge, and
 * a median absorbs an outlier where a single pick would follow it (measured:
 * ARPEGE 34.1 C against ICON-EU 29.5 C on the same J+3, median 33.1 C).
 *
 * Models returning null for that day, because their horizon ended or they do not
 * carry the variable, simply drop out of the set.
 */
export function resolveDay(
  values: Record<string, number | null>,
  horizonDays: number,
): ResolvedValue {
  const available = Object.entries(values)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number");

  if (available.length === 0) return { value: null, source: "none" };
  if (available.length === 1) {
    const [model, value] = available[0];
    return { value, source: model };
  }

  // Resolution is only a cold-start proxy for skill; ranking by measured error
  // against a local sensor is a later spec.
  const peers = horizonDays < MEDIAN_FROM_DAY ? fineClass(available) : available;

  if (peers.length === 1) {
    const [model, value] = peers[0];
    return { value, source: model };
  }

  return {
    value: median(peers.map(([, value]) => value)),
    source: `median(${peers.length})`,
  };
}

/**
 * Same resolution for a categorical variable: no median is meaningful on a WMO
 * code, so the finest available grid wins at every horizon.
 */
export function resolveCategoricalDay(values: Record<string, number | null>): ResolvedValue {
  const available = Object.entries(values)
    .filter((entry): entry is [string, number] => typeof entry[1] === "number");
  if (available.length === 0) return { value: null, source: "none" };
  const best = finest(available);
  return { value: best[1], source: best[0] };
}
