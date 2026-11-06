/**
 * LP range bar geometry (PHASE 07 §3). The bar spans the position's range plus padding on both
 * sides; the current-price marker is clamped to the bar so an out-of-range price stays visible
 * at the edge (with the side it fell off).
 */
export interface RangeGeometry {
  /** Range start / end on the bar, percent of its width. */
  left: number;
  width: number;
  /** Current-price marker, percent of the bar width (clamped to 0–100). */
  marker: number;
  inRange: boolean;
  side: 'below' | 'above' | null;
}

export function rangeGeometry(lower: number, upper: number, current: number): RangeGeometry | null {
  if (![lower, upper, current].every(Number.isFinite) || lower <= 0 || upper <= lower) return null;
  // Log scale: price ranges are multiplicative (ticks), so ±10% looks the same everywhere.
  const lo = Math.log(lower);
  const hi = Math.log(upper);
  const pad = (hi - lo) * 0.5;
  const min = lo - pad;
  const max = hi + pad;
  const pos = (x: number) => ((x - min) / (max - min)) * 100;
  const c = current > 0 ? Math.log(current) : min;
  const inRange = current >= lower && current <= upper;
  return {
    left: pos(lo),
    width: pos(hi) - pos(lo),
    marker: Math.min(100, Math.max(0, pos(c))),
    inRange,
    side: inRange ? null : current < lower ? 'below' : 'above',
  };
}

/** Prices for display: 4 significant digits, thousands separators. */
export function formatPrice(v: string | number): string {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return String(v);
  if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
  return n.toPrecision(4);
}
