/**
 * Statistics over ensemble members (spec 159, FR4 and FR5).
 *
 * The point of the ensemble is that it answers two questions no deterministic
 * run can: how likely is rain, and how much do equally plausible realisations of
 * tomorrow disagree.
 */

/** Precipitation above which a member counts as a rainy day. */
export const RAIN_THRESHOLD_MM = 0.5;

/**
 * Below this many usable members, no figure is produced. Ten members is already
 * a coarse probability (steps of 10 points); fewer would be a number pretending
 * to be a probability.
 */
export const MIN_MEMBERS = 10;

export interface Quantiles {
  p10: number;
  p50: number;
  p90: number;
}

function usable(members: readonly (number | null)[]): number[] {
  return members.filter((m): m is number => typeof m === "number" && Number.isFinite(m));
}

/**
 * Share of members whose precipitation reaches the threshold, as a percentage.
 *
 * This is a genuine frequency over realisations, which is what
 * `precipitation_probability_max` is not, and it is available for every model
 * whereas that variable is null on every Meteo-France one.
 */
export function rainProbability(
  members: readonly (number | null)[],
  thresholdMm: number = RAIN_THRESHOLD_MM,
): number | null {
  const values = usable(members);
  if (values.length < MIN_MEMBERS) return null;
  const wet = values.filter((mm) => mm >= thresholdMm).length;
  return Math.round((100 * wet) / values.length);
}

/**
 * Nearest-rank quantiles; no interpolation, so the result is always a member
 * value. `minCount` lets a caller with a small but legitimate sample (a handful
 * of deterministic models rather than an ensemble) opt out of the member floor.
 */
export function quantiles(
  members: readonly (number | null)[],
  minCount: number = MIN_MEMBERS,
): Quantiles | null {
  const values = usable(members).sort((a, b) => a - b);
  if (values.length < minCount) return null;
  const at = (q: number): number =>
    values[Math.min(values.length - 1, Math.max(0, Math.ceil(q * values.length) - 1))];
  return { p10: at(0.1), p50: at(0.5), p90: at(0.9) };
}
