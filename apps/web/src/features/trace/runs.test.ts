import type { TraceEvent } from '@warden/shared';
import { describe, expect, it } from 'vitest';
import { toastKind } from '@/layout/useTraceToasts';
import { plansToCsv } from '@/features/plan/hooks';
import { eventChips, eventMatches, formatDuration, groupRuns, runStatus } from './trace-utils';

let n = 0;
const ev = (
  traceId: string,
  kind: TraceEvent['kind'],
  title: string,
  extra: Partial<TraceEvent> = {},
): TraceEvent => ({
  id: `e${++n}`,
  traceId,
  userId: 'u',
  kind,
  title,
  ts: new Date(Date.UTC(2026, 10, 6, 10, 0, n)).toISOString(),
  ...extra,
});

describe('runs', () => {
  it('groups by trace, oldest event first inside a run, newest run first', () => {
    const a1 = ev('A', 'plan', 'Planning on 0G');
    const a2 = ev('A', 'plan', 'Prepared: swap $5 ETH → USDC');
    const b1 = ev('B', 'plan', 'Planning on 0G');
    const runs = groupRuns([b1, a2, a1]);
    expect(runs.map((r) => r.traceId)).toEqual(['B', 'A']);
    expect(runs[1]!.events.map((e) => e.id)).toEqual([a1.id, a2.id]);
    expect(runs[1]!.title).toBe('swap $5 ETH → USDC');
  });

  it.each([
    [[ev('X', 'receipt', 'Done: swap'), ev('X', 'log', 'Logged to 0G Storage')], 'done'],
    [[ev('X', 'policy', 'Policy: refused')], 'refused'],
    [[ev('X', 'approval', 'Waiting for your approval')], 'needs_you'],
    [[ev('X', 'approval', 'Denied')], 'cancelled'],
    [[ev('X', 'error', 'Execution failed')], 'failed'],
    [[ev('X', 'error', 'Price moved — aborted')], 'cancelled'],
    [[ev('X', 'policy', 'Policy: AUTO — your agent may do this alone')], 'running'],
    [[ev('X', 'plan', 'Agent reply')], 'info'],
  ] as const)('status %#', (events, status) => {
    expect(runStatus(events as unknown as TraceEvent[])).toBe(status);
  });

  it('filter chips', () => {
    const zg = ev('X', 'plan', 'Proposed intent', {
      zg: { requestId: 'r', clientRequestId: 'c', model: 'glm-5.3', trustMode: 'private' },
    });
    const tool = ev('X', 'tool_call', 'Uniswap · get_quote');
    const tx = ev('X', 'tx', 'Sent: swap');
    expect(eventMatches(zg, 'zg')).toBe(true);
    expect(eventMatches(tool, 'uniswap')).toBe(true);
    expect(eventMatches(tool, 'zg')).toBe(false);
    expect(eventMatches(tx, 'chain')).toBe(true);
    expect(eventMatches(ev('X', 'guard', 'Guard approved'), 'safety')).toBe(true);
    expect(eventMatches(ev('X', 'approval', 'Approved by you'), 'human')).toBe(true);
  });

  it('chips for tx hashes and 0G Storage roots; durations', () => {
    expect(
      eventChips(ev('X', 'tx', 'Sent', { data: { txHash: '0xabc', explorerUrl: 'https://x/tx' } })),
    ).toEqual([{ label: 'tx', value: '0xabc', href: 'https://x/tx' }]);
    expect(eventChips(ev('X', 'log', 'Logged', { data: { rootHash: '0xroot' } }))).toEqual([
      { label: '0G Storage', value: '0xroot' },
    ]);
    expect(formatDuration(850)).toBe('850 ms');
    expect(formatDuration(4_200)).toBe('4.2 s');
    expect(formatDuration(72_000)).toBe('1 m 12 s');
  });
});

describe('toasts', () => {
  it('fires only for executed / refused / approval-needed', () => {
    expect(toastKind(ev('X', 'receipt', 'Done: swap'))).toBe('executed');
    expect(toastKind(ev('X', 'policy', 'Policy: refused'))).toBe('refused');
    expect(toastKind(ev('X', 'approval', 'Waiting for your approval'))).toBe('approval');
    expect(toastKind(ev('X', 'receipt', 'Confirmed in block 1'))).toBeNull();
  });
});

describe('activity CSV', () => {
  it('quotes every cell and neutralises spreadsheet formulas', () => {
    const csv = plansToCsv([
      {
        id: 'p1',
        createdAt: '2026-11-06T10:00:00.000Z',
        traceId: 't',
        requestText: '=HYPERLINK("evil") "quoted"',
        type: 'swap_exact_in',
        summary: 's',
        amountUsd: '5.00',
        status: 'EXECUTED',
        outcome: 'EXECUTED',
        policyOutcome: 'AUTO',
        approvedBy: 'AGENT',
        tradeScore: 90,
        tx: { hash: '0xabc', explorerUrl: 'https://x.io/tx/0xabc' },
        decisionLog: { status: 'UPLOADED', rootHash: '0xroot' },
      },
    ]);
    const [header, row] = csv.split('\r\n');
    expect(header).toBe(
      'time,request,type,amount_usd,outcome,approved_by,trade_score,tx_hash,tx_url,zg_root_hash,plan_id',
    );
    expect(row).toContain(`"'=HYPERLINK(""evil"") ""quoted"""`);
    expect(row).toContain('"Swap","5.00","Executed","Agent","90","0xabc"');
    expect(row).toContain('"0xroot","p1"');
  });
});
