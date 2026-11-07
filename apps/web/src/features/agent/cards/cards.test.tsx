// @vitest-environment jsdom
/** PHASE 06 §7: every chat card in every state. */
import type {
  ApprovalCard,
  CardChecks,
  FailureCard,
  InfoCard,
  PreviewCard,
  PriceMovedCard,
  ReceiptCard,
  RefusalCard,
} from '@warden/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ISO, renderUi } from '@/test/render';
import { PlanCards } from '../PlanCards';

afterEach(() => vi.unstubAllGlobals());

const TX = `0x${'ab'.repeat(32)}`;
const ROOT = `0x${'cd'.repeat(32)}`;
const quote = {
  amountIn: {
    symbol: 'ETH',
    address: '0x0000000000000000000000000000000000000000',
    amount: '0.002',
    decimals: 18,
  },
  amountOut: {
    symbol: 'USDC',
    address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    amount: '5.01',
    decimals: 6,
  },
  priceImpactPct: 0.12,
  gasUsd: '0.04',
  route: '[V4] 100.00% = ETH -- 0.3% [0x3390]USDC',
  slippagePct: 0.5,
} as const;
const checks: CardChecks = {
  breakdown: [
    { rule: 'price_impact', penalty: 0, evidence: 'Price impact 0.12%' },
    { rule: 'size_vs_portfolio', penalty: -10, evidence: '30% of your portfolio' },
  ],
  simulation: { ok: true, simulated: 1, deferred: 0 },
  guard: {
    verdict: 'approve',
    pApprove: 0.97,
    reason: 'Safety checks passed.',
    unavailable: false,
    zg: {
      requestId: 'req-guard-123',
      clientRequestId: 'c1',
      model: 'vela-2.0-9b',
      trustMode: 'private',
    },
  },
};

const preview = (over: Partial<PreviewCard> = {}): PreviewCard => ({
  type: 'preview',
  actionPlanId: 'plan_1',
  status: 'QUEUED',
  autoExecuteAt: ISO(3_000),
  title: 'Swap $5 ETH → USDC',
  summary: 'Within your limits',
  amountUsd: '5.00',
  quote,
  steps: [{ label: 'Swap via Uniswap', kind: 'swap' }],
  tradeScore: 90,
  policyOutcome: 'AUTO',
  policyReasons: [],
  checks,
  ...over,
});

describe('PreviewCard', () => {
  it('shows amounts, rows, checks, who approves and a live countdown with Cancel', async () => {
    const ui = renderUi(<PlanCards cards={[preview()]} />);
    expect(screen.getByLabelText('Action preview')).toBeInTheDocument();
    expect(screen.getByText('5.01')).toBeInTheDocument();
    expect(screen.getByText('0.12%')).toBeInTheDocument();
    expect(screen.getByText('V4 · 0.3% pool')).toBeInTheDocument();
    expect(screen.getByText('Simulation passed')).toBeInTheDocument();
    expect(screen.getByText('0G guard approved · p=0.97')).toBeInTheDocument();
    expect(screen.getByText('Agent alone')).toBeInTheDocument();
    expect(screen.getByText(/Agent will do this in/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(ui.fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/plans/plan_1/cancel'),
        expect.objectContaining({ method: 'POST' }),
      ),
    );
  });

  it('trade score opens its breakdown', async () => {
    renderUi(<PlanCards cards={[preview()]} />);
    await userEvent.click(screen.getByRole('button', { name: /Trade score 90/ }));
    expect(await screen.findByText('30% of your portfolio')).toBeInTheDocument();
    expect(screen.getByText('-10')).toBeInTheDocument();
  });

  it('executing and cancelled states; Details opens the plan drawer', async () => {
    const ui = renderUi(<PlanCards cards={[preview({ status: 'EXECUTING' })]} />);
    expect(screen.getByText(/Signing and sending on testnet/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: /Details/ }));
    expect(ui.location()).toContain('plan=plan_1');
    ui.unmount();
    renderUi(<PlanCards cards={[preview({ status: 'CANCELLED' })]} />);
    expect(screen.getByText('Cancelled — nothing was traded.')).toBeInTheDocument();
  });

  it('a failed simulation and an unavailable guard show as failed checks', () => {
    renderUi(
      <PlanCards
        cards={[
          preview({
            status: 'PREPARED',
            checks: {
              breakdown: [],
              simulation: { ok: false, simulated: 1, deferred: 0, error: 'step 1 reverted' },
              guard: {
                verdict: 'block',
                pApprove: 0,
                reason: 'Safety check unavailable',
                unavailable: true,
              },
            },
          }),
        ]}
      />,
    );
    expect(screen.getByText('Simulation failed')).toBeInTheDocument();
    expect(screen.getByText('0G guard unavailable')).toBeInTheDocument();
  });
});

const approval = (over: Partial<ApprovalCard> = {}): ApprovalCard => ({
  type: 'approval',
  approvalId: 'appr_1',
  actionPlanId: 'plan_2',
  title: 'Swap $60 ETH → USDC',
  summary: 'swap $60 ETH → USDC',
  reason: 'Over your $25 per-action limit',
  reasons: [
    {
      code: 'OVER_PER_ACTION_LIMIT',
      message: 'Over your $25 per-action limit',
      value: 60,
      limit: 25,
    },
  ],
  amountUsd: '60.00',
  status: 'PENDING',
  channel: 'WEB',
  providerKind: 'dev',
  expiresAt: ISO(240_000),
  checks,
  ...over,
});

describe('ApprovalCard', () => {
  it('pending: reasons with numbers, expiry countdown, Approve (dev) and Reject', async () => {
    const ui = renderUi(<PlanCards cards={[approval()]} />);
    const card = screen.getByLabelText('Approval needed');
    expect(
      within(card).getByText(/Needs you — over your \$25 per-action limit/),
    ).toBeInTheDocument();
    expect(within(card).getByText('60 / max 25')).toBeInTheDocument();
    expect(within(card).getByText(/Expires in [34]:\d\d/)).toBeInTheDocument();
    expect(within(card).getByText(/Approve \(dev\) is for local testing only/)).toBeInTheDocument();
    await userEvent.click(within(card).getByRole('button', { name: 'Reject' }));
    await waitFor(() =>
      expect(ui.fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/approvals/appr_1/deny'),
        expect.anything(),
      ),
    );
    await userEvent.click(within(card).getByRole('button', { name: /Approve \(dev\)/ }));
    await waitFor(() =>
      expect(ui.fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/approvals/appr_1/dev-approve'),
        expect.anything(),
      ),
    );
  });

  it.each([
    ['DENIED', 'You rejected it. Nothing was traded.'],
    ['REJECTED', 'A different human tried to approve. Nothing was traded.'],
    ['EXPIRED', 'The approval expired. Nothing was traded.'],
  ] as const)('%s: distinct state, "Nothing was traded", no buttons', (status, text) => {
    renderUi(<PlanCards cards={[approval({ status })]} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
  });

  it('a pending approval past its expiry renders as expired', () => {
    renderUi(<PlanCards cards={[approval({ expiresAt: ISO(-1_000) })]} />);
    expect(screen.getByText('The approval expired. Nothing was traded.')).toBeInTheDocument();
  });

  it('approved by the human', () => {
    renderUi(<PlanCards cards={[approval({ status: 'USED' })]} />);
    expect(screen.getAllByText(/Approved by you/).length).toBeGreaterThan(0);
  });
});

const refusal = (over: Partial<RefusalCard> = {}): RefusalCard => ({
  type: 'refusal',
  actionPlanId: 'plan_3',
  title: 'Refused: swap $50 ETH → USDC',
  summary: 'The price impact is far too high for this pool.',
  reasons: [
    {
      code: 'PRICE_IMPACT_TOO_HIGH',
      message: 'Price impact 7.2% is above the 5% hard limit',
      value: 7.2,
      limit: 5,
    },
  ],
  tradeScore: 20,
  suggestion: 'Try a smaller amount.',
  suggestedRequest: 'Swap $25 ETH to USDC',
  decisionLog: {
    status: 'UPLOADED',
    rootHash: ROOT,
    explorerUrl: 'https://chainscan-galileo.0g.ai/tx/0x1',
  },
  ...over,
});

describe('RefusalCard', () => {
  it('shows failed checks with numbers, the explainer, the 0G Storage hash', () => {
    renderUi(<PlanCards cards={[refusal()]} />);
    expect(screen.getByText('Refused — nothing was traded')).toBeInTheDocument();
    expect(screen.getByText('7.2 / max 5')).toBeInTheDocument();
    expect(screen.getByText(/far too high/)).toBeInTheDocument();
    expect(screen.getByText('0G Storage')).toBeInTheDocument();
  });

  it('the suggestion chip pre-fills the composer with a corrected request', async () => {
    const ui = renderUi(<PlanCards cards={[refusal()]} />);
    await userEvent.click(
      screen.getByRole('button', { name: 'Try instead: Swap $25 ETH to USDC' }),
    );
    expect(ui.composer.prefill).toHaveBeenCalledWith('Swap $25 ETH to USDC');
  });

  it('pending 0G log', () => {
    renderUi(<PlanCards cards={[refusal({ decisionLog: { status: 'PENDING' } })]} />);
    expect(screen.getByText('Logging to 0G Storage…')).toBeInTheDocument();
  });
});

const receipt = (over: Partial<ReceiptCard> = {}): ReceiptCard => ({
  type: 'receipt',
  actionPlanId: 'plan_4',
  title: 'Done: swap $5 ETH → USDC',
  summary: '1 transaction(s) confirmed.',
  amountUsd: '5.00',
  approvedBy: 'AGENT',
  txs: [
    {
      hash: TX,
      kind: 'swap',
      explorerUrl: `https://sepolia.etherscan.io/tx/${TX}`,
      status: 'CONFIRMED',
    },
  ],
  quote,
  inferences: [
    {
      role: 'PLANNER',
      model: 'glm-5.3',
      trustMode: 'private',
      requestId: 'req-plan-1',
      teeVerified: true,
    },
    {
      role: 'GUARD',
      model: 'vela-2.0-9b',
      trustMode: 'private',
      requestId: 'req-guard-1',
      teeVerified: null,
    },
  ],
  completedAt: ISO(0),
  decisionLog: { status: 'UPLOADED', rootHash: ROOT },
  ...over,
});

describe('ReceiptCard', () => {
  it('amounts, tx link, approved by, 0G Storage root', () => {
    renderUi(<PlanCards cards={[receipt()]} />);
    const card = screen.getByLabelText('Receipt');
    expect(within(card).getByText('5.01')).toBeInTheDocument();
    expect(within(card).getByText('Agent')).toBeInTheDocument();
    expect(within(card).getByRole('link', { name: 'Open in explorer' })).toHaveAttribute(
      'href',
      `https://sepolia.etherscan.io/tx/${TX}`,
    );
    expect(within(card).getByText('0G Storage')).toBeInTheDocument();
  });

  it('0G verified popover lists every inference with model, trust mode and request ID', async () => {
    renderUi(<PlanCards cards={[receipt({ approvedBy: 'HUMAN' })]} />);
    expect(screen.getByText('Approved by you')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /0G verified — 2 inferences/ }));
    expect(await screen.findByText('Decided on 0G')).toBeInTheDocument();
    expect(screen.getByText('glm-5.3')).toBeInTheDocument();
    expect(screen.getByText('vela-2.0-9b')).toBeInTheDocument();
    expect(screen.getByText('TEE ✓')).toBeInTheDocument();
  });
});

describe('PriceMoved and Failure cards', () => {
  it('price moved offers a fresh preview', async () => {
    const card: PriceMovedCard = {
      type: 'price_moved',
      actionPlanId: 'plan_5',
      title: 'Price moved — nothing was traded',
      summary: 'The price moved 1.40% against you.',
      previewAmount: '5.01',
      currentAmount: '4.94',
      symbol: 'USDC',
      worsePct: 1.4,
    };
    const ui = renderUi(<PlanCards cards={[card]} />);
    expect(screen.getByText('(1.40% worse)')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Get a fresh preview/ }));
    await waitFor(() =>
      expect(ui.fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/plans/plan_5/repreview'),
        expect.anything(),
      ),
    );
  });

  it('failure lists what was sent', () => {
    const card: FailureCard = {
      type: 'failure',
      actionPlanId: 'plan_6',
      title: 'Execution failed',
      summary: 'A transaction reverted on-chain.',
      txs: [{ hash: TX, kind: 'swap', explorerUrl: `https://x.io/tx/${TX}`, status: 'REVERTED' }],
    };
    renderUi(<PlanCards cards={[card]} />);
    expect(screen.getByText('A transaction reverted on-chain.')).toBeInTheDocument();
  });
});

describe('InfoCard', () => {
  const info = (data: unknown, title = 'Info'): InfoCard => ({
    type: 'info',
    title,
    body: 'Body text',
    data,
  });

  it('token check: verdict, facts and flags', () => {
    renderUi(
      <PlanCards
        cards={[
          info(
            {
              kind: 'token_check',
              chainId: 11155111,
              symbol: 'SCAM',
              name: 'Scam',
              address: '0x1111111111111111111111111111111111111111',
              isNative: false,
              verdict: 'BLOCK',
              onAllowlist: false,
              onUniswapUnsupportedList: true,
              liquidityDepthUsd: null,
              riskFlags: ['NO_LIQUIDITY'],
            },
            'Token check · SCAM',
          ),
        ]}
      />,
    );
    expect(screen.getByText('Unsafe')).toBeInTheDocument();
    expect(screen.getByText('Listed')).toBeInTheDocument();
    expect(screen.getByText('no liquidity')).toBeInTheDocument();
  });

  it('pool comparison table marks the pick and labels mainnet market data', () => {
    renderUi(
      <PlanCards
        cards={[
          {
            ...info(
              {
                kind: 'pool_compare',
                pair: 'ETH/USDC',
                marketLabel: 'Ethereum mainnet',
                recommendedPoolId: '0xaa',
                rows: [
                  {
                    rank: 1,
                    poolId: '0xaa',
                    feePct: 0.05,
                    hookAddress: null,
                    hookBand: null,
                    hookScore: null,
                    aprPct: '12.4',
                    adjustedAprPct: '12.4',
                    tvlUsd: '4500000',
                    usable: true,
                    reasons: [],
                  },
                  {
                    rank: 2,
                    poolId: '0xbb',
                    feePct: 0.3,
                    hookAddress: '0x2222222222222222222222222222222222222222',
                    hookBand: 'CAUTION',
                    hookScore: 62,
                    aprPct: '9.1',
                    adjustedAprPct: '4.5',
                    tvlUsd: '800000',
                    usable: false,
                    reasons: [],
                  },
                ],
                reasons: ['Deepest liquidity'],
              },
              'Best pool for ETH/USDC',
            ),
            marketDataSource: 'reference',
          },
        ]}
      />,
    );
    expect(screen.getByLabelText('Pick')).toBeInTheDocument();
    expect(screen.getByText('12.4%')).toBeInTheDocument();
    expect(screen.getByText('$4.5M')).toBeInTheDocument();
    expect(screen.getByText('Caution 62')).toBeInTheDocument();
    expect(screen.getByText('Market data · Ethereum mainnet')).toBeInTheDocument();
  });

  it('hook explanation and portfolio summary', () => {
    renderUi(
      <PlanCards
        cards={[
          info({
            kind: 'hook_score',
            chainId: 1,
            address: '0x3333333333333333333333333333333333333333',
            score: 42,
            band: 'DANGER',
            permissions: [{ flag: 'beforeSwapReturnDelta', risk: 'CRITICAL' }],
            upgradeable: true,
            verifiedSource: false,
            owner: null,
            ageDays: 3,
            breakdown: [{ rule: 'upgradeable', penalty: -20, evidence: 'Upgradeable proxy' }],
          }),
          info({
            kind: 'portfolio',
            totalUsd: '42.10',
            pnlUsd: '1.20',
            tokens: [{ symbol: 'ETH', amount: '0.01', usd: '42.10' }],
            risk: { score: 30, label: 'Low' },
            limits: { perActionUsd: '25', perDayUsd: '100', usedTodayUsd: '5' },
          }),
        ]}
      />,
    );
    expect(screen.getByLabelText('Hook score 42 of 100, Danger')).toBeInTheDocument();
    expect(screen.getByText('beforeSwapReturnDelta')).toBeInTheDocument();
    expect(screen.getByText('Upgradeable proxy')).toBeInTheDocument();
    expect(screen.getAllByText('$42.10').length).toBeGreaterThan(0);
    expect(screen.getByText('Risk Low · 30')).toBeInTheDocument();
  });

  it('the plain "Agent reply" echo is not a card; other plain info is', () => {
    renderUi(
      <PlanCards
        cards={[
          { type: 'info', title: 'Agent reply', body: 'Echo' },
          { type: 'info', title: 'Denied', body: 'Denied — nothing was traded.' },
        ]}
      />,
    );
    expect(screen.queryByText('Echo')).toBeNull();
    expect(screen.getByText('Denied — nothing was traded.')).toBeInTheDocument();
  });
});

describe('IntentCard (transient)', () => {
  const intent = {
    type: 'intent' as const,
    intent: {
      type: 'swap_exact_in' as const,
      tokenIn: { symbol: 'ETH' },
      tokenOut: { symbol: 'USDC' },
      amountIn: '0.002',
      amountUsd: '5',
      reason: 'User asked to swap',
    },
    zg: { requestId: 'r', clientRequestId: 'c', model: 'glm-5.3', trustMode: 'private' as const },
  };
  it('shows "Preparing…" alone, and disappears once the preview exists', () => {
    const ui = renderUi(<PlanCards cards={[intent]} preparing />);
    expect(screen.getByText('Preparing…')).toBeInTheDocument();
    ui.unmount();
    renderUi(<PlanCards cards={[intent, preview()]} />);
    expect(screen.queryByText('Preparing…')).toBeNull();
    expect(screen.getByLabelText('Action preview')).toBeInTheDocument();
  });
});
