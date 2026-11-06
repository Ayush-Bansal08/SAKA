// @vitest-environment jsdom
/** PHASE 08 UI: inbox rows, the pinned brief, the chat card, deep links, settings, toasts. */
import type {
  SettingsResponse,
  SuggestionCard,
  SuggestionsResponse,
  SuggestionView,
  TraceEvent,
} from '@warden/shared';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SuggestionCardView } from '@/features/agent/cards/SuggestionCardView';
import { consumePrefill, subscribePrefill } from '@/features/agent/prefill';
import { runStatus } from '@/features/trace/trace-utils';
import { toastKind } from '@/layout/useTraceToasts';
import { DecisionsTab } from '@/pages/autopilot/DecisionsTab';
import { ISO, renderUi } from '@/test/render';
import { AlertSettings } from './AlertSettings';
import { changesSuggestions } from './hooks';
import { briefLines, countdown, statusPill, timeZones } from './suggestion-meta';
import { BriefCard, SuggestionRow } from './SuggestionRow';

afterEach(() => vi.unstubAllGlobals());

const plan = (over: Partial<NonNullable<SuggestionView['plan']>> = {}) =>
  ({
    id: 'plan1',
    summary: 'swap $20 USDC → ETH',
    status: 'PREPARED',
    policyOutcome: 'ASK',
    amountUsd: '20.00',
    tradeScore: 92,
    hookScore: null,
    approver: 'you',
    reasons: [],
    approvalId: null,
    tx: null,
    ...over,
  }) as NonNullable<SuggestionView['plan']>;

const suggestion = (over: Partial<SuggestionView> = {}): SuggestionView => ({
  id: 's1',
  detector: 'DIP',
  severity: 'NORMAL',
  status: 'OPEN',
  title: 'ETH dipped 11%: buy $20.00',
  message: 'ETH is 11% below its 7-day high. I suggest buying $20.',
  note: null,
  simulated: false,
  plan: plan(),
  prefill: 'Swap $20 USDC to ETH',
  actions: ['yes', 'change', 'no'],
  expiresAt: ISO(10 * 60_000),
  createdAt: ISO(-60_000),
  zg: null,
  ...over,
});

const actionResponse = (result: string, over: Record<string, unknown> = {}) => ({
  result,
  message: 'Your agent is doing it now.',
  approvalId: null,
  prefill: null,
  suggestion: suggestion({ status: 'ACCEPTED', actions: [], expiresAt: null }),
  ...over,
});

const calledWith = (fetchMock: ReturnType<typeof vi.fn>, path: string) =>
  fetchMock.mock.calls.some(([url]) => String(url).includes(path));

describe('helpers', () => {
  it('the plan outcome wins over the suggestion status', () => {
    expect(statusPill({ status: 'ACCEPTED', plan: plan({ status: 'EXECUTED' }) }).label).toBe(
      'Executed',
    );
    expect(
      statusPill({ status: 'ACCEPTED', plan: plan({ status: 'AWAITING_APPROVAL' }) }).label,
    ).toBe('Needs approval');
    expect(statusPill({ status: 'AUTO_EXECUTED', plan: plan({ status: 'QUEUED' }) }).label).toBe(
      'Executing',
    );
    expect(statusPill({ status: 'INFO', plan: plan({ status: 'REFUSED' }) }).label).toBe('Refused');
    expect(statusPill({ status: 'INFO', plan: null }).label).toBe('For your information');
  });

  it('formats a countdown and never goes negative', () => {
    expect(countdown(90_000)).toBe('1:30');
    expect(countdown(-5)).toBe('0:00');
  });

  it('reads brief bullets from a model or a template', () => {
    expect(briefLines('- One\n\n  - Two\nThree')).toEqual(['One', 'Two', 'Three']);
  });

  it('the zone list always contains the current zone', () => {
    expect(timeZones('Not/Listed')[0]).toBe('Not/Listed');
    expect(timeZones('Asia/Kolkata')).toContain('UTC');
    expect(new Set(timeZones('UTC')).size).toBe(timeZones('UTC').length);
  });

  it('detector and plan events refresh the inbox; a RED detector event toasts', () => {
    const event = (kind: string, title: string, data?: unknown) =>
      ({ id: '1', traceId: 't', userId: 'u', ts: ISO(0), kind, title, data }) as TraceEvent;
    expect(changesSuggestions(event('detector', 'x'))).toBe(true);
    expect(changesSuggestions(event('approval', 'x'))).toBe(true);
    expect(changesSuggestions(event('tool_call', 'x'))).toBe(false);
    expect(toastKind(event('detector', 'ETH -6%', { severity: 'RED' }))).toBe('red');
    expect(toastKind(event('detector', 'Dip', { severity: 'NORMAL' }))).toBeNull();
    // A detector run is not left spinning in the live activity.
    expect(runStatus([event('detector', 'Dip')])).toBe('info');
    expect(runStatus([event('detector', 'Suggestion expired')])).toBe('cancelled');
    expect(runStatus([event('policy', 'Declined by you')])).toBe('cancelled');
  });
});

describe('SuggestionRow', () => {
  const list = (s: SuggestionView) => (
    <ul>
      <SuggestionRow s={s} />
    </ul>
  );

  it('shows the message, plan summary and who approves', () => {
    renderUi(list(suggestion()));
    expect(screen.getByText('ETH dipped 11%: buy $20.00')).toBeInTheDocument();
    expect(screen.getByText('$20.00')).toBeInTheDocument();
    expect(screen.getByText('Trade 92/100')).toBeInTheDocument();
    expect(screen.getByText('You, one tap')).toBeInTheDocument();
    expect(screen.getByText('Waiting for you')).toBeInTheDocument();
    expect(screen.getByText(/left$/)).toBeInTheDocument();
    for (const name of ['Yes', 'Change', 'No'])
      expect(screen.getByRole('button', { name })).toBeEnabled();
    expect(screen.queryByText('Simulated (demo)')).not.toBeInTheDocument();
  });

  it('marks red alerts and demo events apart from the rest', () => {
    renderUi(list(suggestion({ severity: 'RED', simulated: true, actions: ['yes', 'no'] })));
    expect(screen.getByText('Red alert')).toBeInTheDocument();
    expect(screen.getByText('Simulated (demo)')).toBeInTheDocument();
    expect(screen.getByRole('listitem', { name: /ETH dipped/ }).className).toContain('border-l');
    expect(screen.queryByRole('button', { name: 'Change' })).not.toBeInTheDocument();
  });

  it('a step-up says a fresh human check is needed', () => {
    renderUi(list(suggestion({ plan: plan({ approver: 'verified_human' }) })));
    expect(screen.getByText('Fresh human check')).toBeInTheDocument();
  });

  it('Yes accepts', async () => {
    const ui = renderUi(list(suggestion()), {
      responses: { '/suggestions/s1/accept': actionResponse('EXECUTING') },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(calledWith(ui.fetchMock, '/suggestions/s1/accept')).toBe(true));
  });

  it('No declines', async () => {
    const ui = renderUi(list(suggestion()), {
      responses: { '/suggestions/s1/decline': actionResponse('DECLINED') },
    });
    await userEvent.click(screen.getByRole('button', { name: 'No' }));
    await waitFor(() => expect(calledWith(ui.fetchMock, '/suggestions/s1/decline')).toBe(true));
  });

  it('Change closes it, fills the chat and goes to the cockpit', async () => {
    const ui = renderUi(list(suggestion()), {
      route: '/inbox',
      responses: {
        '/suggestions/s1/change': actionResponse('CHANGED', { prefill: 'Swap $20 USDC to ETH' }),
      },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Change' }));
    await waitFor(() => expect(ui.location()).toBe('/ask'));
    const sub = subscribePrefill(() => undefined);
    expect(sub.initial).toBe('Swap $20 USDC to ETH');
    sub.unsubscribe();
    consumePrefill();
  });

  it('an expired row stops offering the choice before the server does', () => {
    renderUi(list(suggestion({ expiresAt: ISO(-1000) })));
    expect(screen.getByRole('button', { name: 'Yes' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'No' })).toBeDisabled();
  });

  it('a finished row shows the note and the transaction, and no buttons', () => {
    renderUi(
      list(
        suggestion({
          status: 'AUTO_EXECUTED',
          actions: [],
          expiresAt: null,
          note: 'Done.',
          plan: plan({
            status: 'EXECUTED',
            tx: { hash: '0xabc', explorerUrl: 'https://sepolia.etherscan.io/tx/0xabc' },
          }),
        }),
      ),
    );
    expect(screen.getByText('Done.')).toBeInTheDocument();
    expect(screen.getByText('Executed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Transaction/ })).toHaveAttribute(
      'href',
      'https://sepolia.etherscan.io/tx/0xabc',
    );
    expect(screen.queryByRole('button', { name: 'Yes' })).not.toBeInTheDocument();
  });

  it('Details opens the plan drawer', async () => {
    const ui = renderUi(list(suggestion()));
    await userEvent.click(screen.getByRole('button', { name: /Open plan details/ }));
    await waitFor(() => expect(ui.location()).toContain('plan=plan1'));
  });

  it('carries the 0G badge when 0G wrote it', () => {
    renderUi(
      list(
        suggestion({
          zg: { requestId: 'req1', clientRequestId: 'c', model: 'm', trustMode: 'private' },
        }),
      ),
    );
    expect(screen.getByText('0G verified')).toHaveAttribute('title', '0G request req1');
  });
});

describe('Inbox page', () => {
  const response = (over: Partial<SuggestionsResponse> = {}): SuggestionsResponse => ({
    brief: null,
    suggestions: [],
    openCount: 0,
    ...over,
  });
  const approvals = { approvals: [], devApproveAvailable: true };

  it('pins the morning brief above everything', async () => {
    const brief = suggestion({
      detector: 'MORNING_BRIEF',
      severity: 'INFO',
      status: 'INFO',
      title: 'Morning brief',
      message: '- Portfolio: $100.\n- ETH: $2,500.',
      plan: null,
      actions: [],
    });
    renderUi(<DecisionsTab />, {
      responses: {
        '/suggestions': response({ brief, suggestions: [suggestion()], openCount: 1 }),
        '/approvals/pending': approvals,
      },
    });
    const pinned = await screen.findByText('Portfolio: $100.');
    expect(screen.getByText('ETH: $2,500.')).toBeInTheDocument();
    const item = await screen.findByRole('listitem', { name: /ETH dipped/ });
    expect(pinned.compareDocumentPosition(item) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText('1 open')).toBeInTheDocument();
  });

  it('has an empty state', async () => {
    renderUi(<DecisionsTab />, {
      responses: { '/suggestions': response(), '/approvals/pending': approvals },
    });
    expect(await screen.findByText('No suggestions yet')).toBeInTheDocument();
  });

  it('BriefCard stands alone', () => {
    renderUi(
      <BriefCard
        brief={suggestion({
          title: 'Morning brief',
          message: '- Only line',
          simulated: true,
          actions: [],
        })}
      />,
    );
    expect(screen.getByText('Only line')).toBeInTheDocument();
    expect(screen.getByText('Simulated (demo)')).toBeInTheDocument();
  });
});

describe('suggestion card in the chat', () => {
  const card = (over: Partial<SuggestionCard> = {}): SuggestionCard => ({
    type: 'suggestion',
    suggestionId: 's1',
    detector: 'DIP',
    severity: 'NORMAL',
    title: 'ETH dipped',
    message: 'Buy the dip?',
    actions: ['yes', 'change', 'no'],
    status: 'OPEN',
    ...over,
  });

  it('offers the choice while open, and acts on it', async () => {
    const ui = renderUi(<SuggestionCardView card={card({ amountUsd: '20.00' })} />, {
      responses: { '/suggestions/s1/accept': actionResponse('EXECUTING') },
    });
    expect(screen.getByText('$20.00')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Yes' }));
    await waitFor(() => expect(calledWith(ui.fetchMock, '/suggestions/s1/accept')).toBe(true));
  });

  it('a closed card keeps its history but offers nothing', () => {
    renderUi(<SuggestionCardView card={card({ status: 'DECLINED', actions: [] })} />);
    expect(screen.getByText('Declined')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Yes' })).not.toBeInTheDocument();
  });

  it('a red alert says so', () => {
    renderUi(<SuggestionCardView card={card({ severity: 'RED', simulated: true, actions: [] })} />);
    expect(screen.getByText('Red alert')).toBeInTheDocument();
    expect(screen.getByText('Simulated (demo)')).toBeInTheDocument();
  });
});

describe('alert settings', () => {
  const settings = (over: Partial<SettingsResponse> = {}): SettingsResponse => ({
    riskProfile: 'BALANCED',
    limits: null,
    wallet: null,
    timezone: 'Asia/Kolkata',
    telegram: { available: true, linked: false, muted: false, botUsername: 'warden_bot' },
    autoAct: { DIP: true, PROFIT: true, IDLE_USDC: true, BETTER_POOL: false, OUT_OF_RANGE: false },
    ...over,
  });

  it('connect opens the bot link and waits', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const url = 'https://t.me/warden_bot?start=abc';
    renderUi(<AlertSettings />, {
      responses: {
        '/telegram/link-code': { url, expiresAt: ISO(600_000) },
        '/settings': settings(),
      },
    });
    await userEvent.click(await screen.findByRole('button', { name: 'Connect Telegram' }));
    await waitFor(() => expect(open).toHaveBeenCalledWith(url, '_blank', 'noopener'));
    expect(await screen.findByRole('link', { name: /Open Telegram/ })).toHaveAttribute('href', url);
    expect(screen.getByText(/Waiting for you to press Start/)).toBeInTheDocument();
  });

  it('linked: disconnect and mute', async () => {
    const ui = renderUi(<AlertSettings />, {
      responses: {
        '/settings': settings({
          telegram: { available: true, linked: true, muted: false, botUsername: 'warden_bot' },
        }),
      },
    });
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('@warden_bot')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('switch', { name: 'Mute Telegram alerts' }));
    await waitFor(() => expect(calledWith(ui.fetchMock, '/telegram/mute')).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(calledWith(ui.fetchMock, '/telegram/disconnect')).toBe(true));
  });

  it('says so when the server has no bot', async () => {
    renderUi(<AlertSettings />, {
      responses: {
        '/settings': settings({
          telegram: { available: false, linked: false, muted: false, botUsername: null },
        }),
      },
    });
    expect(await screen.findByText(/not set up on this server/)).toBeInTheDocument();
  });

  it('auto-act toggles show the defaults and save one detector at a time', async () => {
    const ui = renderUi(<AlertSettings />, { responses: { '/settings': settings() } });
    const dip = await screen.findByRole('switch', { name: 'Auto-act: Dip buys' });
    expect(dip).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('switch', { name: 'Auto-act: Better pool' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await userEvent.click(dip);
    await waitFor(() => {
      const call = ui.fetchMock.mock.calls.find(([u]) => String(u).includes('/settings/auto-act'));
      expect(JSON.parse(String((call?.[1] as RequestInit).body))).toEqual({ DIP: false });
    });
    expect(screen.getByText(/Hook pools are never rebalanced/)).toBeInTheDocument();
  });

  it('the time zone saves on change', async () => {
    const ui = renderUi(<AlertSettings />, { responses: { '/settings': settings() } });
    const select = await screen.findByLabelText('Your time zone');
    expect(select).toHaveValue('Asia/Kolkata');
    await userEvent.selectOptions(
      select,
      within(select).getByRole('option', { name: 'UTC' }) as HTMLOptionElement,
    );
    await waitFor(() => expect(calledWith(ui.fetchMock, '/settings/timezone')).toBe(true));
  });
});
