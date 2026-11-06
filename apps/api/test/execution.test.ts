/**
 * PHASE 05 end to end (Postgres + Redis, everything external mocked): chat → 0G planner →
 * prepare → score → simulate → 0G guard → policy → approval → execution → receipt → 0G log.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { canonicalJson } from '../src/lib/canonical.js';
import {
  executePlan,
  PendingReceiptError,
  type ExecutorDeps,
} from '../src/modules/execution/executor.js';
import { uploadDecisionLog } from '../src/modules/decisionlog/service.js';
import { createTestApp, devSignIn, uniqueName } from './helpers.js';
import {
  createMarket,
  FakeChain,
  FakeStorage,
  FakeWallets,
  giveWallet,
  mintLog,
  POSITION_MANAGER,
  RecordingJobs,
  scriptedMcp,
  SCAM,
  USDC,
  ZG_ENV,
  zgRouter,
  type Market,
  type ZgScript,
} from './phase5-fakes.js';

afterEach(() => vi.unstubAllGlobals());

const swapUsd = (usd: number, eth = 2500) => ({
  type: 'swap_exact_in',
  tokenIn: { symbol: 'ETH' },
  tokenOut: { symbol: 'USDC' },
  amountIn: String(usd / eth),
  amountUsd: String(usd),
  reason: 'User asked to swap',
});

interface Harness {
  app: FastifyInstance;
  market: Market;
  jobs: RecordingJobs;
  chain: FakeChain;
  wallets: FakeWallets;
  script: ZgScript;
  token: string;
  userId: string;
  walletAddress: string;
  exec(planId: string): ReturnType<typeof executePlan>;
  ask(proposal: unknown): Promise<{
    planId: string | null;
    status: string;
    agentText: string;
    cards: Record<string, unknown>[];
  }>;
  close(): Promise<void>;
}

async function harness(env: Record<string, string> = {}): Promise<Harness> {
  const market = createMarket();
  const jobs = new RecordingJobs();
  const chain = new FakeChain();
  const wallets = new FakeWallets();
  const script: ZgScript = { proposals: [], guard: 'approve', decisions: 0 };
  vi.stubGlobal('fetch', vi.fn(zgRouter(script)));
  const app = await createTestApp(
    { ...ZG_ENV, AUTO_EXECUTE_DELAY_MS: '0', ...env },
    { mcp: scriptedMcp(market), jobs, chain, wallets },
  );
  const login = await devSignIn(app, uniqueName('phase5'));
  const wallet = await giveWallet(app.deps.prisma, login.user.id);
  const d = app.deps;
  const deps: ExecutorDeps = {
    env: d.env,
    prisma: d.prisma,
    redis: d.redis,
    mcp: d.mcp!,
    wallets,
    chain,
    traceBus: d.traceBus,
    jobs,
    approvals: d.approvals,
    approvalProvider: d.approvalProvider,
  };
  return {
    app,
    market,
    jobs,
    chain,
    wallets,
    script,
    token: login.token,
    userId: login.user.id,
    walletAddress: wallet.address,
    exec: (planId) => executePlan(deps, planId),
    async ask(proposal) {
      script.proposals = [proposal];
      const res = await app.inject({
        method: 'POST',
        url: '/agent/messages',
        headers: { authorization: `Bearer ${login.token}` },
        payload: { text: 'do it' },
      });
      expect(res.statusCode).toBe(202);
      const { agentRequestId } = res.json() as { agentRequestId: string };
      await vi.waitFor(
        async () => {
          const r = await d.prisma.agentRequest.findUniqueOrThrow({
            where: { id: agentRequestId },
          });
          expect(r.status).not.toBe('PLANNING');
          expect(await d.redis.get(`agent:planning:${login.user.id}`)).toBeNull();
        },
        { timeout: 15_000 },
      );
      const req = await d.prisma.agentRequest.findUniqueOrThrow({
        where: { id: agentRequestId },
        include: { actionPlans: true },
      });
      const msg = await d.prisma.chatMessage.findFirstOrThrow({
        where: { requestId: agentRequestId, role: 'AGENT' },
      });
      return {
        planId: req.actionPlans[0]?.id ?? null,
        status: req.status,
        agentText: msg.text,
        cards: (msg.cards as Record<string, unknown>[]) ?? [],
      };
    },
    close: () => app.close(),
  };
}

const auth = (h: Harness) => ({ authorization: `Bearer ${h.token}` });

describe('PHASE 05 pipeline + execution', () => {
  it('"Swap $5 ETH to USDC" → AUTO preview → executes → receipt → 0G Storage root hash', async () => {
    const h = await harness();
    try {
      const r = await h.ask(swapUsd(5));
      expect(r.status).toBe('QUEUED');
      const preview = r.cards.find((c) => c.type === 'preview')!;
      expect(preview).toMatchObject({
        policyOutcome: 'AUTO',
        status: 'QUEUED',
        amountUsd: '5.00',
        tradeScore: 100,
      });
      expect(preview.autoExecuteAt).toBeTypeOf('string');
      expect(r.cards[0]).toMatchObject({ type: 'intent' });
      expect(h.jobs.executions).toEqual([{ planId: r.planId, delayMs: 0 }]);
      expect(h.script.decisions).toBe(1);
      // Nothing was sent before the job ran.
      expect(h.wallets.sent).toHaveLength(0);

      // Trace order: prepared → score → simulation → guard → policy.
      const plan = await h.app.deps.prisma.actionPlan.findUniqueOrThrow({
        where: { id: r.planId! },
        include: { agentRequest: true },
      });
      const titles = (
        await h.app.deps.prisma.traceEventRow.findMany({
          where: { traceId: plan.agentRequest.traceId },
          orderBy: { ts: 'asc' },
        })
      ).map((e) => `${e.kind}:${e.title}`);
      const idx = (prefix: string) => titles.findIndex((t) => t.startsWith(prefix));
      expect(idx('plan:Prepared')).toBeGreaterThan(-1);
      expect(idx('plan:Prepared')).toBeLessThan(idx('score:Trade safety score'));
      expect(idx('score:Trade')).toBeLessThan(idx('simulation:Simulation passed'));
      expect(idx('simulation:')).toBeLessThan(idx('guard:Guard approved'));
      expect(idx('guard:Guard approved')).toBeLessThan(idx('policy:Policy: AUTO'));

      expect(await h.exec(r.planId!)).toBe('executed');
      const executions = await h.app.deps.prisma.execution.findMany({
        where: { actionPlanId: r.planId! },
      });
      expect(executions).toHaveLength(1);
      expect(executions[0]).toMatchObject({
        kind: 'SWAP',
        status: 'CONFIRMED',
        approvedBy: 'AGENT',
        idempotencyKey: `${r.planId}:0`,
      });
      expect(executions[0]!.usdValue.toString()).toBe('5');
      expect(h.wallets.sent).toHaveLength(1);
      expect(
        (await h.app.deps.prisma.actionPlan.findUniqueOrThrow({ where: { id: r.planId! } })).status,
      ).toBe('EXECUTED');
      const lot = await h.app.deps.prisma.tokenLot.findFirstOrThrow({
        where: { userId: h.userId, source: 'SWAP' },
      });
      expect(lot).toMatchObject({ tokenAddress: USDC, amountRaw: '5000000' });

      const receiptMsg = await h.app.deps.prisma.chatMessage.findFirstOrThrow({
        where: { userId: h.userId, text: { startsWith: 'Done:' } },
      });
      const receipt = (receiptMsg.cards as Record<string, unknown>[])[0]!;
      expect(receipt).toMatchObject({
        type: 'receipt',
        approvedBy: 'AGENT',
        decisionLog: { status: 'PENDING' },
      });
      expect((receipt.txs as { explorerUrl: string }[])[0]!.explorerUrl).toMatch(
        /^https:\/\/sepolia\.etherscan\.io\/tx\/0x/,
      );
      expect(h.jobs.logs).toContain(r.planId);

      // Decision log: upload (with one retry), stored hashes, card patched, round-trip equality.
      const storage = new FakeStorage();
      storage.failTimes = 1;
      const logDeps = {
        prisma: h.app.deps.prisma,
        storage,
        traceBus: h.app.deps.traceBus,
        env: h.app.deps.env,
      };
      await expect(uploadDecisionLog(logDeps, r.planId!)).rejects.toThrow('indexer unavailable');
      expect(await uploadDecisionLog(logDeps, r.planId!)).toBe('uploaded');
      expect(await uploadDecisionLog(logDeps, r.planId!)).toBe('already_uploaded');
      const log = await h.app.deps.prisma.decisionLog.findUniqueOrThrow({
        where: { actionPlanId: r.planId! },
      });
      expect(log).toMatchObject({ status: 'UPLOADED', attempts: 2 });
      expect(new TextDecoder().decode(await storage.download(log.zgRootHash!))).toBe(
        canonicalJson(log.payload),
      );
      const payload = log.payload as Record<string, unknown>;
      expect(payload).toMatchObject({
        version: 1,
        planHash: plan.planHash,
        policy: { outcome: 'AUTO' },
      });
      expect(JSON.stringify(payload)).not.toContain(h.token);
      expect((payload.inferences as { zgRequestId: string }[]).every((i) => i.zgRequestId)).toBe(
        true,
      );
      const patched = await h.app.deps.prisma.chatMessage.findUniqueOrThrow({
        where: { id: receiptMsg.id },
      });
      expect((patched.cards as Record<string, unknown>[])[0]).toMatchObject({
        decisionLog: { status: 'UPLOADED', rootHash: log.zgRootHash },
      });

      const view = await h.app.inject({
        method: 'GET',
        url: `/plans/${r.planId}`,
        headers: auth(h),
      });
      expect(view.statusCode).toBe(200);
      expect(view.json()).toMatchObject({
        status: 'EXECUTED',
        decisionLog: { status: 'UPLOADED' },
        executions: [{ status: 'CONFIRMED' }],
      });
      const dl = await h.app.inject({
        method: 'GET',
        url: `/decision-logs/${r.planId}`,
        headers: auth(h),
      });
      expect(dl.json()).toMatchObject({ rootHash: log.zgRootHash, payloadHash: log.payloadHash });
    } finally {
      await h.close();
    }
  });

  it('"Swap $60" → approval card → Deny → nothing traded; ask again → dev approve → executes', async () => {
    const h = await harness();
    try {
      const r = await h.ask(swapUsd(60));
      expect(r.status).toBe('AWAITING_APPROVAL');
      const card = r.cards.find((c) => c.type === 'approval')!;
      expect(card).toMatchObject({ status: 'PENDING', providerKind: 'dev', amountUsd: '60.00' });
      expect(card.reasons).toEqual([
        expect.objectContaining({ code: 'OVER_PER_ACTION_LIMIT', value: 60, limit: 25 }),
      ]);
      expect(h.jobs.executions).toHaveLength(0);

      const deny = await h.app.inject({
        method: 'POST',
        url: `/approvals/${card.approvalId}/deny`,
        headers: auth(h),
      });
      expect(deny.statusCode).toBe(200);
      expect(deny.json()).toMatchObject({ status: 'DENIED' });
      expect(await h.app.deps.prisma.execution.count({ where: { actionPlanId: r.planId! } })).toBe(
        0,
      );
      expect(
        await h.app.deps.prisma.chatMessage.count({
          where: { userId: h.userId, text: 'Denied — nothing was traded.' },
        }),
      ).toBe(1);
      expect(await h.exec(r.planId!)).toBe('skipped');
      expect(h.wallets.sent).toHaveLength(0);
      // A second tap cannot flip it.
      expect(
        (
          await h.app.inject({
            method: 'POST',
            url: `/approvals/${card.approvalId}/dev-approve`,
            headers: auth(h),
          })
        ).statusCode,
      ).toBe(409);

      const again = await h.ask(swapUsd(60));
      const card2 = again.cards.find((c) => c.type === 'approval')!;
      const ok = await h.app.inject({
        method: 'POST',
        url: `/approvals/${card2.approvalId}/dev-approve`,
        headers: auth(h),
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ status: 'APPROVED' });
      const approval = await h.app.deps.prisma.approval.findUniqueOrThrow({
        where: { id: String(card2.approvalId) },
      });
      expect(approval).toMatchObject({ providerKind: 'dev', approvedByIss: 'dev' });
      expect(h.jobs.executions.map((e) => e.planId)).toEqual([again.planId]);
      expect(await h.exec(again.planId!)).toBe('executed');
      expect(
        (await h.app.deps.prisma.approval.findUniqueOrThrow({ where: { id: approval.id } })).status,
      ).toBe('USED');
      const ex = await h.app.deps.prisma.execution.findFirstOrThrow({
        where: { actionPlanId: again.planId! },
      });
      expect(ex).toMatchObject({ approvedBy: 'HUMAN', status: 'CONFIRMED' });
      // Single use: a second run does nothing.
      expect(await h.exec(again.planId!)).toBe('skipped');
      expect(h.wallets.sent).toHaveLength(1);
    } finally {
      await h.close();
    }
  });

  it('approval expiry, wrong human and plan-hash mismatch never execute', async () => {
    const h = await harness();
    try {
      const prisma = h.app.deps.prisma;
      // Expire.
      const a = await h.ask(swapUsd(60));
      const approvalId = String(a.cards.find((c) => c.type === 'approval')!.approvalId);
      await prisma.approval.update({
        where: { id: approvalId },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect(await h.app.deps.approvals.sweepExpired()).toBeGreaterThanOrEqual(1);
      expect((await prisma.approval.findUniqueOrThrow({ where: { id: approvalId } })).status).toBe(
        'EXPIRED',
      );
      expect((await prisma.actionPlan.findUniqueOrThrow({ where: { id: a.planId! } })).status).toBe(
        'EXPIRED',
      );
      expect(await h.exec(a.planId!)).toBe('skipped');

      // Wrong human: evidence for another sub is REJECTED.
      const b = await h.ask(swapUsd(60));
      const bId = String(b.cards.find((c) => c.type === 'approval')!.approvalId);
      const res = await h.app.deps.approvals.resolve(bId, 'APPROVED', {
        providerKind: 'dev',
        iss: 'dev',
        sub: 'someone-else',
        authTime: new Date(),
      });
      expect(res.status).toBe('REJECTED');
      expect(h.jobs.executions).toHaveLength(0);

      // Another user cannot even see the approval.
      const other = await devSignIn(h.app, uniqueName('intruder'));
      expect(
        (
          await h.app.inject({
            method: 'POST',
            url: `/approvals/${bId}/deny`,
            headers: { authorization: `Bearer ${other.token}` },
          })
        ).statusCode,
      ).toBe(404);

      // Hash mismatch: an approval bound to a different plan hash is refused at execution.
      const c = await h.ask(swapUsd(60));
      const cId = String(c.cards.find((x) => x.type === 'approval')!.approvalId);
      await h.app.inject({
        method: 'POST',
        url: `/approvals/${cId}/dev-approve`,
        headers: auth(h),
      });
      await prisma.approval.update({ where: { id: cId }, data: { planHash: 'f'.repeat(64) } });
      expect(await h.exec(c.planId!)).toBe('failed');
      expect(h.wallets.sent).toHaveLength(0);
      expect(await prisma.execution.count({ where: { userId: h.userId } })).toBe(0);
    } finally {
      await h.close();
    }
  });

  it('re-quote > 1% worse aborts with a "Price moved" card and can re-preview', async () => {
    const h = await harness();
    try {
      const r = await h.ask(swapUsd(5));
      h.market.eth = h.market.eth.times(0.98);
      expect(await h.exec(r.planId!)).toBe('price_moved');
      expect(h.wallets.sent).toHaveLength(0);
      const msg = await h.app.deps.prisma.chatMessage.findFirstOrThrow({
        where: { userId: h.userId, text: { startsWith: 'The price moved' } },
      });
      const card = (msg.cards as Record<string, unknown>[])[0]!;
      expect(card).toMatchObject({
        type: 'price_moved',
        symbol: 'USDC',
        previewAmount: '5',
        currentAmount: '4.9',
      });
      expect(card.worsePct as number).toBeCloseTo(2, 3);
      const re = await h.app.inject({
        method: 'POST',
        url: `/plans/${r.planId}/repreview`,
        headers: auth(h),
      });
      expect(re.statusCode).toBe(201);
      const fresh = re.json() as { planId: string; outcome: string };
      expect(fresh.outcome).toBe('AUTO');
      expect(fresh.planId).not.toBe(r.planId);
      expect(await h.exec(fresh.planId)).toBe('executed');
    } finally {
      await h.close();
    }
  });

  it('a re-quote within 1% still executes', async () => {
    const h = await harness();
    try {
      const r = await h.ask(swapUsd(5));
      h.market.eth = h.market.eth.times(0.995);
      expect(await h.exec(r.planId!)).toBe('executed');
    } finally {
      await h.close();
    }
  });

  it('a timed-out receipt is checked by hash on retry and never re-broadcast', async () => {
    const h = await harness();
    try {
      const r = await h.ask(swapUsd(5));
      h.wallets.onSend = (hash) => h.chain.pending.add(hash);
      await expect(h.exec(r.planId!)).rejects.toBeInstanceOf(PendingReceiptError);
      const row = await h.app.deps.prisma.execution.findFirstOrThrow({
        where: { actionPlanId: r.planId! },
      });
      expect(row).toMatchObject({ status: 'BROADCAST' });
      h.chain.pending.clear();
      h.wallets.onSend = () => undefined;
      expect(await h.exec(r.planId!)).toBe('executed');
      expect(h.wallets.sent).toHaveLength(1);
      expect(await h.app.deps.prisma.execution.count({ where: { actionPlanId: r.planId! } })).toBe(
        1,
      );
    } finally {
      await h.close();
    }
  });

  it('NEEDS_SIGNATURE: the Permit2 permit is signed only after approval, then the swap is sent', async () => {
    const h = await harness();
    try {
      const r = await h.ask({
        type: 'swap_exact_in',
        tokenIn: { symbol: 'USDC' },
        tokenOut: { symbol: 'ETH' },
        amountIn: '60',
        amountUsd: '60',
        reason: 'User asked',
      });
      const card = r.cards.find((c) => c.type === 'approval')!;
      expect(card).toBeDefined();
      expect(h.wallets.signed).toHaveLength(0);
      const plan = await h.app.deps.prisma.actionPlan.findUniqueOrThrow({
        where: { id: r.planId! },
      });
      const sim = plan.simulation as { steps: { deferred?: boolean }[] };
      expect(sim.steps).toHaveLength(1); // the approval preStep; the swap is built after signing
      await h.app.inject({
        method: 'POST',
        url: `/approvals/${card.approvalId}/dev-approve`,
        headers: auth(h),
      });
      expect(h.wallets.signed).toHaveLength(0);
      expect(await h.exec(r.planId!)).toBe('executed');
      expect(h.wallets.ops).toEqual([
        `send:${USDC.toLowerCase()}`,
        'sign',
        expect.stringMatching(/^send:0x/),
      ]);
      const rows = await h.app.deps.prisma.execution.findMany({
        where: { actionPlanId: r.planId! },
        orderBy: { stepIndex: 'asc' },
      });
      expect(rows.map((x) => x.kind)).toEqual(['APPROVAL', 'PERMIT_SIGN', 'SWAP']);
      expect(rows.map((x) => x.status)).toEqual(['CONFIRMED', 'SIGNED', 'CONFIRMED']);
      // The resume call carries the signature.
      const finalize = h.market.calls.filter((c) => c.name === 'build_swap').at(-1)!;
      expect(finalize.args).toMatchObject({
        signature: expect.stringMatching(/^0x/),
        resumeToken: expect.any(String),
      });
    } finally {
      await h.close();
    }
  });

  it('a token off the allowlist with no liquidity is REFUSED with reasons (and logged)', async () => {
    const h = await harness();
    try {
      const r = await h.ask({
        type: 'swap_exact_in',
        tokenIn: { symbol: 'ETH' },
        tokenOut: { address: SCAM },
        amountIn: '0.002',
        amountUsd: '5',
        reason: 'User asked',
      });
      expect(r.status).toBe('REFUSED');
      const card = r.cards.find((c) => c.type === 'refusal')!;
      const reasonCodes = (card.reasons as { code: string }[]).map((x) => x.code);
      expect(reasonCodes).toContain('UNSUPPORTED_TOKEN');
      expect(reasonCodes).toContain('BUILD_FAILED');
      expect(card.suggestion).toMatch(/allowlisted/);
      expect(h.jobs.logs).toEqual([r.planId]);
      expect(h.jobs.executions).toHaveLength(0);
      expect(h.script.decisions).toBe(0); // the guard is not consulted on incomplete facts
    } finally {
      await h.close();
    }
  });

  it('guard unavailable → refused ("Safety check unavailable"), nothing executes', async () => {
    const h = await harness();
    try {
      h.script.guard = 'error';
      const r = await h.ask(swapUsd(5));
      expect(r.status).toBe('REFUSED');
      const card = r.cards.find((c) => c.type === 'refusal')!;
      expect(card.reasons).toEqual([
        expect.objectContaining({ code: 'GUARD_UNAVAILABLE', message: 'Safety check unavailable' }),
      ]);
      expect(h.jobs.executions).toHaveLength(0);
    } finally {
      await h.close();
    }
  });

  it('a reverted simulation refuses before approval', async () => {
    const h = await harness();
    try {
      h.chain.revert = () => 'insufficient funds';
      const r = await h.ask(swapUsd(5));
      expect(r.status).toBe('REFUSED');
      expect(
        (r.cards.find((c) => c.type === 'refusal')!.reasons as { code: string }[])[0]!.code,
      ).toBe('SIMULATION_REVERTED');
    } finally {
      await h.close();
    }
  });

  it('Cancel during the countdown stops an AUTO action; too late → 409', async () => {
    const h = await harness();
    try {
      const r = await h.ask(swapUsd(5));
      const cancel = await h.app.inject({
        method: 'POST',
        url: `/plans/${r.planId}/cancel`,
        headers: auth(h),
      });
      expect(cancel.statusCode).toBe(200);
      expect(await h.exec(r.planId!)).toBe('skipped');
      expect(h.wallets.sent).toHaveLength(0);
      const again = await h.app.inject({
        method: 'POST',
        url: `/plans/${r.planId}/cancel`,
        headers: auth(h),
      });
      expect(again.statusCode).toBe(409);
    } finally {
      await h.close();
    }
  });

  it('withdrawals always need the human; the recipient becomes known after an approved send', async () => {
    const h = await harness();
    try {
      const to = '0x00000000000000000000000000000000000000Aa';
      const send = {
        type: 'transfer',
        token: { symbol: 'USDC' },
        amount: '2',
        recipient: to,
        amountUsd: '2',
        reason: 'Send',
      };
      const r = await h.ask(send);
      const card = r.cards.find((c) => c.type === 'approval')!;
      expect((card.reasons as { code: string }[]).map((x) => x.code)).toEqual([
        'WITHDRAWAL',
        'NEW_RECIPIENT',
      ]);
      await h.app.inject({
        method: 'POST',
        url: `/approvals/${card.approvalId}/dev-approve`,
        headers: auth(h),
      });
      expect(await h.exec(r.planId!)).toBe('executed');
      expect(await h.app.deps.prisma.knownRecipient.count({ where: { userId: h.userId } })).toBe(1);
      const second = await h.ask(send);
      expect(
        (second.cards.find((c) => c.type === 'approval')!.reasons as { code: string }[]).map(
          (x) => x.code,
        ),
      ).toEqual(['WITHDRAWAL']);
    } finally {
      await h.close();
    }
  });

  it("today's spend is re-checked at execution: over the daily limit → fresh approval, nothing sent", async () => {
    const h = await harness();
    try {
      const r = await h.ask(swapUsd(20));
      expect(r.status).toBe('QUEUED');
      // Meanwhile $90 of AUTO spend was recorded today.
      const filler = await h.app.deps.prisma.actionPlan.findUniqueOrThrow({
        where: { id: r.planId! },
      });
      await h.app.deps.prisma.execution.create({
        data: {
          actionPlanId: filler.id,
          userId: h.userId,
          stepIndex: 99,
          idempotencyKey: `filler-${filler.id}`,
          kind: 'SWAP',
          status: 'CONFIRMED',
          usdValue: '90',
          approvedBy: 'AGENT',
        },
      });
      expect(await h.exec(r.planId!)).toBe('stepped_up');
      expect(h.wallets.sent).toHaveLength(0);
      const approval = await h.app.deps.prisma.approval.findUniqueOrThrow({
        where: { actionPlanId: r.planId! },
      });
      expect(approval.status).toBe('PENDING');
      expect(approval.reason).toMatch(/daily limit/);
    } finally {
      await h.close();
    }
  });

  it('"Put $100 into ETH/USDC" picks the pool and records the minted position', async () => {
    const h = await harness();
    try {
      const minted = BigInt(Math.floor(Math.random() * 1e12));
      h.wallets.onSend = (hash, tx) => {
        if (tx.to.toLowerCase() === POSITION_MANAGER.toLowerCase())
          h.chain.logs.set(hash, [mintLog(h.walletAddress, minted)]);
      };
      const r = await h.ask({
        type: 'lp_open',
        token0: { symbol: 'ETH' },
        token1: { symbol: 'USDC' },
        amountUsd: '100',
        rangePreset: 'balanced',
        reason: 'LP',
      });
      expect(h.market.calls.map((c) => c.name)).toEqual(
        expect.arrayContaining(['compare_pools', 'build_lp_position']),
      );
      const build = h.market.calls.find((c) => c.name === 'build_lp_position')!;
      expect(build.args).toMatchObject({
        range: { preset: 'medium' },
        independentToken: { token: '0x0000000000000000000000000000000000000000', amount: '0.02' },
      });
      const card = r.cards.find((c) => c.type === 'approval')!;
      expect(card.amountUsd).toBe('100.00');
      await h.app.inject({
        method: 'POST',
        url: `/approvals/${card.approvalId}/dev-approve`,
        headers: auth(h),
      });
      expect(await h.exec(r.planId!)).toBe('executed');
      const pos = await h.app.deps.prisma.lpPosition.findFirstOrThrow({
        where: { userId: h.userId },
      });
      expect(pos).toMatchObject({ tokenId: minted.toString(), status: 'OPEN', tickLower: -200000 });
    } finally {
      await h.close();
    }
  });
});
