// @vitest-environment jsdom
import type { SimulatorRunView } from '@warden/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SimulatorPage } from '@/pages/SimulatorPage';
import { renderUi } from '@/test/render';
import { DecisionCard } from './DecisionCard';
import { isActive, runEvents } from './hooks';

const zg = { requestId: 'r', clientRequestId: 'c', model: 'm', trustMode: 'private' } as const;
const base: SimulatorRunView = {
  id: 'run-1',
  scenarioId: 'LP_MIGRATION_NOT_WORTH_IT',
  label: 'A better LP pool?',
  mode: 'DEMO',
  effectiveMode: 'DEMO',
  status: 'DONE',
  event: 'A new ETH/USDC pool shows a higher headline fee APR than your position',
  decision: {
    outcome: 'NO_ACTION',
    summary: null,
    rationale: 'The break-even is far too long.',
    digest: {
      signalsChecked: [{ signal: 'Break-even', value: '29 weeks', supports: 'HOLD' }],
      risks: ['Upgradeable hook'],
    },
    zg,
  },
  rejected: false,
  notice: null,
  error: null,
  suggestion: null,
  createdAt: '2026-11-06T12:00:00.000Z',
};
const card = (run: SimulatorRunView | null) =>
  render(<DecisionCard run={run} retrying={false} onRetry={vi.fn()} />);

describe('DecisionCard', () => {
  it('shows no action as a deliberate outcome, with its signals and the hook caveat', () => {
    card(base);
    expect(screen.getByText('No action')).toBeInTheDocument();
    expect(screen.getByText(/chose not to act/)).toBeInTheDocument();
    expect(screen.getByText('Supports waiting')).toBeInTheDocument();
    expect(screen.getByText(/not a security certification/)).toBeInTheDocument();
    expect(screen.getByText('SIMULATED')).toBeInTheDocument();
  });

  it('leaves out what the model did not return', () => {
    card({
      ...base,
      decision: { ...base.decision!, digest: null },
      scenarioId: 'ETH_DIP_STABILIZING',
    });
    expect(screen.queryByText('Cost')).not.toBeInTheDocument();
    expect(screen.queryByText('Risk')).not.toBeInTheDocument();
    expect(screen.queryByText('Alternatives considered')).not.toBeInTheDocument();
  });

  it('never calls a proposal done before a transaction says so', () => {
    card({
      ...base,
      scenarioId: 'ETH_DIP_STABILIZING',
      rejected: true,
      notice: 'Rejected: Over your $25 per-action limit. Nothing was traded.',
      decision: {
        ...base.decision!,
        outcome: 'BUY',
        summary: 'swap 60 USDC to ETH',
        digest: null,
      },
    });
    expect(screen.getByText('Proposed: Buy')).toBeInTheDocument();
    expect(screen.queryByText('Bought')).not.toBeInTheDocument();
    expect(screen.getByText('Rejected')).toBeInTheDocument();
    expect(screen.getByText(/per-action limit/)).toBeInTheDocument();
  });

  it('shows a reasoning failure with no decision and offers a retry', () => {
    card({
      ...base,
      status: 'FAILED',
      decision: null,
      error: 'Reasoning failed: 0G is not configured on this server.',
    });
    expect(screen.getByText('Reasoning failed')).toBeInTheDocument();
    expect(screen.queryByText('No action')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /try again|retry/i })).toBeInTheDocument();
  });

  it('labels a paper run', () => {
    card({ ...base, effectiveMode: 'PAPER', notice: 'Paper — not broadcast.' });
    expect(screen.getByText('PAPER')).toBeInTheDocument();
    expect(screen.getByText('Paper — not broadcast.')).toBeInTheDocument();
  });
});

describe('SimulatorPage', () => {
  const providers = {
    appName: 'SAKA',
    identity: 'dev',
    approvals: 'dev',
    executionChainId: 11155111,
  };

  it('is the ordinary not-found page with the server flag off', async () => {
    renderUi(<SimulatorPage />, { responses: { '/auth/providers': providers } });
    expect(await screen.findByText('Page not found')).toBeInTheDocument();
  });

  it('shows the simulator with the flag on', async () => {
    renderUi(<SimulatorPage />, {
      responses: {
        '/auth/providers': { ...providers, demoSimulator: true },
        '/simulator/scenarios': { scenarios: [] },
        '/simulator/runs': { runs: [] },
      },
    });
    expect(await screen.findByText('Market Event Simulator')).toBeInTheDocument();
  });
});

describe('runEvents', () => {
  const event = (id: string, traceId: string, ts: string) =>
    ({ id, traceId, userId: 'u', ts, kind: 'plan', title: id }) as const;

  it('adds live steps of this run to the stored ones, oldest first, without repeats', () => {
    const stored = [event('a', 'run-1', '2026-11-06T12:00:00.000Z')];
    const live = [
      event('c', 'run-1', '2026-11-06T12:00:02.000Z'),
      event('x', 'run-2', '2026-11-06T12:00:03.000Z'),
      event('b', 'run-1', '2026-11-06T12:00:01.000Z'),
      event('a', 'run-1', '2026-11-06T12:00:00.000Z'),
    ];
    expect(runEvents(stored, live, 'run-1').map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });
});

describe('isActive', () => {
  it('keeps polling until the transaction settles', () => {
    expect(isActive({ ...base, status: 'RUNNING' })).toBe(true);
    expect(isActive(base)).toBe(false);
  });
});
