// @vitest-environment jsdom
/** PHASE 07 UI: permission chip text, range bar math, prefill bus, hook / LP / rule components. */
import type { HookListItem, LpPositionView, TriggerView } from '@warden/shared';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InfoCardView } from '@/features/agent/cards/InfoCards';
import { requestPrefill, subscribePrefill } from '@/features/agent/prefill';
import { LiquiditySection } from '@/features/portfolio/Liquidity';
import { rangeGeometry } from '@/features/portfolio/range';
import { RuleRow } from '@/features/triggers/RulesPanel';
import { renderUi } from '@/test/render';
import { HookCard } from './HookCard';
import { ageLabel, compactUsd, pairLabel, permissionCopy, riskTone } from './permission-copy';

afterEach(() => vi.unstubAllGlobals());

describe('permission copy', () => {
  it('speaks human', () => {
    expect(permissionCopy('beforeSwapReturnDelta').short).toBe('Can change your swap amount');
    expect(permissionCopy('beforeRemoveLiquidity').short).toBe('Can block withdrawals');
    expect(permissionCopy('somethingNew')).toEqual({
      short: 'somethingNew',
      long: 'Hook permission somethingNew.',
    });
    expect(riskTone('CRITICAL')).toBe('danger');
    expect(riskTone('MEDIUM')).toBe('caution');
    expect(riskTone(null)).toBe('neutral');
    expect(compactUsd('4500000')).toBe('$4.5M');
    expect(ageLabel(3)).toBe('3 days old');
    expect(
      pairLabel({ token0: '0x0', token1: '0x1', token0Symbol: 'ETH', token1Symbol: null }),
    ).toBe('ETH/0x1…');
  });
});

describe('range bar geometry', () => {
  it('centres the range with padding and places the price marker', () => {
    const g = rangeGeometry(2000, 3000, 2500)!;
    expect(g.inRange).toBe(true);
    expect(g.left).toBeCloseTo(25, 5);
    expect(g.width).toBeCloseTo(50, 5);
    expect(g.marker).toBeGreaterThan(g.left);
    expect(g.marker).toBeLessThan(g.left + g.width);
  });

  it('clamps out-of-range prices to the edge and says which side', () => {
    expect(rangeGeometry(2000, 3000, 100)).toMatchObject({
      inRange: false,
      side: 'below',
      marker: 0,
    });
    expect(rangeGeometry(2000, 3000, 1e9)).toMatchObject({
      inRange: false,
      side: 'above',
      marker: 100,
    });
    expect(rangeGeometry(3000, 2000, 2500)).toBeNull();
    expect(rangeGeometry(0, 2000, 1)).toBeNull();
  });
});

describe('prefill bus', () => {
  it('delivers live and keeps text sent before the chat mounted', () => {
    requestPrefill('early text');
    const got: string[] = [];
    const sub = subscribePrefill((t) => got.push(t));
    expect(sub.initial).toBe('early text');
    requestPrefill('live text');
    expect(got).toEqual(['live text']);
    sub.unsubscribe();
    expect(subscribePrefill(() => undefined).initial).toBe('live text');
  });
});

const hook = (over: Partial<HookListItem> = {}): HookListItem => ({
  chainId: 11155111,
  address: '0x1111111111111111111111111111111111110080',
  name: 'DynamicFeeHook',
  score: 62,
  band: 'CAUTION',
  permissions: [
    { flag: 'beforeSwap', risk: 'MEDIUM' },
    { flag: 'beforeSwapReturnDelta', risk: 'CRITICAL' },
  ],
  pairs: [
    {
      poolId: `0x${'aa'.repeat(32)}`,
      token0: '0x0000000000000000000000000000000000000000',
      token1: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
      token0Symbol: 'ETH',
      token1Symbol: 'USDC',
      fee: 3000,
      tickSpacing: 60,
      tvlUsd: '125000',
    },
  ],
  poolCount: 1,
  tvlUsd: '125000',
  ageDays: 12,
  firstSeenAt: new Date().toISOString(),
  lastCheckedAt: new Date().toISOString(),
  explanation: {
    text: 'This hook sets dynamic fees on every swap.',
    model: 'glm-5.3',
    requestId: 'req-hook-1',
    trustMode: 'private',
    teeVerified: true,
  },
  tradeable: true,
  ...over,
});

describe('HookCard', () => {
  it('shows score, pair, explanation with 0G request ID and human permission chips', () => {
    renderUi(<HookCard hook={hook()} />);
    expect(screen.getByLabelText('Safety score 62 of 100, Caution')).toBeInTheDocument();
    expect(screen.getByText('ETH/USDC')).toBeInTheDocument();
    expect(screen.getByText('This hook sets dynamic fees on every swap.')).toBeInTheDocument();
    expect(screen.getByText('Can change your swap amount')).toBeInTheDocument();
    expect(screen.getByText('Can change swap fees')).toBeInTheDocument();
    expect(screen.getByText('TVL')).toBeInTheDocument();
    expect(screen.getByText('$125K')).toBeInTheDocument();
  });

  it('"Ask agent" and "Try $5" prefill the chat and go to the cockpit; market hooks cannot be tried', async () => {
    const got: string[] = [];
    const sub = subscribePrefill((t) => got.push(t));
    const ui = renderUi(<HookCard hook={hook()} />, { route: '/hooks' });
    await userEvent.click(screen.getByRole('button', { name: /Try \$5 through it/ }));
    expect(got.at(-1)).toBe(
      'Swap $5 ETH to USDC through the pool with hook 0x1111111111111111111111111111111111110080',
    );
    expect(ui.location()).toBe('/app');
    await userEvent.click(screen.getByRole('button', { name: /Ask agent about this/ }));
    expect(got.at(-1)).toBe('Explain hook 0x1111111111111111111111111111111111110080');
    sub.unsubscribe();
    ui.unmount();
    renderUi(<HookCard hook={hook({ tradeable: false, chainId: 1 })} />);
    expect(screen.queryByRole('button', { name: /Try \$5/ })).toBeNull();
  });
});

const position: LpPositionView = {
  id: 'lp_1',
  tokenId: '42',
  poolId: `0x${'bb'.repeat(32)}`,
  token0: { symbol: 'ETH', address: '0x0000000000000000000000000000000000000000' },
  token1: { symbol: 'USDC', address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' },
  amount0: '0.002',
  amount1: '5.1',
  fees0: '0',
  fees1: '0.03',
  tickLower: -200000,
  tickUpper: -190000,
  currentTick: -195000,
  priceLower: '2200',
  priceUpper: '2800',
  priceCurrent: '2500',
  inRange: true,
  valueUsd: '10.12',
  costBasisUsd: '10',
  pnlUsd: '0.12',
  hook: null,
  openedAt: new Date().toISOString(),
};

describe('Liquidity section', () => {
  it('renders the range bar, value, P&L and fees; actions prefill rebalance / exit', async () => {
    const got: string[] = [];
    const sub = subscribePrefill((t) => got.push(t));
    renderUi(
      <LiquiditySection
        positions={[position, { ...position, id: 'lp_2', inRange: false, priceCurrent: '3500' }]}
      />,
    );
    expect(screen.getAllByText('ETH/USDC')).toHaveLength(2);
    expect(screen.getByText('In range')).toBeInTheDocument();
    expect(screen.getByText('Out of range')).toBeInTheDocument();
    expect(screen.getAllByRole('img', { name: /out of range \(above\)/ })).toHaveLength(1);
    expect(screen.getAllByText('$10.12')).toHaveLength(2);
    expect(screen.getAllByText(/fees 0\.03 USDC/)).toHaveLength(2);
    await userEvent.click(screen.getAllByRole('button', { name: 'Exit' })[0]!);
    expect(got.at(-1)).toBe('Exit my ETH/USDC position lp_1');
    await userEvent.click(screen.getAllByRole('button', { name: 'Rebalance' })[1]!);
    expect(got.at(-1)).toBe('Rebalance my ETH/USDC position lp_2 around the current price');
    sub.unsubscribe();
  });

  it('empty state offers to add liquidity', () => {
    renderUi(<LiquiditySection positions={[]} />);
    expect(screen.getByText('No positions yet')).toBeInTheDocument();
  });
});

const rule = (over: Partial<TriggerView> = {}): TriggerView => ({
  id: 'trg_1',
  kind: 'TAKE_PROFIT',
  status: 'ACTIVE',
  summary: 'When ETH ≥ $2,550, sell 50% of ETH for USDC.',
  symbol: 'ETH',
  targetPriceUsd: '2550',
  direction: 'above',
  schedule: null,
  nextRunAt: null,
  lastFiredAt: null,
  fireCount: 0,
  lastResult: null,
  chain: null,
  createdAt: new Date().toISOString(),
  ...over,
});

describe('Rules', () => {
  it('an active rule shows its target and cancels through the API', async () => {
    const ui = renderUi(<RuleRow t={rule()} />, {
      responses: { '/triggers/trg_1/cancel': rule({ status: 'CANCELLED' }) },
    });
    expect(screen.getAllByText(/ETH ≥ \$2,550/)).toHaveLength(2); // summary + target line
    await userEvent.click(screen.getByRole('button', { name: /Cancel rule/ }));
    await waitFor(() =>
      expect(ui.fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/triggers/trg_1/cancel'),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('a stopped chain shows the reason in red and no cancel button', () => {
    renderUi(
      <RuleRow
        t={rule({
          kind: 'CHAINED',
          status: 'FAILED',
          lastResult: 'Stopped at step 2 of 2: was refused by the safety checks',
          chain: { step: 1, total: 2, waitingPlanId: null },
        })}
      />,
    );
    expect(screen.getByText(/Stopped at step 2 of 2/)).toHaveClass('text-danger');
    expect(screen.getByText('step 2/2')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Cancel rule/ })).toBeNull();
  });

  it('the "Rule set" chat card shows the target and a cancel button', async () => {
    const ui = renderUi(
      <InfoCardView
        card={{
          type: 'info',
          title: 'Rule set: When ETH ≤ $2,800, sell 100% of ETH for USDC.',
          body: 'I check the price every 30 seconds.',
          data: {
            kind: 'trigger',
            triggerId: 'trg_9',
            triggerKind: 'STOP_LOSS',
            summary: 'When ETH ≤ $2,800, sell 100% of ETH for USDC.',
            symbol: 'ETH',
            targetPriceUsd: '2800',
            nextRunAt: null,
            warnings: [],
          },
        }}
      />,
      { responses: { '/triggers': { triggers: [] } } },
    );
    expect(screen.getByText('ETH target $2,800')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel rule' }));
    await waitFor(() =>
      expect(ui.fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/triggers/trg_9/cancel'),
        expect.anything(),
      ),
    );
  });
});
