/** ETH down 8% in an hour, still making lower lows, with independent stress signals agreeing. */
import type { Scenario } from '../types.js';

export const ethCrashGuard: Scenario = {
  id: 'ETH_CRASH_GUARD',
  label: 'ETH −8% in 1h, stress signals',
  description:
    'ETH fell 8% within an hour and keeps making lower lows. Downside volume is 3× normal, pool depth is down 30% and volatility is spiking.',
  detector: 'BIG_MOVE',
  severity: 'RED',
  eventType: 'MARKET_PRICE_CHANGE',
  subject: { asset: 'ETH' },
  eventLine: 'ETH fell 8% within the last hour and is still making lower lows',
  prices: {
    '1h': ['1', '0.985', '0.968', '0.951', '0.934', '0.92'],
    '24h': ['1.008', '1.012', '1.005', '1.01', '1.004', '1.007', '1', '0.96', '0.92'],
    '7d': ['1.01', '1.015', '1.005', '1.012', '1.008', '1.01', '1.003', '0.92'],
  },
  allocation: 'AT_OR_ABOVE_TARGET',
  signals: {
    declineShape: 'sharp, within about one hour',
    recoveredFromLow: false,
    downsideVolumeVsHourlyAverage: '3.0x',
    volumeDirection: 'mostly downside',
    priceVs7dAverage: 'below',
    trend24h: 'negative',
    poolDepthChange24hPct: -30,
    priceImpactForTradeSize: 'rising',
    realizedVolatility: 'spiking',
    stablecoinDepeg: false,
    gas: 'elevated, not prohibitive',
    marketDataFresh: true,
  },
  lp: null,
};
