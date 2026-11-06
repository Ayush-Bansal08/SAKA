/** ETH 10% under its weekly high after a slow decline, and steady for the last day. */
import type { Scenario } from '../types.js';

export const ethDip: Scenario = {
  id: 'ETH_DIP_STABILIZING',
  label: 'ETH −10%, stabilizing',
  description:
    'ETH sits 10% under its 7-day high after a slow 3–4 day decline. The last 24 hours held a tight range on normal volume.',
  detector: 'DIP',
  severity: 'NORMAL',
  eventType: 'MARKET_PRICE_CHANGE',
  subject: { asset: 'ETH' },
  eventLine: 'ETH is 10% below its 7-day high after a gradual decline',
  prices: {
    '1h': ['0.899', '0.9', '0.898', '0.899', '0.901', '0.9'],
    '24h': ['0.897', '0.895', '0.898', '0.902', '0.899', '0.903', '0.898', '0.901', '0.9'],
    '7d': ['0.995', '1', '0.985', '0.955', '0.925', '0.905', '0.897', '0.9'],
  },
  allocation: 'BELOW_TARGET',
  signals: {
    declineShape: 'gradual, over about 3.5 days',
    last24hRangePct: 0.9,
    aboveRecentLow: true,
    downsideVolumeVsNormal: '1.0x',
    poolDepthChange24hPct: -1,
    priceImpactForTradeSize: 'normal',
    priceImpactForTradeSizePct: 0.1,
    swapGasUsd: 0.1,
    mandate: 'Adding ETH with idle USDC is allowed within the per-action limit',
    realizedVolatility: 'easing',
    stablecoinDepeg: false,
    protocolOrHookIncident: false,
    gas: 'normal',
    marketDataFresh: true,
  },
  lp: null,
};
