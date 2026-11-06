/**
 * Stateful mock of the Warden API for the Playwright smoke (PHASE 06 §7). A real HTTP server so
 * `/stream` stays open and pushes trace events like the live API. Every JSON response is
 * validated with the shared Zod schemas, so the mock cannot drift from the real contract.
 *
 * Behaviour by request text:
 *   "swap $N" with N ≤ 25  → AUTO preview (3 s countdown) → executes → receipt in place → 0G log
 *   "swap $N" with N > 25  → approval card (dev approve / reject)
 *   "swap $N" with N ≥ 500 → refused (price impact) with a corrected request
 *   "is … safe"            → token check info card
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import {
  AgentMessagesResponseSchema,
  CardSchema,
  DecisionLogViewSchema,
  HookDetailSchema,
  HookListResponseSchema,
  PriceOverridesResponseSchema,
  TriggersResponseSchema,
  MeResponseSchema,
  PendingApprovalsResponseSchema,
  PlanListResponseSchema,
  PlanViewSchema,
  PortfolioResponseSchema,
  ProvidersResponseSchema,
  SettingsResponseSchema,
  SuggestionActionResponseSchema,
  SuggestionsResponseSchema,
  TraceEventsResponseSchema,
  type AgentMessageView,
  type Card,
  type PlanListItem,
  type PlanView,
  type SuggestionView,
  type TraceEvent,
} from '../../../packages/shared/src/index.ts';

const ETH = '0x0000000000000000000000000000000000000000';
const USDC = '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238';
const ROUTER = '0x3A9D48AB9751398BbFa63ad67599Bb04e4BdF98b';
const ETH_USD = 2500;

const hex = (n: number) => `0x${randomUUID().replace(/-/g, '').repeat(2).slice(0, n)}`;
const zg = (model = 'glm-5.3') => ({
  requestId: randomUUID(),
  clientRequestId: randomUUID(),
  model,
  trustMode: 'private' as const,
  teeVerified: true,
});

interface Plan {
  view: PlanView;
  item: PlanListItem;
  approvalId?: string;
}

export interface MockApi {
  url: string;
  close(): Promise<void>;
}

export async function startMockApi(port: number): Promise<MockApi> {
  const now = () => new Date().toISOString();
  const user = {
    id: 'user_demo',
    displayName: 'Ayush',
    identityKind: 'dev' as const,
    verifiedAt: now(),
    lastAuthAt: now(),
    timezone: 'Asia/Kolkata',
    riskProfile: 'BALANCED' as const,
    onboardingStep: 'DONE' as const,
    telegramLinked: false,
    createdAt: now(),
  };
  const messages: AgentMessageView[] = []; // newest first
  const events: TraceEvent[] = [];
  const plans = new Map<string, Plan>();
  const clients = new Set<ServerResponse>();
  let spentToday = 0;

  const emit = (traceId: string, e: Omit<TraceEvent, 'id' | 'ts' | 'traceId' | 'userId'>) => {
    const ev = { id: randomUUID(), ts: now(), traceId, userId: user.id, ...e } as TraceEvent;
    events.push(ev);
    for (const c of clients) c.write(`id: ${ev.id}\nevent: trace\ndata: ${JSON.stringify(ev)}\n\n`);
  };
  const say = (traceId: string, role: 'USER' | 'AGENT', text: string, cards: Card[] = []) => {
    for (const c of cards) CardSchema.parse(c);
    messages.unshift({ id: randomUUID(), role, text, cards, traceId, createdAt: now() });
  };
  const patchCards = (planId: string, f: (c: Card) => Card | null) => {
    for (const m of messages)
      m.cards = (m.cards ?? []).map((c) => {
        const card = c as Card;
        return 'actionPlanId' in card && card.actionPlanId === planId ? (f(card) ?? card) : card;
      });
  };

  const quoteFor = (usd: number) => {
    const eth = (usd / ETH_USD).toFixed(6);
    return {
      amountIn: { symbol: 'ETH', address: ETH, amount: eth, decimals: 18 },
      amountOut: { symbol: 'USDC', address: USDC, amount: (usd * 0.997).toFixed(2), decimals: 6 },
      priceImpactPct: usd >= 500 ? 7.2 : 0.08,
      gasUsd: '0.04',
      route: '[V4] 100.00% = ETH -- 0.3% [0x3390c733]USDC',
      slippagePct: 0.5,
    } as const;
  };

  const checksFor = (usd: number, guardOk = true) => ({
    breakdown: [
      {
        rule: 'price_impact',
        penalty: usd >= 500 ? -70 : 0,
        evidence: `Price impact ${usd >= 500 ? '7.2' : '0.08'}%`,
      },
      {
        rule: 'size_vs_portfolio',
        penalty: usd > 50 ? -10 : 0,
        evidence: `${Math.round((usd / 230) * 100)}% of your portfolio`,
      },
      { rule: 'gas_vs_value', penalty: 0, evidence: 'Gas ≈ $0.04 (0.8% of the value)' },
    ],
    simulation: { ok: true, simulated: 1, deferred: 0 },
    guard: guardOk
      ? {
          verdict: 'approve' as const,
          pApprove: 0.96,
          reason: 'Safety checks passed.',
          unavailable: false,
          zg: zg('vela-2.0-9b'),
        }
      : {
          verdict: 'block' as const,
          pApprove: 0.12,
          reason: 'Price impact far above the limit.',
          unavailable: false,
          zg: zg('vela-2.0-9b'),
        },
  });

  function newPlan(
    traceId: string,
    text: string,
    usd: number,
    policy: PlanView['policyOutcome'],
    status: PlanView['status'],
    reasons: PlanView['policyReasons'],
  ): Plan {
    const id = `plan_${randomUUID().slice(0, 8)}`;
    const q = quoteFor(usd);
    const checks = checksFor(usd, policy !== 'REFUSE');
    const score = 100 + checks.breakdown.reduce((a, b) => a + b.penalty, 0);
    const intent = {
      type: 'swap_exact_in' as const,
      tokenIn: { symbol: 'ETH' },
      tokenOut: { symbol: 'USDC' },
      amountIn: q.amountIn.amount,
      amountUsd: String(usd),
      reason: 'User asked to swap',
    };
    const view: PlanView = PlanViewSchema.parse({
      id,
      status,
      summary: `swap $${usd} ETH → USDC`,
      intent,
      planHash: hex(64),
      amountUsd: usd.toFixed(2),
      steps: [{ label: 'Swap via Uniswap Universal Router', kind: 'swap' }],
      quote: q,
      tradeScore: score,
      tradeScoreBreakdown: checks.breakdown,
      hook: null,
      simulation: { ok: true, steps: [{ index: 0, ok: true, gasEstimate: '182000' }] },
      guard: checks.guard,
      policyOutcome: policy,
      policyReasons: reasons,
      approval: null,
      executions: [],
      decisionLog: null,
      traceId,
      requestText: text,
      calls: [
        {
          kind: 'SWAP',
          description: 'Swap via Uniswap Universal Router',
          to: ROUTER,
          selector: '0x3593564c',
          valueWei: '2000000000000000',
        },
      ],
      inferences: [
        {
          role: 'PLANNER',
          model: 'glm-5.3',
          trustMode: 'private',
          requestId: randomUUID(),
          teeVerified: true,
        },
        {
          role: 'GUARD',
          model: 'vela-2.0-9b',
          trustMode: 'private',
          requestId: randomUUID(),
          teeVerified: true,
        },
      ],
      createdAt: now(),
      updatedAt: now(),
    });
    const item: PlanListItem = {
      id,
      createdAt: view.createdAt,
      traceId,
      requestText: text,
      type: 'swap_exact_in',
      summary: view.summary,
      amountUsd: view.amountUsd,
      status,
      outcome: status === 'REFUSED' ? 'REFUSED' : 'PENDING',
      policyOutcome: policy,
      approvedBy: null,
      tradeScore: score,
      tx: null,
      decisionLog: null,
    };
    const plan = { view, item };
    plans.set(id, plan);
    return plan;
  }

  function planningEvents(traceId: string, text: string) {
    emit(traceId, { kind: 'plan', title: 'Planning on 0G' });
    emit(traceId, {
      kind: 'plan',
      title: '0G planner',
      detail: 'glm-5.3 · private · 2900 ms',
      zg: zg(),
    });
    emit(traceId, {
      kind: 'tool_call',
      title: 'Uniswap · get_quote',
      detail: `${text} on chain 11155111`,
      data: { tool: 'get_quote' },
    });
    emit(traceId, {
      kind: 'tool_result',
      title: 'Uniswap · get_quote',
      detail: 'Quote on chain 11155111 via [v4] 0.3% pool',
      data: { tool: 'get_quote' },
    });
  }

  async function execute(plan: Plan, approvedBy: 'AGENT' | 'HUMAN') {
    const { id, traceId } = { id: plan.view.id, traceId: plan.view.traceId };
    plan.view.status = 'EXECUTING';
    patchCards(id, (c) => (c.type === 'preview' ? { ...c, status: 'EXECUTING' } : null));
    emit(traceId, {
      kind: 'tx',
      title: 'Executing',
      detail: 'Within your limits — no approval needed.',
      data: { actionPlanId: id },
    });
    await wait(700);
    const tx = hex(64);
    const explorerUrl = `https://sepolia.etherscan.io/tx/${tx}`;
    emit(traceId, {
      kind: 'tx',
      title: 'Sent: Swap via Uniswap Universal Router',
      detail: `${tx} on Ethereum Sepolia`,
      data: { txHash: tx, explorerUrl },
    });
    await wait(700);
    emit(traceId, {
      kind: 'receipt',
      title: 'Confirmed in block 7341209',
      data: { txHash: tx, status: 'CONFIRMED' },
    });
    plan.view.status = 'EXECUTED';
    plan.view.executions = [
      {
        id: randomUUID(),
        stepIndex: 0,
        kind: 'SWAP',
        status: 'CONFIRMED',
        txHash: tx,
        explorerUrl,
        usdValue: plan.view.amountUsd,
        approvedBy,
        error: null,
        createdAt: now(),
      },
    ];
    plan.item = {
      ...plan.item,
      status: 'EXECUTED',
      outcome: 'EXECUTED',
      approvedBy,
      tx: { hash: tx, explorerUrl },
    };
    if (approvedBy === 'AGENT') spentToday += Number(plan.view.amountUsd);
    patchCards(id, (c) => (c.type === 'preview' ? { ...c, status: 'EXECUTED' } : null));
    say(traceId, 'AGENT', `Done: ${plan.view.summary}.`, [
      {
        type: 'receipt',
        actionPlanId: id,
        title: `Done: ${plan.view.summary}`,
        summary: '1 transaction(s) confirmed. The decision record is being written to 0G Storage.',
        amountUsd: plan.view.amountUsd,
        approvedBy,
        txs: [{ hash: tx, kind: 'swap', explorerUrl, status: 'CONFIRMED' }],
        ...(plan.view.quote ? { quote: plan.view.quote } : {}),
        inferences: plan.view.inferences,
        completedAt: now(),
        decisionLog: { status: 'PENDING' },
      },
    ]);
    emit(traceId, {
      kind: 'receipt',
      title: `Done: ${plan.view.summary}`,
      data: { actionPlanId: id },
    });
    await wait(900);
    logged(plan);
  }

  function logged(plan: Plan) {
    const rootHash = hex(64);
    const txHash = hex(64);
    const ref = {
      status: 'UPLOADED' as const,
      rootHash,
      txHash,
      explorerUrl: `https://chainscan-galileo.0g.ai/tx/${txHash}`,
    };
    plan.view.decisionLog = ref;
    plan.item.decisionLog = ref;
    patchCards(plan.view.id, (c) =>
      c.type === 'receipt' || c.type === 'refusal' || c.type === 'failure'
        ? { ...c, decisionLog: ref }
        : null,
    );
    emit(plan.view.traceId, {
      kind: 'log',
      title: 'Logged to 0G Storage',
      detail: `Root hash ${rootHash}`,
      data: { rootHash, explorerUrl: ref.explorerUrl },
    });
  }

  async function handleMessage(text: string, traceId: string) {
    await wait(500);
    planningEvents(traceId, text);
    await wait(700);
    const planner = zg();
    if (/safe/i.test(text)) {
      emit(traceId, {
        kind: 'tool_call',
        title: 'Uniswap · check_token',
        data: { tool: 'check_token' },
      });
      say(
        traceId,
        'AGENT',
        'USDC is on the allowlist, not on the Uniswap unsupported list, and has deep liquidity. Looks safe.',
        [
          { type: 'info', title: 'Agent reply', body: 'x', zg: planner },
          {
            type: 'info',
            title: 'Token check · USDC',
            body: 'USDC passed the token checks.',
            data: {
              kind: 'token_check',
              chainId: 11155111,
              symbol: 'USDC',
              name: 'USD Coin',
              address: USDC,
              isNative: false,
              verdict: 'OK',
              onAllowlist: true,
              onUniswapUnsupportedList: false,
              liquidityDepthUsd: '1840000',
              riskFlags: [],
            },
            marketDataSource: 'execution',
          },
        ],
      );
      emit(traceId, { kind: 'plan', title: 'Agent reply', zg: planner });
      return;
    }
    const usd = Number(/\$\s*([\d.]+)/.exec(text)?.[1] ?? '5');
    const intentCard = {
      type: 'intent' as const,
      intent: {
        type: 'swap_exact_in' as const,
        tokenIn: { symbol: 'ETH' },
        tokenOut: { symbol: 'USDC' },
        amountIn: (usd / ETH_USD).toFixed(6),
        amountUsd: String(usd),
        reason: 'User asked to swap',
      },
      zg: planner,
    };
    emit(traceId, { kind: 'score', title: `Trade safety score ${usd >= 500 ? 30 : 100}/100` });
    emit(traceId, {
      kind: 'simulation',
      title: 'Simulation passed',
      detail: '1 step(s) simulated on the latest block',
    });
    emit(traceId, {
      kind: 'guard',
      title: usd >= 500 ? 'Guard blocked (p=0.12)' : 'Guard approved (p=0.96)',
      zg: zg('vela-2.0-9b'),
    });

    if (usd >= 500) {
      const reasons = [
        {
          code: 'PRICE_IMPACT_TOO_HIGH' as const,
          message: 'Price impact 7.2% is above the 5% hard limit',
          value: 7.2,
          limit: 5,
        },
      ];
      const plan = newPlan(traceId, text, usd, 'REFUSE', 'REFUSED', reasons);
      emit(traceId, {
        kind: 'policy',
        title: 'Policy: refused',
        detail: reasons[0]!.message,
        data: { actionPlanId: plan.view.id },
      });
      say(traceId, 'AGENT', `I did not do this: ${reasons[0]!.message}.`, [
        intentCard,
        {
          type: 'refusal',
          actionPlanId: plan.view.id,
          title: `Refused: swap $${usd} ETH → USDC`,
          summary:
            'This trade would move the pool price by 7.2% — you would lose far more than the 5% your agent allows.',
          reasons,
          tradeScore: plan.view.tradeScore!,
          suggestion: 'Try a smaller amount, or a pair with deeper liquidity.',
          suggestedRequest: `Swap $${usd / 2} ETH to USDC`,
          quote: plan.view.quote!,
          checks: checksFor(usd, false),
          decisionLog: { status: 'PENDING' },
          zg: planner,
        },
      ]);
      setTimeout(() => logged(plan), 900);
      return;
    }

    if (usd > 25) {
      const reasons = [
        {
          code: 'OVER_PER_ACTION_LIMIT' as const,
          message: 'Over your $25 per-action limit',
          value: usd,
          limit: 25,
        },
      ];
      const plan = newPlan(traceId, text, usd, 'STEP_UP', 'AWAITING_APPROVAL', reasons);
      const approvalId = `appr_${randomUUID().slice(0, 8)}`;
      plan.approvalId = approvalId;
      const expiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
      plan.view.approval = {
        id: approvalId,
        actionPlanId: plan.view.id,
        status: 'PENDING',
        reason: reasons[0]!.message,
        amountUsd: plan.view.amountUsd,
        planHash: plan.view.planHash,
        channel: 'WEB',
        providerKind: 'dev',
        expiresAt,
        resolvedAt: null,
        authTime: null,
        summary: plan.view.summary,
        devApproveAvailable: true,
      };
      emit(traceId, {
        kind: 'policy',
        title: 'Policy: needs your approval',
        detail: reasons[0]!.message,
        data: { actionPlanId: plan.view.id },
      });
      emit(traceId, {
        kind: 'approval',
        title: 'Waiting for your approval',
        detail: reasons[0]!.message,
        data: { approvalId },
      });
      say(traceId, 'AGENT', `This needs your approval: ${reasons[0]!.message}.`, [
        intentCard,
        {
          type: 'approval',
          approvalId,
          actionPlanId: plan.view.id,
          title: `Swap $${usd} ETH → USDC`,
          summary: plan.view.summary,
          reason: reasons[0]!.message,
          reasons,
          amountUsd: plan.view.amountUsd,
          quote: plan.view.quote!,
          tradeScore: plan.view.tradeScore!,
          status: 'PENDING',
          channel: 'WEB',
          providerKind: 'dev',
          expiresAt,
          checks: checksFor(usd),
          zg: planner,
        },
      ]);
      return;
    }

    const plan = newPlan(traceId, text, usd, 'AUTO', 'QUEUED', []);
    emit(traceId, {
      kind: 'policy',
      title: 'Policy: AUTO — your agent may do this alone',
      detail: 'Within your limits and safety thresholds',
      data: { actionPlanId: plan.view.id },
    });
    say(traceId, 'AGENT', `Agent will do this: ${plan.view.summary}.`, [
      intentCard,
      {
        type: 'preview',
        actionPlanId: plan.view.id,
        status: 'QUEUED',
        autoExecuteAt: new Date(Date.now() + 3000).toISOString(),
        title: `Swap $${usd} ETH → USDC`,
        summary: 'Within your limits and safety checks — your agent will do this in 3 s.',
        amountUsd: plan.view.amountUsd,
        quote: plan.view.quote!,
        steps: plan.view.steps,
        tradeScore: plan.view.tradeScore!,
        policyOutcome: 'AUTO',
        policyReasons: [],
        checks: checksFor(usd),
        zg: planner,
      },
    ]);
    setTimeout(() => {
      if (plan.view.status === 'QUEUED') void execute(plan, 'AGENT');
    }, 3300);
  }

  const portfolio = () =>
    PortfolioResponseSchema.parse({
      chainId: 11155111,
      address: '0xBB02Cfa69c391fb6238DcbEd4Af2BFb1eA40E69E',
      totalUsd: '231.40',
      tokens: [
        {
          symbol: 'ETH',
          address: ETH,
          decimals: 18,
          isNative: true,
          balanceRaw: '72000000000000000',
          balance: '0.072',
          priceUsd: '2500',
          valueUsd: '180.00',
          sharePct: '77.8',
          pnl: null,
        },
        {
          symbol: 'USDC',
          address: USDC,
          decimals: 6,
          isNative: false,
          balanceRaw: '51400000',
          balance: '51.4',
          priceUsd: '1',
          valueUsd: '51.40',
          sharePct: '22.2',
          pnl: null,
        },
      ],
      lpPositions: [],
      pnl: { totalUsd: '3.12', pct: '1.37', costBasisUsd: '228.28', perToken: [] },
      risk: {
        score: 38,
        label: 'Moderate',
        drivers: ['78% of your portfolio is in ETH'],
        factors: [],
      },
      limits: {
        perActionUsd: '25.00',
        perDayUsd: '100.00',
        usedTodayUsd: spentToday.toFixed(2),
        remainingTodayUsd: (100 - spentToday).toFixed(2),
        day: now().slice(0, 10),
        timezone: 'Asia/Kolkata',
      },
      priceSource: 'Uniswap API · Ethereum mainnet reference',
      unpriced: [],
      warnings: [],
      asOf: now(),
    });

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', ...cors });
    res.end(JSON.stringify(body));
  };
  const cors = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, accept',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  };
  const body = (req: IncomingMessage) =>
    new Promise<Record<string, unknown>>((resolve) => {
      let s = '';
      req.on('data', (d) => (s += d));
      req.on('end', () => resolve(s ? (JSON.parse(s) as Record<string, unknown>) : {}));
    });

  // Mode B: a pinned brief, a RED alert, an open dip buy and one that ran on its own.
  const zgProof = zg('0gm-1.0-35b-a3b');
  const base = {
    note: null,
    simulated: false,
    plan: null,
    prefill: null,
    actions: [],
    expiresAt: null,
    createdAt: now(),
    zg: zgProof,
  };
  const dipPlan: NonNullable<SuggestionView['plan']> = {
    id: 'plan-dip',
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
  };
  const brief: SuggestionView = {
    ...base,
    id: 'brief',
    detector: 'MORNING_BRIEF',
    severity: 'INFO',
    status: 'INFO',
    title: 'Morning brief',
    message:
      '- Portfolio: $2,600.00 (+1.2% in 24 h).\n- ETH: $2,500.00.\n- Risk: MEDIUM (mostly ETH).\n- 1 active rule.',
  };
  let suggestions: SuggestionView[] = [
    {
      ...base,
      id: 'red',
      detector: 'HOOK_CHANGED',
      severity: 'RED',
      status: 'OPEN',
      simulated: true,
      title: 'Hook 0xa0c0…0c0c changed',
      message: 'The owner of a hook you use changed. I suggest leaving the pool.',
      plan: {
        ...dipPlan,
        id: 'plan-exit',
        summary: 'exit 100% of position pos1',
        amountUsd: '110.00',
        tradeScore: 64,
        hookScore: 38,
        approver: 'verified_human',
      },
      prefill: 'Exit 100% of position pos1',
      actions: ['yes', 'change', 'no'],
      expiresAt: new Date(Date.now() + 14 * 60_000).toISOString(),
    },
    {
      ...base,
      id: 'dip',
      detector: 'DIP',
      severity: 'NORMAL',
      status: 'OPEN',
      title: 'ETH dipped 11.2%: buy $20.00',
      message: 'ETH is 11.2% below its 7-day high. I suggest buying $20 with USDC.',
      plan: dipPlan,
      prefill: 'Swap $20 USDC to ETH',
      actions: ['yes', 'change', 'no'],
      expiresAt: new Date(Date.now() + 11 * 60_000).toISOString(),
    },
    {
      ...base,
      id: 'auto',
      detector: 'PROFIT',
      severity: 'NORMAL',
      status: 'AUTO_EXECUTED',
      title: 'ETH is up 14%: sell 25%',
      message: 'Your ETH position is up 14%. Your agent sold 25% within your limits.',
      note: 'Done.',
      plan: {
        ...dipPlan,
        id: 'plan-profit',
        summary: 'swap 0.008 ETH → USDC',
        status: 'EXECUTED',
        policyOutcome: 'AUTO',
        approver: 'agent',
        tx: { hash: hex(64), explorerUrl: `https://sepolia.etherscan.io/tx/${hex(64)}` },
      },
    },
  ];
  const openCount = () => suggestions.filter((s) => s.status === 'OPEN').length;
  const settingsView = {
    riskProfile: 'BALANCED',
    limits: null,
    wallet: null,
    timezone: 'Asia/Kolkata',
    telegram: { available: true, linked: false, muted: false, botUsername: 'warden_agent_bot' },
    autoAct: { DIP: true, PROFIT: true, IDLE_USDC: true, BETTER_POOL: false, OUT_OF_RANGE: false },
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    const p = url.pathname;
    try {
      if (req.method === 'OPTIONS') return void (res.writeHead(204, cors), res.end());
      if (p === '/auth/providers')
        return send(
          res,
          200,
          ProvidersResponseSchema.parse({
            appName: 'SAKA',
            identity: 'dev',
            approvals: 'dev',
            executionChainId: 11155111,
          }),
        );
      if (p === '/me') return send(res, 200, MeResponseSchema.parse({ user }));
      if (p === '/portfolio') return send(res, 200, portfolio());
      if (p === '/settings') return send(res, 200, SettingsResponseSchema.parse(settingsView));
      if (p === '/suggestions')
        return send(
          res,
          200,
          SuggestionsResponseSchema.parse({ brief, suggestions, openCount: openCount() }),
        );
      const act = /^\/suggestions\/([^/]+)\/(accept|decline|change)$/.exec(p);
      if (act && req.method === 'POST') {
        const [, id, verb] = act;
        const accepted = verb === 'accept';
        suggestions = suggestions.map((s) =>
          s.id === id
            ? { ...s, status: accepted ? 'ACCEPTED' : 'DECLINED', actions: [], expiresAt: null }
            : s,
        );
        const suggestion = suggestions.find((s) => s.id === id)!;
        return send(
          res,
          200,
          SuggestionActionResponseSchema.parse({
            result: accepted ? 'EXECUTING' : verb === 'change' ? 'CHANGED' : 'DECLINED',
            message: accepted ? 'Your agent is doing it now.' : 'You said no.',
            approvalId: null,
            prefill: verb === 'change' ? suggestion.prefill : null,
            suggestion,
          }),
        );
      }
      if (p === '/approvals/pending')
        return send(
          res,
          200,
          PendingApprovalsResponseSchema.parse({
            approvals: [...plans.values()]
              .filter((x) => x.view.approval?.status === 'PENDING')
              .map((x) => ({
                id: x.view.approval!.id,
                actionPlanId: x.view.id,
                summary: x.view.summary,
                reason: x.view.approval!.reason,
                amountUsd: x.view.amountUsd,
                expiresAt: x.view.approval!.expiresAt,
                providerKind: 'dev',
                channel: 'WEB',
                createdAt: x.view.createdAt,
              })),
            devApproveAvailable: true,
          }),
        );
      if (p === '/triggers') return send(res, 200, TriggersResponseSchema.parse({ triggers: [] }));
      if (p === '/price-overrides')
        return send(res, 200, PriceOverridesResponseSchema.parse({ overrides: [] }));
      if (p === '/hooks') {
        const scope = url.searchParams.get('scope') ?? 'market';
        const list = scope === 'market' ? HOOKS : [];
        return send(
          res,
          200,
          HookListResponseSchema.parse({
            scope,
            chainId: scope === 'market' ? 1 : 11155111,
            hooks: list,
            total: list.length,
            nextCursor: null,
            indexedAt: now(),
          }),
        );
      }
      const hm = /^\/hooks\/(\d+)\/(0x[0-9a-fA-F]{40})$/.exec(p);
      if (hm) {
        const h = HOOKS.find((x) => x.address.toLowerCase() === hm[2]!.toLowerCase());
        if (!h)
          return send(res, 404, {
            error: { code: 'NOT_FOUND', message: 'This hook has not been indexed yet.' },
          });
        return send(
          res,
          200,
          HookDetailSchema.parse({
            ...h,
            breakdown:
              h.score < 80
                ? [
                    {
                      rule: 'return_delta_permissions',
                      penalty: -25,
                      evidence: 'Enabled: beforeSwapReturnDelta (CRITICAL)',
                      source: '[F] §1',
                    },
                  ]
                : [],
            permissionGrid: [
              'beforeInitialize',
              'afterInitialize',
              'beforeAddLiquidity',
              'afterAddLiquidity',
              'beforeRemoveLiquidity',
              'afterRemoveLiquidity',
              'beforeSwap',
              'afterSwap',
              'beforeDonate',
              'afterDonate',
              'beforeSwapReturnDelta',
              'afterSwapReturnDelta',
              'afterAddLiquidityReturnDelta',
              'afterRemoveLiquidityReturnDelta',
            ].map((flag) => {
              const on = h.permissions.find((x) => x.flag === flag);
              return { flag, enabled: Boolean(on), risk: on?.risk ?? null };
            }),
            facts: {
              proxyKind: null,
              upgradeable: false,
              implementation: null,
              owner: '0x1111111111111111111111111111111111111111',
              verifiedSource: false,
              codeHash: hex(64),
              contractName: h.name,
              adminSelectors: [],
            },
            frameworkTier: 'Medium',
            snapshots: [
              {
                takenAt: now(),
                score: h.score,
                band: h.band,
                codeHash: null,
                implementation: null,
                owner: null,
                changes:
                  h.score < 80 ? ['Owner changed to 0x1111…1111', 'Score 72 → ' + h.score] : [],
              },
            ],
          }),
        );
      }
      if (p === '/stream') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          ...cors,
        });
        res.write('retry: 3000\n\n');
        for (const ev of events.slice(-150))
          res.write(`id: ${ev.id}\nevent: trace\ndata: ${JSON.stringify(ev)}\n\n`);
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (p === '/agent/messages' && req.method === 'GET')
        return send(res, 200, AgentMessagesResponseSchema.parse({ messages, nextCursor: null }));
      if (p === '/agent/messages' && req.method === 'POST') {
        const { text } = (await body(req)) as { text: string };
        const traceId = randomUUID();
        say(traceId, 'USER', text);
        void handleMessage(text, traceId);
        return send(res, 202, { agentRequestId: randomUUID(), traceId });
      }
      if (p === '/plans' && req.method === 'GET') {
        const outcome = url.searchParams.get('outcome');
        const list = [...plans.values()]
          .map((x) => x.item)
          .filter((i) => !outcome || i.outcome === outcome)
          .reverse();
        return send(res, 200, PlanListResponseSchema.parse({ plans: list, nextCursor: null }));
      }
      let m = /^\/plans\/([^/]+)$/.exec(p);
      if (m) {
        const plan = plans.get(m[1]!);
        return plan
          ? send(res, 200, PlanViewSchema.parse(plan.view))
          : send(res, 404, { error: { code: 'NOT_FOUND', message: 'Plan not found.' } });
      }
      m = /^\/plans\/([^/]+)\/cancel$/.exec(p);
      if (m) {
        const plan = plans.get(m[1]!)!;
        plan.view.status = 'CANCELLED';
        plan.item = { ...plan.item, status: 'CANCELLED', outcome: 'CANCELLED' };
        patchCards(plan.view.id, (c) =>
          c.type === 'preview' ? { ...c, status: 'CANCELLED' } : null,
        );
        emit(plan.view.traceId, {
          kind: 'policy',
          title: 'Cancelled by you',
          detail: 'Nothing was traded.',
          data: { actionPlanId: plan.view.id },
        });
        return send(res, 200, { id: plan.view.id, status: 'CANCELLED' });
      }
      m = /^\/approvals\/([^/]+)\/(deny|dev-approve)$/.exec(p);
      if (m) {
        const plan = [...plans.values()].find((x) => x.approvalId === m![1])!;
        const deny = m[2] === 'deny';
        plan.view.approval = {
          ...plan.view.approval!,
          status: deny ? 'DENIED' : 'USED',
          resolvedAt: now(),
          ...(deny ? {} : { authTime: now() }),
        };
        patchCards(plan.view.id, (c) =>
          c.type === 'approval' ? { ...c, status: deny ? 'DENIED' : 'USED' } : null,
        );
        emit(plan.view.traceId, {
          kind: 'approval',
          title: deny ? 'Denied' : 'Approved by you',
          detail: deny
            ? 'Denied — nothing was traded.'
            : 'Approved — your agent is executing it now.',
          data: { actionPlanId: plan.view.id },
        });
        if (deny) {
          plan.view.status = 'CANCELLED';
          plan.item = { ...plan.item, status: 'CANCELLED', outcome: 'DENIED' };
          say(plan.view.traceId, 'AGENT', 'Denied — nothing was traded.', [
            { type: 'info', title: 'Denied', body: 'Denied — nothing was traded.' },
          ]);
        } else void execute(plan, 'HUMAN');
        return send(res, 200, { id: plan.approvalId, status: deny ? 'DENIED' : 'APPROVED' });
      }
      m = /^\/traces\/([^/]+)\/events$/.exec(p);
      if (m)
        return send(
          res,
          200,
          TraceEventsResponseSchema.parse({
            traceId: m[1],
            events: events.filter((e) => e.traceId === m![1]),
          }),
        );
      m = /^\/decision-logs\/([^/]+)$/.exec(p);
      if (m) {
        const plan = plans.get(m[1]!);
        if (!plan?.view.decisionLog)
          return send(res, 404, {
            error: { code: 'NOT_FOUND', message: 'No decision log for this plan yet.' },
          });
        return send(
          res,
          200,
          DecisionLogViewSchema.parse({
            actionPlanId: plan.view.id,
            status: 'UPLOADED',
            payloadHash: hex(64),
            rootHash: plan.view.decisionLog.rootHash ?? null,
            txHash: plan.view.decisionLog.txHash ?? null,
            explorerUrl: plan.view.decisionLog.explorerUrl ?? null,
            attempts: 1,
            payload: {
              version: 1,
              app: 'Warden',
              chainId: 11155111,
              intent: plan.view.intent,
              planHash: plan.view.planHash,
              policy: { outcome: plan.view.policyOutcome, reasons: plan.view.policyReasons },
            },
          }),
        );
      }
      return send(res, 404, {
        error: { code: 'NOT_FOUND', message: `No mock for ${req.method} ${p}` },
      });
    } catch (err) {
      return send(res, 500, {
        error: {
          code: 'MOCK_ERROR',
          message: err instanceof Error ? err.message.slice(0, 500) : String(err),
        },
      });
    }
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((r) => {
        for (const c of clients) c.end();
        server.close(() => r());
      }),
  };
}

const HOOKS = [
  {
    chainId: 1,
    address: '0xE1C4c2a8B3a4F0aE1b2D3c4E5f60718293A428c8',
    name: 'DynamicFeeHook',
    score: 25,
    band: 'DANGER' as const,
    permissions: [
      { flag: 'beforeSwap', risk: 'HIGH' },
      { flag: 'beforeSwapReturnDelta', risk: 'CRITICAL' },
      { flag: 'beforeAddLiquidity', risk: 'MEDIUM' },
    ],
    pairs: [
      {
        poolId: `0x${'aa'.repeat(32)}`,
        token0: '0x0000000000000000000000000000000000000000',
        token1: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
        token0Symbol: 'ETH',
        token1Symbol: 'USDC',
        fee: 3000,
        tickSpacing: 60,
        tvlUsd: '48200',
      },
    ],
    poolCount: 1,
    tvlUsd: '48200',
    ageDays: 2,
    firstSeenAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
    explanation: {
      text: 'What it does: This hook sets dynamic fees and can override swap amounts. Why it matters to you: its owner can change fees at will and the code is unverified. Our verdict: DANGER, score 25.',
      model: 'glm-5.3',
      requestId: '06b45074-1c2d-4e5f-8a9b-0c1d2e3f4cdc',
      trustMode: 'private',
      teeVerified: true,
    },
    tradeable: false,
  },
  {
    chainId: 1,
    address: '0x5287E8915445aee78e10190559D8Dd21E0E9Ea88',
    name: 'LimitOrderHook',
    score: 86,
    band: 'SAFE' as const,
    permissions: [{ flag: 'afterSwap', risk: 'LOW' }],
    pairs: [
      {
        poolId: `0x${'bb'.repeat(32)}`,
        token0: '0x0000000000000000000000000000000000000000',
        token1: '0xdAC17F958D2ee523a2206206994597C13D831ec7',
        token0Symbol: 'ETH',
        token1Symbol: 'USDT',
        fee: 500,
        tickSpacing: 10,
        tvlUsd: '2140000',
      },
    ],
    poolCount: 3,
    tvlUsd: '2140000',
    ageDays: 41,
    firstSeenAt: new Date().toISOString(),
    lastCheckedAt: new Date().toISOString(),
    explanation: {
      text: 'What it does: Fills limit orders after swaps. Why it matters to you: it cannot change your swap amount or block withdrawals. Our verdict: SAFE, score 86.',
      model: 'glm-5.3',
      requestId: 'b978dd2e-0a1b-4c2d-9e8f-7a6b5c4dc0b1',
      trustMode: 'private',
      teeVerified: true,
    },
    tradeable: false,
  },
];

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
