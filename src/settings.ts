/**
 * Settings parsing (spec 159, FR7).
 *
 * Pure so the degradation paths are testable: these are the branches the spec's
 * Edge Cases table is mostly about, and they are the ones a household reaches by
 * typing something slightly wrong into a form.
 */

import { DEFAULT_THRESHOLDS, type ConfidenceThresholds } from "./confidence.js";
import { CANDIDATE_MODELS, MODEL_RESOLUTION_KM } from "./models.js";
import { IMPLICIT_MODEL } from "./open-meteo.js";

export const MIN_POLL_INTERVAL_MIN = 15;
export const DEFAULT_POLL_INTERVAL_MIN = 30;

export interface ModelsSetting {
  /** Models to request. Empty means "send no `models` parameter", i.e. best_match. */
  models: readonly string[];
  /** Ids that were asked for but are not in the verified candidate list. */
  unknown: readonly string[];
}

/**
 * Empty or `auto` gives the candidate superset, `best_match` restores the
 * pre-2.0 behaviour, anything else is an explicit list.
 *
 * Unknown ids are dropped rather than sent: Open-Meteo rejects the *entire*
 * request when a single id is unknown, so passing a typo straight through would
 * silently drop the household back to best_match on every poll, forever.
 */
export function parseModelsSetting(raw: string | undefined): ModelsSetting {
  const value = (raw ?? "").trim();
  if (value === "" || value.toLowerCase() === "auto") {
    return { models: CANDIDATE_MODELS, unknown: [] };
  }

  const list = value
    .split(",")
    .map((m) => m.trim())
    .filter((m) => m.length > 0);

  if (list.length === 0) return { models: CANDIDATE_MODELS, unknown: [] };
  if (list.length === 1 && list[0] === IMPLICIT_MODEL) return { models: [], unknown: [] };

  const models = list.filter((m) => m in MODEL_RESOLUTION_KM);
  const unknown = list.filter((m) => !(m in MODEL_RESOLUTION_KM));
  // Every id was wrong: fall back to the superset rather than to nothing, which
  // would send an empty `models` list and silently mean best_match.
  return { models: models.length > 0 ? models : CANDIDATE_MODELS, unknown };
}

/**
 * Both thresholds, clamped so `medium` stays reachable: a medium threshold below
 * the high one would classify everything as `high` or `low` with nothing in
 * between.
 */
export function parseThresholds(
  highRaw: string | undefined,
  mediumRaw: string | undefined,
): ConfidenceThresholds {
  const read = (raw: string | undefined, fallback: number): number => {
    const parsed = parseFloat(raw ?? "");
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  };
  const highMax = read(highRaw, DEFAULT_THRESHOLDS.highMax);
  const mediumMax = read(mediumRaw, DEFAULT_THRESHOLDS.mediumMax);
  return { highMax, mediumMax: Math.max(highMax, mediumMax) };
}

/** Minutes, floored at the API-friendly minimum. */
export function parsePollingInterval(raw: string | undefined): number {
  const parsed = parseInt(raw ?? "", 10);
  return Math.max(
    MIN_POLL_INTERVAL_MIN,
    Number.isNaN(parsed) ? DEFAULT_POLL_INTERVAL_MIN : parsed,
  );
}
