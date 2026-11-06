/**
 * Deterministic portfolio risk meter (PHASE 03 §4): five factors, each 0–100, weighted to a
 * 0–100 score with a Low / Moderate / High label and up to 3 plain-English drivers.
 * No model is involved; the same inputs always give the same output.
 *
 * Factor            risk 0 when …                    risk 100 when …              weight
 * concentration     largest asset ≤ 40% of value     one asset is 100%            0.30
 * stablecoin        ≥ 50% in stablecoins             no stablecoins               0.20
 * lpOutOfRange      no LP out of range               ≥ 50% of value out of range  0.15
 * hookExposure      no Caution/Danger hook pools     ≥ 50% (Danger counts 2×)     0.15
 * drawdown          holdings at their 7-day high     ≥ 15% below (value-weighted) 0.20
 *
 * A factor whose data is unavailable (e.g. price history down) is left out and the remaining
 * weights are re-normalised, so the score stays on the same 0–100 scale.
 *
 * Floor: any exposure to a Danger hook makes the meter at least High (score ≥ 67) — the policy
 * engine refuses Danger hooks outright, so a weighted average must not dilute it.
 */
import { Decimal, type RiskFactor, type RiskLabel, type RiskMeter } from '@warden/shared';

export const RISK_WEIGHTS: Readonly<Record<RiskFactor, number>> = Object.freeze({
  concentration: 0.3,
  stablecoin: 0.2,
  lpOutOfRange: 0.15,
  hookExposure: 0.15,
  drawdown: 0.2,
});

export const RISK_LABEL_THRESHOLDS = Object.freeze({ moderateFrom: 34, highFrom: 67 });

export interface RiskHolding {
  symbol: string;
  valueUsd: Decimal;
  isStable: boolean;
  /** Percent below the 7-day high (0 = at the high); null = unknown. */
  drawdownPct: Decimal | null;
}

export interface RiskInput {
  holdings: readonly RiskHolding[];
  /** USD in LP positions that are out of range (PHASE 07; 0 until then). */
  lpOutOfRangeUsd?: Decimal;
  /** USD in pools whose hook is Caution / Danger (PHASE 07; 0 until then). */
  cautionHookUsd?: Decimal;
  dangerHookUsd?: Decimal;
}

function clamp01(x: Decimal): Decimal {
  return Decimal.max(0, Decimal.min(1, x));
}

function pct(x: Decimal): string {
  const v = x.times(100);
  return v.gte(10) ? v.toFixed(0) : v.toDecimalPlaces(1).toString();
}

export function riskLabel(score: number): RiskLabel {
  if (score >= RISK_LABEL_THRESHOLDS.highFrom) return 'High';
  if (score >= RISK_LABEL_THRESHOLDS.moderateFrom) return 'Moderate';
  return 'Low';
}

interface FactorResult {
  factor: RiskFactor;
  risk: Decimal;
  available: boolean;
  driver: string | null;
}

export function computeRisk(input: RiskInput): RiskMeter {
  const holdings = input.holdings.filter((h) => h.valueUsd.gt(0));
  const lpOut = input.lpOutOfRangeUsd ?? new Decimal(0);
  const caution = input.cautionHookUsd ?? new Decimal(0);
  const danger = input.dangerHookUsd ?? new Decimal(0);
  const total = holdings.reduce((acc, h) => acc.plus(h.valueUsd), new Decimal(0)).plus(lpOut);

  if (total.isZero()) {
    return {
      score: 0,
      label: 'Low',
      drivers: ['No funds in the agent wallet yet'],
      factors: (Object.keys(RISK_WEIGHTS) as RiskFactor[]).map((factor) => ({
        factor,
        risk: 0,
        weight: RISK_WEIGHTS[factor],
        points: 0,
        available: true,
      })),
    };
  }

  const results: FactorResult[] = [];

  // Concentration — largest single asset.
  const largest = holdings.reduce<RiskHolding | null>(
    (max, h) => (max === null || h.valueUsd.gt(max.valueUsd) ? h : max),
    null,
  );
  const largestShare = largest ? largest.valueUsd.div(total) : new Decimal(0);
  results.push({
    factor: 'concentration',
    risk: clamp01(largestShare.minus(0.4).div(0.6)),
    available: true,
    driver: largest ? `${pct(largestShare)}% of your portfolio is in ${largest.symbol}` : null,
  });

  // Stablecoin buffer.
  const stableShare = holdings
    .filter((h) => h.isStable)
    .reduce((acc, h) => acc.plus(h.valueUsd), new Decimal(0))
    .div(total);
  results.push({
    factor: 'stablecoin',
    risk: clamp01(new Decimal(0.5).minus(stableShare).div(0.5)),
    available: true,
    driver: stableShare.isZero()
      ? 'No stablecoin buffer'
      : `Only ${pct(stableShare)}% is in stablecoins`,
  });

  // LP out of range.
  const lpShare = lpOut.div(total);
  results.push({
    factor: 'lpOutOfRange',
    risk: clamp01(lpShare.div(0.5)),
    available: true,
    driver: `${pct(lpShare)}% of your value is in out-of-range liquidity`,
  });

  // Hook exposure (Danger weighs double).
  const hookShare = caution.times(0.5).plus(danger).div(total);
  results.push({
    factor: 'hookExposure',
    risk: clamp01(hookShare.div(0.5)),
    available: true,
    driver: `${pct(caution.plus(danger).div(total))}% sits in Caution/Danger hook pools`,
  });

  // Drawdown vs 7-day high, value-weighted over volatile holdings.
  const volatile = holdings.filter((h) => !h.isStable);
  const known = volatile.filter((h) => h.drawdownPct !== null);
  const drawdownAvailable = volatile.length === 0 || known.length === volatile.length;
  if (drawdownAvailable) {
    const weighted = known
      .reduce((acc, h) => acc.plus(h.valueUsd.times(h.drawdownPct!)), new Decimal(0))
      .div(total);
    const worst = known.reduce<RiskHolding | null>(
      (max, h) => (max === null || h.drawdownPct!.gt(max.drawdownPct!) ? h : max),
      null,
    );
    results.push({
      factor: 'drawdown',
      risk: clamp01(weighted.div(15)),
      available: true,
      driver: worst
        ? `${worst.symbol} is ${worst.drawdownPct!.toDecimalPlaces(1).toString()}% below its 7-day high`
        : null,
    });
  } else {
    results.push({ factor: 'drawdown', risk: new Decimal(0), available: false, driver: null });
  }

  const availableWeight = results
    .filter((r) => r.available)
    .reduce((acc, r) => acc + RISK_WEIGHTS[r.factor], 0);

  const factors = results.map((r) => {
    const weight = RISK_WEIGHTS[r.factor];
    const points = r.available
      ? r.risk.times(100).times(weight).div(availableWeight).toDecimalPlaces(2).toNumber()
      : 0;
    return {
      factor: r.factor,
      risk: r.risk.times(100).toDecimalPlaces(1).toNumber(),
      weight,
      points,
      available: r.available,
      driver: r.driver,
    };
  });

  const weighted = Math.min(
    100,
    Math.max(0, Math.round(factors.reduce((acc, f) => acc + f.points, 0))),
  );
  const score = danger.gt(0) ? Math.max(weighted, RISK_LABEL_THRESHOLDS.highFrom) : weighted;
  const floorApplied = danger.gt(0);
  const drivers = factors
    .filter((f) => f.points >= 1 && f.driver)
    .sort(
      (a, b) =>
        // The Danger-hook floor is the headline reason when it applies.
        Number(floorApplied && b.factor === 'hookExposure') -
          Number(floorApplied && a.factor === 'hookExposure') || b.points - a.points,
    )
    .slice(0, 3)
    .map((f) => f.driver!);

  return {
    score,
    label: riskLabel(score),
    drivers: drivers.length > 0 ? drivers : ['Diversified, with a stablecoin buffer'],
    factors: factors.map(({ driver: _driver, ...f }) => f),
  };
}
