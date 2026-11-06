import type { AgentMessageView } from '@warden/shared';
import { describe, expect, it } from 'vitest';
import { dayLabel, shortRoute } from './cards/card-utils';
import { foldMessages } from './fold';

const TX = `0x${'ab'.repeat(32)}`;
const msg = (
  id: string,
  cards: unknown[],
  role: AgentMessageView['role'] = 'AGENT',
): AgentMessageView => ({
  id,
  role,
  text: id,
  cards,
  traceId: 't1',
  createdAt: '2026-11-06T10:00:00.000Z',
});
const preview = {
  type: 'preview',
  actionPlanId: 'p1',
  status: 'EXECUTED',
  title: 'Swap',
  summary: 's',
  amountUsd: '5.00',
  steps: [],
  policyOutcome: 'AUTO',
  policyReasons: [],
};
const receipt = {
  type: 'receipt',
  actionPlanId: 'p1',
  title: 'Done: swap',
  summary: 'ok',
  amountUsd: '5.00',
  approvedBy: 'AGENT',
  txs: [{ hash: TX, kind: 'swap', explorerUrl: 'https://x.io/tx/1', status: 'CONFIRMED' }],
};

describe('foldMessages (preview → receipt in place)', () => {
  it('replaces the preview with its receipt and hides the follow-up message', () => {
    const out = foldMessages([msg('user', [], 'USER'), msg('a', [preview]), msg('b', [receipt])]);
    expect(out[1]!.cards.map((c) => c.type)).toEqual(['receipt']);
    expect(out[2]!.hidden).toBe(true);
    expect(out[0]!.hidden).toBe(false);
  });

  it('keeps the approval record and appends the outcome after it', () => {
    const approval = {
      type: 'approval',
      approvalId: 'x',
      actionPlanId: 'p1',
      title: 't',
      reason: 'r',
      amountUsd: '60.00',
      status: 'USED',
      channel: 'WEB',
      providerKind: 'dev',
      expiresAt: '2026-11-06T10:05:00.000Z',
    };
    const out = foldMessages([msg('a', [approval]), msg('b', [receipt])]);
    expect(out[0]!.cards.map((c) => c.type)).toEqual(['approval', 'receipt']);
    expect(out[1]!.hidden).toBe(true);
  });

  it('leaves unrelated messages and plans without an outcome untouched', () => {
    const other = { ...preview, actionPlanId: 'p2', status: 'QUEUED' };
    const out = foldMessages([
      msg('a', [other]),
      msg('c', [{ type: 'info', title: 'Hi', body: 'x' }]),
    ]);
    expect(out[0]!.cards[0]).toMatchObject({ type: 'preview', actionPlanId: 'p2' });
    expect(out[1]!.hidden).toBe(false);
  });
});

describe('card utils', () => {
  it('shortens Uniswap route strings', () => {
    expect(shortRoute('[V4] 100.00% = ETH -- 0.3% [0x3390c733]USDC')).toBe('V4 · 0.3% pool');
    expect(shortRoute('plain route')).toBe('plain route');
  });

  it('labels days', () => {
    const now = new Date('2026-11-06T12:00:00');
    expect(dayLabel('2026-11-06T09:00:00', now)).toBe('Today');
    expect(dayLabel('2026-11-05T23:00:00', now)).toBe('Yesterday');
    expect(dayLabel('2026-11-01T09:00:00', now)).toMatch(/Nov 1/);
  });
});
