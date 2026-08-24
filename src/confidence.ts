/**
 * Forecast confidence (spec 159, FR5).
 *
 * Two things can be wrong in a forecast and they are measured differently:
 * the physics, read from the disagreement between deterministic models, and the
 * initial conditions, read from the spread of the ensemble members. Measured
 * over five days at a reference point the two rank the days consistently but
 * disagree on magnitude by a factor of two in both directions, so neither can
 * stand in for the other.
 */

import { quantiles, type Quantiles } from "./ensemble.js";

/**
 * At or above this many deterministic models, the inter-model spread is read as
 * a p10-p90 band rather than a min-max range. Min-max grows with the number of
 * models, so a French household seeing ten models would systematically report
 * less confidence than an American one seeing five, for identical
 * meteorological uncertainty. The band is also the same statistic the ensemble
 * contributes, which is what makes the two comparable at all.
 */
export const ROBUST_SPREAD_MIN_MODELS = 5;

export type ConfidenceLevel = "high" | "medium" | "low";

export interface ConfidenceThresholds {
  /** Spread in °C at or below which confidence is `high`. */
  highMax: number;
  /** Spread in °C at or below which confidence is `medium`, above which `low`. */
  mediumMax: number;
}

export const DEFAULT_THRESHOLDS: ConfidenceThresholds = { highMax: 2, mediumMax: 5 };

/**
 * Disagreement between deterministic models: a p10-p90 band once there are
 * enough of them, the plain range below that. Returns null on fewer than two
 * models, since one model always agrees with itself.
 */
function modelRange(finite: readonly number[]): number | null {
  if (finite.length < 2) return null;
  if (finite.length >= ROBUST_SPREAD_MIN_MODELS) {
    const band = quantiles(finite, finite.length);
    if (band) return band.p90 - band.p10;
  }
  return Math.max(...finite) - Math.min(...finite);
}

/**
 * The wider of the inter-model range and the ensemble p10-p90 band.
 *
 * Taking the wider one is deliberate: claiming more confidence than the most
 * pessimistic available measure is the failure mode that actually hurts, since a
 * recipe acts on it.
 *
 * Returns null when there is nothing to measure, which is one deterministic
 * model and no ensemble. A single model agrees with itself; that is not
 * confidence.
 */
export function spread(
  modelValues: readonly number[],
  ensemble: Quantiles | null,
): number | null {
  const finite = modelValues.filter((v) => Number.isFinite(v));
  const modelSpread = modelRange(finite);
  const ensembleSpread = ensemble ? ensemble.p90 - ensemble.p10 : null;

  if (modelSpread === null && ensembleSpread === null) return null;
  return Math.max(modelSpread ?? 0, ensembleSpread ?? 0);
}

/**
 * Classify a spread. Returns null for a null spread rather than defaulting to
 * `high`: a missing signal must never read as a confident one.
 */
export function level(
  spreadC: number | null,
  thresholds: ConfidenceThresholds = DEFAULT_THRESHOLDS,
): ConfidenceLevel | null {
  if (spreadC === null || !Number.isFinite(spreadC)) return null;
  if (spreadC <= thresholds.highMax) return "high";
  if (spreadC <= thresholds.mediumMax) return "medium";
  return "low";
}
