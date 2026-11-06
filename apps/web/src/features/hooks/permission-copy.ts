/**
 * Uniswap v4 hook permission flags in human words (PHASE 07 §2), e.g. `beforeSwapReturnDelta`
 * → "Can change your swap amount". Risk tone comes from score_hook.
 */
export const PERMISSION_COPY: Record<string, { short: string; long: string }> = {
  beforeInitialize: {
    short: 'Runs at pool creation',
    long: 'Runs custom code before the pool is created.',
  },
  afterInitialize: {
    short: 'Runs after pool creation',
    long: 'Runs custom code right after the pool is created.',
  },
  beforeAddLiquidity: {
    short: 'Can block deposits',
    long: 'Runs before liquidity is added — it can reject or change deposits.',
  },
  afterAddLiquidity: { short: 'Runs after deposits', long: 'Runs after liquidity is added.' },
  beforeRemoveLiquidity: {
    short: 'Can block withdrawals',
    long: 'Runs before liquidity is removed — it can delay or reject your withdrawal.',
  },
  afterRemoveLiquidity: {
    short: 'Runs after withdrawals',
    long: 'Runs after liquidity is removed.',
  },
  beforeSwap: {
    short: 'Can change swap fees',
    long: 'Runs before every swap — it can set dynamic fees or reject the swap.',
  },
  afterSwap: {
    short: 'Runs after every swap',
    long: 'Runs after every swap (e.g. to record prices or rewards).',
  },
  beforeDonate: {
    short: 'Runs before donations',
    long: 'Runs before tokens are donated to the pool.',
  },
  afterDonate: {
    short: 'Runs after donations',
    long: 'Runs after tokens are donated to the pool.',
  },
  beforeSwapReturnDelta: {
    short: 'Can change your swap amount',
    long: 'Can take or add tokens before your swap is priced — it changes what you pay or receive.',
  },
  afterSwapReturnDelta: {
    short: 'Can change what you receive',
    long: 'Can take or add tokens after your swap — it changes what you receive.',
  },
  afterAddLiquidityReturnDelta: {
    short: 'Can change your deposit',
    long: 'Can take or add tokens when you deposit liquidity.',
  },
  afterRemoveLiquidityReturnDelta: {
    short: 'Can change your withdrawal',
    long: 'Can take or add tokens when you withdraw liquidity — it changes what you get back.',
  },
};

export function permissionCopy(flag: string): { short: string; long: string } {
  return PERMISSION_COPY[flag] ?? { short: flag, long: `Hook permission ${flag}.` };
}

export function riskTone(risk: string | null | undefined): 'danger' | 'caution' | 'neutral' {
  const r = (risk ?? '').toUpperCase();
  if (r === 'CRITICAL' || r === 'HIGH') return 'danger';
  if (r === 'MEDIUM') return 'caution';
  return 'neutral';
}

export const BAND_META = {
  SAFE: { label: 'Safe', tone: 'safe' as const },
  CAUTION: { label: 'Caution', tone: 'caution' as const },
  DANGER: { label: 'Danger', tone: 'danger' as const },
};

/** "$4.5M", "$812K", "$95" — compact USD for cards. */
export function compactUsd(v: string | null | undefined): string {
  if (!v) return '—';
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n.toFixed(0)}`;
}

/** "3 days", "5 months", "today". */
export function ageLabel(days: number | null): string {
  if (days === null) return 'age unknown';
  if (days < 1) return 'new today';
  if (days < 60) return `${Math.round(days)} day${Math.round(days) === 1 ? '' : 's'} old`;
  if (days < 730) return `${Math.round(days / 30)} months old`;
  return `${(days / 365).toFixed(1)} years old`;
}

/** "ETH/USDC" for a hook pool (short address when a symbol is unknown). */
export const pairLabel = (p: {
  token0: string;
  token1: string;
  token0Symbol: string | null;
  token1Symbol: string | null;
}) =>
  `${p.token0Symbol ?? `${p.token0.slice(0, 6)}…`}/${p.token1Symbol ?? `${p.token1.slice(0, 6)}…`}`;
