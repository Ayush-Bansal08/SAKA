/**
 * Execution job (PHASE 05 §5). One plan at a time per user (Redis lock `lock:exec:<userId>`;
 * a busy lock throws a retryable error and BullMQ retries after a fixed delay).
 *
 *  1. Reserve: STEP_UP → approval APPROVED, unexpired, planHash match → USED, in the same DB
 *     transaction that sets the plan EXECUTING. AUTO → QUEUED → EXECUTING (Cancel lost the race
 *     if it is no longer QUEUED), with today's spend recomputed inside that transaction; over a
 *     limit now → the plan becomes a fresh step-up approval instead.
 *  2. Re-quote (get_quote): output worse than the preview by > 1% → "Price moved", nothing sent.
 *  3. Rebuild the same build call for fresh calldata and check it still matches the approved
 *     facts (tokens, recipient, exact amount, ≤ 1% drift). NEEDS_SIGNATURE → run the approval
 *     preSteps, sign the typed data with Privy (only now, after policy approval), call the tool
 *     again with resumeToken + signature.
 *  4. Every tx: simulate right before broadcast → Privy sendTransaction (idempotencyKey
 *     `${planId}:${stepIndex}`) → receipt (timeout → check by hash; never re-broadcast a step
 *     that has a hash — a retried job resumes from the recorded rows).
 *  5. Post-process (lots, LP positions, known recipient) → EXECUTED → receipt card → 0G log.
 * Any other failure → plan FAILED with a human-readable card; no silent partial state.
 */
import type {
  AgentWallet,
  ActionPlan,
  Approval,
  Execution,
  Prisma,
  PrismaClient,
  User,
} from '@prisma/client';
import {
  CHAINS,
  Decimal,
  explorerTxUrl,
  fromRaw,
  NATIVE_TOKEN_ADDRESS,
  REQUOTE_MAX_DRIFT_PCT,
  riskProfileSettings,
  executionContracts,
  type ExecutionChainId,
  type PolicyReason,
  type TraceEventInput,
  type TraceKind,
  type ZgProvenance,
  type ReceiptCard,
  type UniswapMcp,
} from '@warden/shared';
import type { Redis } from 'ioredis';
import { getAddress, type Hex } from 'viem';
import type { Env } from '../../config/env.js';
import { dayBoundsInZone } from '../../lib/time.js';
import { AppError } from '../../lib/errors.js';
import { patchPlanCards, postPlanMessage, setPreviewStatus } from '../agent/card-store.js';
import { describeIntent } from '../agent/describe.js';
import type { StoredSteps } from '../agent/preparer.js';
import type { DevApprovalProvider } from '../approvals/dev-approval-provider.js';
import { reasonText, type ApprovalsService } from '../approvals/service.js';
import type { McpCallContext, UniswapMcpClient } from '../mcp/client.js';
import type { TraceBus } from '../trace/trace-bus.js';
import type { WalletProvider } from '../wallet/privy.js';
import type { ChainClient, ChainReceipt } from './chain.js';
import type { JobQueues } from './jobs.js';

export interface ExecutorDeps {
  env: Env;
  prisma: PrismaClient;
  redis: Redis;
  mcp: UniswapMcpClient;
  wallets: WalletProvider | null;
  chain: ChainClient | null;
  traceBus: Pick<TraceBus, 'emit'>;
  jobs: JobQueues;
  approvals: ApprovalsService;
  approvalProvider: Pick<DevApprovalProvider, 'requestApproval' | 'kind'>;
  now?: () => Date;
}

/** Retry later (BullMQ backoff): another plan of this user holds the lock. */
export class LockBusyError extends Error {
  override name = 'LockBusyError';
}
/** Retry later: a broadcast tx has no receipt yet. The retry checks it by hash. */
export class PendingReceiptError extends Error {
  override name = 'PendingReceiptError';
}
/** A human-readable, final failure. */
export class ExecutionFailure extends Error {
  override name = 'ExecutionFailure';
}
class PriceMoved extends Error {
  constructor(
    readonly symbol: string,
    readonly preview: string,
    readonly current: string,
    readonly worsePct: number,
  ) {
    super('Price moved');
  }
}

export const LOCK_TTL_MS = 10 * 60_000;
export const execLockKey = (userId: string) => `lock:exec:${userId}`;
const MAIN_KINDS = new Set(['SWAP', 'TRANSFER', 'LP_CREATE', 'LP_DECREASE']);
const ERC20_TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

type PlanRow = ActionPlan & {
  approval: Approval | null;
  user: User & { wallet: AgentWallet | null };
  agentRequest: { traceId: string; id: string };
  executions: Execution[];
};

export type ExecuteOutcome =
  'executed' | 'skipped' | 'cancelled' | 'price_moved' | 'stepped_up' | 'failed';

export interface EmitInput {
  kind: TraceKind;
  title: string;
  detail?: string;
  data?: unknown;
  zg?: ZgProvenance;
}
export type Emit = (e: EmitInput) => Promise<unknown>;

const json = (v: unknown) => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const lower = (a: string) => a.toLowerCase();

/** Worse-by percentage of `current` vs `preview` (raw bigint), for the side that matters. */
export function driftWorsePct(preview: bigint, current: bigint, side: 'out' | 'in'): number {
  if (preview === 0n) return 0;
  const diff = side === 'out' ? preview - current : current - preview;
  if (diff <= 0n) return 0;
  return Number((diff * 1_000_000n) / preview) / 10_000;
}

export async function executePlan(deps: ExecutorDeps, planId: string): Promise<ExecuteOutcome> {
  const first = await deps.prisma.actionPlan.findUnique({
    where: { id: planId },
    select: { userId: true, status: true },
  });
  if (!first || !['QUEUED', 'APPROVED', 'EXECUTING'].includes(first.status)) return 'skipped';

  const lockKey = execLockKey(first.userId);
  if ((await deps.redis.set(lockKey, planId, 'PX', LOCK_TTL_MS, 'NX')) !== 'OK') {
    const holder = await deps.redis.get(lockKey);
    if (holder !== planId)
      throw new LockBusyError(`Another action of this user is executing (${holder ?? 'unknown'})`);
  }
  try {
    return await runLocked(deps, planId);
  } finally {
    await deps.redis.eval(
      "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
      1,
      lockKey,
      planId,
    );
  }
}

async function loadPlan(prisma: PrismaClient, planId: string): Promise<PlanRow> {
  return prisma.actionPlan.findUniqueOrThrow({
    where: { id: planId },
    include: {
      approval: true,
      user: { include: { wallet: true } },
      agentRequest: { select: { traceId: true, id: true } },
      executions: { orderBy: { stepIndex: 'asc' } },
    },
  });
}

async function runLocked(deps: ExecutorDeps, planId: string): Promise<ExecuteOutcome> {
  const now = deps.now?.() ?? new Date();
  let plan = await loadPlan(deps.prisma, planId);
  const traceId = plan.agentRequest.traceId;
  const ctx: McpCallContext = { traceId, userId: plan.userId };
  const emit: Emit = (e) =>
    deps.traceBus.emit({ ...e, traceId, userId: plan.userId } as TraceEventInput);

  // 1. Reserve ----------------------------------------------------------------------
  if (plan.status !== 'EXECUTING') {
    const reserved = await reserve(deps, plan, now);
    if (reserved.result === 'cancelled') return 'cancelled';
    if (reserved.result === 'refused') {
      await fail(deps, plan, reserved.message, emit);
      return 'failed';
    }
    if (reserved.result === 'stepped_up') {
      await stepUpAfterLimitChange(deps, plan, reserved.reasons, emit);
      return 'stepped_up';
    }
    plan = await loadPlan(deps.prisma, planId);
    await emit({
      kind: 'tx',
      title: 'Executing',
      detail:
        plan.policyOutcome === 'STEP_UP'
          ? 'Approval verified and used once.'
          : 'Within your limits — no approval needed.',
      data: { actionPlanId: plan.id },
    });
    await setPreviewStatus(deps.prisma, plan.id, 'EXECUTING');
  }

  try {
    if (!deps.wallets)
      throw new ExecutionFailure('Agent wallets are not configured on this server.');
    if (!deps.chain)
      throw new ExecutionFailure('No execution RPC is configured (EXECUTION_RPC_URL).');
    const wallet = plan.user.wallet;
    if (!wallet) throw new ExecutionFailure('This account has no agent wallet.');
    const run = new StepRunner(deps, plan, wallet, emit);
    await run.resume();

    const stored = plan.steps as unknown as StoredSteps;
    const finalSummaries: UniswapMcp.BuildSummary[] = [];

    // Phase 1: the main build call (skipped when a retried job already confirmed it).
    if (!run.hasConfirmedMain(stored.call.tool === 'build_rebalance' ? 'LP_DECREASE' : null)) {
      if (run.isFresh && stored.call.tool === 'build_swap')
        await requote(deps, plan, stored, ctx, emit);
      finalSummaries.push(await run.buildAndRun(stored.call, stored.summary, true));
    }
    // Phase 2 (rebalance): open the new position with the withdrawn tokens.
    if (stored.next && !run.hasConfirmedKind('LP_CREATE')) {
      finalSummaries.push(await run.buildAndRun(stored.next, null, false));
    }

    await postProcess(deps, plan, wallet, stored, finalSummaries, run.receipts);
    await finish(deps, plan, emit);
    return 'executed';
  } catch (err) {
    if (err instanceof PendingReceiptError || err instanceof LockBusyError) throw err;
    if (err instanceof PriceMoved) {
      await priceMoved(deps, plan, err, emit);
      return 'price_moved';
    }
    const message =
      err instanceof ExecutionFailure
        ? err.message
        : err instanceof AppError
          ? err.userMessage
          : 'Execution failed unexpectedly. Nothing further was sent.';
    await fail(deps, plan, message, emit);
    return 'failed';
  }
}

// ---------------------------------------------------------------------------
// 1. Reserve
// ---------------------------------------------------------------------------

type Reserve =
  | { result: 'ok' }
  | { result: 'cancelled' }
  | { result: 'refused'; message: string }
  | { result: 'stepped_up'; reasons: PolicyReason[] };

async function reserve(deps: ExecutorDeps, plan: PlanRow, now: Date): Promise<Reserve> {
  return deps.prisma.$transaction(async (tx) => {
    if (plan.policyOutcome === 'STEP_UP') {
      const a = plan.approval;
      if (!a || a.status !== 'APPROVED')
        return { result: 'refused', message: 'This action was not approved.' };
      if (a.expiresAt.getTime() <= now.getTime())
        return {
          result: 'refused',
          message: 'The approval expired before execution. Nothing was traded.',
        };
      if (a.planHash !== plan.planHash)
        return {
          result: 'refused',
          message: 'The approval does not match this plan. Nothing was traded.',
        };
      const used = await tx.approval.updateMany({
        where: { id: a.id, status: 'APPROVED' },
        data: { status: 'USED' },
      });
      if (used.count !== 1)
        return { result: 'refused', message: 'This approval was already used.' };
      const moved = await tx.actionPlan.updateMany({
        where: { id: plan.id, status: 'APPROVED' },
        data: { status: 'EXECUTING' },
      });
      if (moved.count !== 1) throw new ExecutionFailure('The plan changed state during execution.');
      await patchPlanCards(tx, plan.id, (c) =>
        c.type === 'approval' ? { ...c, status: 'USED' } : null,
      );
    } else {
      // AUTO: re-check today's spend inside this transaction (the per-user lock serialises it).
      const { start, end } = dayBoundsInZone(now, plan.user.timezone);
      const spent = await tx.execution.aggregate({
        _sum: { usdValue: true },
        where: {
          userId: plan.userId,
          approvedBy: 'AGENT',
          status: { in: ['SIGNED', 'BROADCAST', 'CONFIRMED'] },
          createdAt: { gte: start, lt: end },
        },
      });
      const limits = await tx.limits.findUnique({ where: { userId: plan.userId } });
      const profile = riskProfileSettings(plan.user.riskProfile);
      const perAction = new Decimal(limits?.perActionUsd.toString() ?? profile.perActionUsd);
      const perDay = new Decimal(limits?.perDayUsd.toString() ?? profile.perDayUsd);
      const amount = new Decimal(plan.amountUsd.toString());
      const after = new Decimal(spent._sum.usdValue?.toString() ?? '0').plus(amount);
      const reasons: PolicyReason[] = [];
      if (amount.gt(perAction))
        reasons.push({
          code: 'OVER_PER_ACTION_LIMIT',
          message: `Over your $${perAction.toString()} per-action limit`,
          value: amount.toNumber(),
          limit: perAction.toNumber(),
        });
      if (after.gt(perDay))
        reasons.push({
          code: 'OVER_DAILY_LIMIT',
          message: `Would bring today's agent spending to $${after.toDecimalPlaces(2).toFixed(2)}, over your $${perDay.toString()} daily limit`,
          value: after.toNumber(),
          limit: perDay.toNumber(),
        });
      if (reasons.length) {
        const moved = await tx.actionPlan.updateMany({
          where: { id: plan.id, status: 'QUEUED' },
          data: {
            status: 'AWAITING_APPROVAL',
            policyOutcome: 'STEP_UP',
            policyReasons: json(reasons),
          },
        });
        return moved.count === 1 ? { result: 'stepped_up', reasons } : { result: 'cancelled' };
      }
      const moved = await tx.actionPlan.updateMany({
        where: { id: plan.id, status: 'QUEUED' },
        data: { status: 'EXECUTING' },
      });
      if (moved.count !== 1) return { result: 'cancelled' };
    }
    await tx.agentRequest.update({
      where: { id: plan.agentRequestId },
      data: { status: 'EXECUTING' },
    });
    return { result: 'ok' };
  });
}

async function stepUpAfterLimitChange(
  deps: ExecutorDeps,
  plan: PlanRow,
  reasons: PolicyReason[],
  emit: Emit,
): Promise<void> {
  const approval = await deps.prisma.$transaction(async (tx) => {
    await tx.agentRequest.update({
      where: { id: plan.agentRequestId },
      data: { status: 'AWAITING_APPROVAL' },
    });
    return deps.approvals.create(tx, {
      planId: plan.id,
      userId: plan.userId,
      planHash: plan.planHash,
      amountUsd: plan.amountUsd.toString(),
      reasons,
      channel: 'WEB',
      providerKind: deps.approvalProvider.kind,
    });
  });
  await deps.approvalProvider.requestApproval(approval.id, 'web');
  await setPreviewStatus(deps.prisma, plan.id, 'AWAITING_APPROVAL');
  const intent = plan.intent as Parameters<typeof describeIntent>[0];
  await postPlanMessage(
    deps.prisma,
    plan.id,
    `Your limits changed since the preview — this now needs your approval: ${approval.reason}.`,
    [
      {
        type: 'approval',
        approvalId: approval.id,
        actionPlanId: plan.id,
        title: describeIntent(intent),
        summary: describeIntent(intent),
        reason: approval.reason,
        reasons,
        amountUsd: plan.amountUsd.toString(),
        status: 'PENDING',
        channel: approval.channel,
        providerKind: approval.providerKind,
        expiresAt: approval.expiresAt.toISOString(),
      },
    ],
  );
  await emit({
    kind: 'approval',
    title: 'Waiting for your approval',
    detail: reasonText(reasons),
    data: { approvalId: approval.id },
  });
}

// ---------------------------------------------------------------------------
// 2. Re-quote
// ---------------------------------------------------------------------------

async function requote(
  deps: ExecutorDeps,
  plan: PlanRow,
  stored: StoredSteps,
  ctx: McpCallContext,
  emit: Emit,
): Promise<void> {
  if (stored.call.tool !== 'build_swap' || !stored.summary) return;
  const a = stored.call.args;
  const q = await deps.mcp.callTool(
    'get_quote',
    {
      chainId: a.chainId,
      tokenIn: a.tokenIn,
      tokenOut: a.tokenOut,
      amount: a.amount,
      type: a.type,
      swapper: a.swapper,
      slippagePct: a.slippagePct,
    },
    ctx,
  );
  const s = stored.summary;
  const exactIn = a.type === 'EXACT_INPUT';
  const previewRaw = BigInt((exactIn ? s.amountOut?.raw : s.amountIn?.raw) ?? '0');
  const currentRaw = BigInt(exactIn ? q.amountOut.raw : q.amountIn.raw);
  const token = exactIn ? q.tokenOut : q.tokenIn;
  const worse = driftWorsePct(previewRaw, currentRaw, exactIn ? 'out' : 'in');
  await emit({
    kind: 'tx',
    title:
      worse > REQUOTE_MAX_DRIFT_PCT ? `Price moved ${worse.toFixed(2)}%` : 'Re-quote within 1%',
    detail: `${exactIn ? 'Output' : 'Input'} now ${fromRaw(currentRaw, token.decimals)} ${token.symbol} (preview ${fromRaw(previewRaw, token.decimals)}).`,
    data: { previewRaw: previewRaw.toString(), currentRaw: currentRaw.toString(), worsePct: worse },
  });
  if (worse > REQUOTE_MAX_DRIFT_PCT)
    throw new PriceMoved(
      token.symbol,
      fromRaw(previewRaw, token.decimals),
      fromRaw(currentRaw, token.decimals),
      worse,
    );
}

/** The rebuilt build still matches the approved facts (tokens, recipient, exact side, ≤ 1%). */
function checkRebuild(
  call: StoredSteps['call'],
  preview: UniswapMcp.BuildSummary | null,
  fresh: UniswapMcp.BuildSummary,
): void {
  if (!preview) return;
  const same = (a?: { address: string }, b?: { address: string }) =>
    !a || !b || lower(a.address) === lower(b.address);
  if (!same(preview.tokenIn, fresh.tokenIn) || !same(preview.tokenOut, fresh.tokenOut))
    throw new ExecutionFailure(
      'The rebuilt transaction uses different tokens than you approved. Nothing was sent.',
    );
  if (
    (preview.recipient ?? null) !== (fresh.recipient ?? null) &&
    lower(preview.recipient ?? '') !== lower(fresh.recipient ?? '')
  )
    throw new ExecutionFailure(
      'The rebuilt transaction sends to a different recipient. Nothing was sent.',
    );
  if (call.tool === 'build_swap') {
    const exactIn = call.args.type === 'EXACT_INPUT';
    const exactPreview = exactIn ? preview.amountIn?.raw : preview.amountOut?.raw;
    const exactFresh = exactIn ? fresh.amountIn?.raw : fresh.amountOut?.raw;
    if (exactPreview && exactFresh && exactPreview !== exactFresh)
      throw new ExecutionFailure(
        'The rebuilt swap amount differs from the approved one. Nothing was sent.',
      );
    const p = BigInt((exactIn ? preview.amountOut?.raw : preview.amountIn?.raw) ?? '0');
    const f = BigInt((exactIn ? fresh.amountOut?.raw : fresh.amountIn?.raw) ?? '0');
    const worse = driftWorsePct(p, f, exactIn ? 'out' : 'in');
    const token = exactIn ? fresh.tokenOut : fresh.tokenIn;
    if (worse > REQUOTE_MAX_DRIFT_PCT && token)
      throw new PriceMoved(
        token.symbol,
        fromRaw(p, token.decimals),
        fromRaw(f, token.decimals),
        worse,
      );
  }
  if (call.tool === 'build_transfer' && preview.amountIn?.raw !== fresh.amountIn?.raw)
    throw new ExecutionFailure(
      'The rebuilt transfer amount differs from the approved one. Nothing was sent.',
    );
  if (call.tool === 'build_lp_position' && preview.lp && fresh.lp) {
    for (const k of ['amount0', 'amount1'] as const) {
      const p = BigInt(preview.lp[k]?.raw ?? '0');
      const f = BigInt(fresh.lp[k]?.raw ?? '0');
      const drift = p === 0n ? 0 : Number(((f > p ? f - p : p - f) * 1_000_000n) / p) / 10_000;
      const token = k === 'amount0' ? fresh.lp.token0 : fresh.lp.token1;
      if (drift > REQUOTE_MAX_DRIFT_PCT)
        throw new PriceMoved(
          token.symbol,
          fromRaw(p, token.decimals),
          fromRaw(f, token.decimals),
          drift,
        );
    }
  }
}

// ---------------------------------------------------------------------------
// 3–4. Build, sign, simulate, broadcast, receipts
// ---------------------------------------------------------------------------

class StepRunner {
  readonly receipts: { execution: Execution; receipt: ChainReceipt }[] = [];
  private rows: Execution[];
  private readonly approvedBy: 'AGENT' | 'HUMAN';

  constructor(
    private readonly deps: ExecutorDeps,
    private readonly plan: PlanRow,
    private readonly wallet: AgentWallet,
    private readonly emit: Emit,
  ) {
    this.rows = [...plan.executions];
    this.approvedBy = plan.policyOutcome === 'STEP_UP' ? 'HUMAN' : 'AGENT';
  }

  /** True when this job sends the first transaction of the plan (no earlier attempt). */
  get isFresh(): boolean {
    return this.rows.length === 0;
  }

  hasConfirmedKind(kind: string): boolean {
    return this.rows.some((r) => r.kind === kind && r.status === 'CONFIRMED');
  }

  hasConfirmedMain(only: string | null): boolean {
    return this.rows.some(
      (r) => r.status === 'CONFIRMED' && (only ? r.kind === only : MAIN_KINDS.has(r.kind)),
    );
  }

  /** A retried job: settle every broadcast row by hash before doing anything else. */
  async resume(): Promise<void> {
    for (const row of this.rows) {
      if (row.status === 'FAILED' || row.status === 'REVERTED')
        throw new ExecutionFailure(row.error ?? 'An earlier step of this plan failed.');
      if (row.status === 'PENDING' && !row.txHash) {
        // Crashed between "about to send" and Privy's answer: Privy's idempotency key makes a
        // resend of the same key a no-op, but we never resend; treat it as unknown and stop.
        throw new ExecutionFailure(
          'An earlier attempt stopped before its transaction hash was recorded. Check your wallet before trying again.',
        );
      }
      if (row.status === 'BROADCAST' && row.txHash) {
        const receipt = await this.deps.chain!.getReceipt(row.txHash as Hex);
        if (!receipt) throw new PendingReceiptError(`Waiting for ${row.txHash}`);
        await this.settle(row, receipt);
      }
    }
  }

  private nextIndex(): number {
    return this.rows.reduce((m, r) => Math.max(m, r.stepIndex + 1), 0);
  }

  private ctx(): McpCallContext {
    return { traceId: this.plan.agentRequest.traceId, userId: this.plan.userId };
  }

  /** Build (fresh calldata), sign when needed, run every step. Returns the final summary. */
  async buildAndRun(
    call: StoredSteps['call'] | NonNullable<StoredSteps['next']>,
    preview: UniswapMcp.BuildSummary | null,
    isMain: boolean,
  ): Promise<UniswapMcp.BuildSummary> {
    const out = (await this.deps.mcp.callTool(
      call.tool,
      call.args as never,
      this.ctx(),
    )) as UniswapMcp.BuildResultObject;
    checkRebuild(call as StoredSteps['call'], preview, out.summary);
    let steps: UniswapMcp.TxStep[];
    let summary = out.summary;
    if (out.status === 'NEEDS_SIGNATURE') {
      for (const step of out.preSteps ?? []) await this.send(step, false);
      const signature = await this.sign(out.signature!);
      const final = (await this.deps.mcp.callTool(
        call.tool,
        { ...(call.args as object), resumeToken: out.resumeToken!, signature } as never,
        this.ctx(),
      )) as UniswapMcp.BuildResultObject;
      if (final.status !== 'READY' || !final.steps?.length)
        throw new ExecutionFailure('Uniswap did not return the final transaction after signing.');
      steps = final.steps;
      summary = final.summary;
    } else {
      steps = out.steps ?? [];
    }
    for (const step of steps) await this.send(step, isMain && MAIN_KINDS.has(step.kind));
    return summary;
  }

  private async sign(request: UniswapMcp.SignatureRequest): Promise<`0x${string}`> {
    const index = this.nextIndex();
    const row = await this.deps.prisma.execution.create({
      data: {
        actionPlanId: this.plan.id,
        userId: this.plan.userId,
        stepIndex: index,
        idempotencyKey: `${this.plan.id}:${index}`,
        kind: 'PERMIT_SIGN',
        status: 'PENDING',
        usdValue: '0',
        approvedBy: this.approvedBy,
      },
    });
    this.rows.push(row);
    const { signature } = await this.deps.wallets!.signTypedData(
      this.wallet.privyWalletId,
      request.typedData,
    );
    const signed = await this.deps.prisma.execution.update({
      where: { id: row.id },
      data: { status: 'SIGNED' },
    });
    this.rows[this.rows.length - 1] = signed;
    await this.emit({
      kind: 'tx',
      title:
        request.kind === 'PERMIT2' ? 'Signed the Permit2 permit' : 'Signed the v4 batch permit',
      detail: 'Signed by your agent wallet (Privy) after the policy approved this action.',
    });
    return signature;
  }

  private async send(step: UniswapMcp.TxStep, isMain: boolean): Promise<void> {
    const index = this.nextIndex();
    const key = `${this.plan.id}:${index}`;
    const tx = step.tx;
    const req = {
      account: getAddress(this.wallet.address),
      to: getAddress(tx.to),
      data: (tx.data || '0x') as Hex,
      value: BigInt(tx.value),
      ...(tx.gasLimit ? { gas: BigInt(tx.gasLimit) } : {}),
    };
    // Simulate right before broadcast: earlier steps are now real chain state.
    try {
      await this.deps.chain!.call(req);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      await this.emit({
        kind: 'simulation',
        title: 'Simulation failed before sending',
        detail: `${step.description}: ${reason}`,
      });
      throw new ExecutionFailure(
        `The final simulation failed (${step.description}): ${reason}. Nothing further was sent.`,
      );
    }
    const row = await this.deps.prisma.execution.create({
      data: {
        actionPlanId: this.plan.id,
        userId: this.plan.userId,
        stepIndex: index,
        idempotencyKey: key,
        kind: step.kind,
        status: 'PENDING',
        usdValue: isMain ? this.plan.amountUsd.toString() : '0',
        approvedBy: this.approvedBy,
      },
    });
    this.rows.push(row);
    let hash: `0x${string}`;
    try {
      ({ hash } = await this.deps.wallets!.sendTransaction(
        this.wallet.privyWalletId,
        {
          to: tx.to,
          data: tx.data,
          value: tx.value,
          chainId: tx.chainId,
          ...(tx.gasLimit ? { gasLimit: tx.gasLimit } : {}),
        },
        { idempotencyKey: key },
      ));
    } catch (err) {
      const message =
        err instanceof AppError
          ? err.userMessage
          : 'The wallet provider did not send the transaction.';
      await this.deps.prisma.execution.update({
        where: { id: row.id },
        data: { status: 'FAILED', error: message },
      });
      throw new ExecutionFailure(message);
    }
    const broadcast = await this.deps.prisma.execution.update({
      where: { id: row.id },
      data: { status: 'BROADCAST', txHash: hash },
    });
    this.rows[this.rows.length - 1] = broadcast;
    const chainId = this.deps.env.EXECUTION_CHAIN_ID as ExecutionChainId;
    await this.emit({
      kind: 'tx',
      title: `Sent: ${step.description}`,
      detail: `${hash} on ${CHAINS[chainId].name}`,
      data: { txHash: hash, explorerUrl: explorerTxUrl(chainId, hash), kind: step.kind },
    });
    const receipt =
      (await this.deps.chain!.waitForReceipt(hash, this.deps.env.RECEIPT_TIMEOUT_MS)) ??
      (await this.deps.chain!.getReceipt(hash));
    if (!receipt) throw new PendingReceiptError(`No receipt yet for ${hash}`);
    await this.settle(broadcast, receipt);
  }

  private async settle(row: Execution, receipt: ChainReceipt): Promise<void> {
    const status = receipt.status === 'success' ? 'CONFIRMED' : 'REVERTED';
    const updated = await this.deps.prisma.execution.update({
      where: { id: row.id },
      data: {
        status,
        gasUsed: receipt.gasUsed.toString(),
        effectiveGasPrice: receipt.effectiveGasPrice.toString(),
        blockNumber: receipt.blockNumber.toString(),
        ...(status === 'REVERTED' ? { error: 'Transaction reverted on-chain' } : {}),
      },
    });
    const i = this.rows.findIndex((r) => r.id === row.id);
    if (i >= 0) this.rows[i] = updated;
    this.receipts.push({ execution: updated, receipt });
    await this.emit({
      kind: 'receipt',
      title:
        status === 'CONFIRMED'
          ? `Confirmed in block ${receipt.blockNumber}`
          : 'Transaction reverted',
      data: { txHash: row.txHash, status },
    });
    if (status === 'REVERTED')
      throw new ExecutionFailure('A transaction reverted on-chain. Nothing further was sent.');
  }
}

// ---------------------------------------------------------------------------
// 5. Post-processing, finish, failure
// ---------------------------------------------------------------------------

/** FIFO consume `amountRaw` from the user's lots of `token` (pro-rata cost on a partial lot). */
async function consumeLots(
  tx: Prisma.TransactionClient,
  userId: string,
  token: string,
  amountRaw: bigint,
): Promise<Decimal> {
  let left = amountRaw;
  let consumedCost = new Decimal(0);
  const lots = await tx.tokenLot.findMany({
    where: { userId, tokenAddress: { equals: token, mode: 'insensitive' } },
    orderBy: { createdAt: 'asc' },
  });
  for (const lot of lots) {
    if (left <= 0n) break;
    const raw = BigInt(lot.amountRaw);
    const cost = new Decimal(lot.costUsd.toString());
    if (raw <= left) {
      left -= raw;
      consumedCost = consumedCost.plus(cost);
      await tx.tokenLot.delete({ where: { id: lot.id } });
    } else {
      const part = cost.times(left.toString()).div(raw.toString());
      consumedCost = consumedCost.plus(part);
      await tx.tokenLot.update({
        where: { id: lot.id },
        data: {
          amountRaw: (raw - left).toString(),
          costUsd: cost.minus(part).toDecimalPlaces(8).toFixed(8),
        },
      });
      left = 0n;
    }
  }
  return consumedCost;
}

/** Actual ERC-20 amount received by `to` in a receipt (null for native ETH / no log). */
function receivedFromLogs(
  receipts: { receipt: ChainReceipt }[],
  token: string,
  to: string,
): bigint | null {
  if (lower(token) === NATIVE_TOKEN_ADDRESS) return null;
  let sum = 0n;
  let seen = false;
  for (const { receipt } of receipts)
    for (const log of receipt.logs)
      if (
        lower(log.address) === lower(token) &&
        log.topics[0] === ERC20_TRANSFER &&
        log.topics[2] &&
        lower(`0x${log.topics[2].slice(26)}`) === lower(to)
      ) {
        sum += BigInt(log.data);
        seen = true;
      }
  return seen ? sum : null;
}

/** tokenId of the position NFT minted to `owner` (ERC-721 Transfer from 0x0) by PositionManager. */
export function mintedTokenId(
  receipts: { receipt: ChainReceipt }[],
  owner: string,
  positionManager: string,
): string | null {
  for (const { receipt } of receipts)
    for (const log of receipt.logs)
      if (
        lower(log.address) === lower(positionManager) &&
        log.topics[0] === ERC20_TRANSFER &&
        log.topics.length === 4 &&
        BigInt(log.topics[1]!) === 0n &&
        lower(`0x${log.topics[2]!.slice(26)}`) === lower(owner)
      )
        return BigInt(log.topics[3]!).toString();
  return null;
}

async function postProcess(
  deps: ExecutorDeps,
  plan: PlanRow,
  wallet: AgentWallet,
  stored: StoredSteps,
  summaries: UniswapMcp.BuildSummary[],
  receipts: { execution: Execution; receipt: ChainReceipt }[],
): Promise<void> {
  const amountUsd = new Decimal(plan.amountUsd.toString());
  const owner = getAddress(wallet.address);
  const chainId = deps.env.EXECUTION_CHAIN_ID;
  await deps.prisma.$transaction(async (tx) => {
    const s = summaries[0] ?? stored.summary;
    if (
      (stored.call.tool === 'build_swap' || stored.call.tool === 'build_transfer') &&
      s?.tokenIn &&
      s.amountIn
    ) {
      await consumeLots(tx, plan.userId, s.tokenIn.address, BigInt(s.amountIn.raw));
      const toSelf = stored.call.tool === 'build_swap' && !stored.recipient;
      if (toSelf && s.tokenOut && s.amountOut) {
        const actual =
          receivedFromLogs(receipts, s.tokenOut.address, owner) ?? BigInt(s.amountOut.raw);
        await tx.tokenLot.create({
          data: {
            userId: plan.userId,
            tokenAddress: getAddress(s.tokenOut.address),
            amountRaw: actual.toString(),
            costUsd: amountUsd.toFixed(8),
            source: 'SWAP',
          },
        });
      }
    }
    if (
      stored.lpPositionId &&
      (stored.call.tool === 'build_lp_exit' || stored.call.tool === 'build_rebalance')
    ) {
      const pos = await tx.lpPosition.findUnique({ where: { id: stored.lpPositionId } });
      if (pos) {
        const percent = stored.call.tool === 'build_lp_exit' ? stored.call.args.percent : 100;
        const share = new Decimal(percent).div(100);
        const releasedCost = new Decimal(pos.costBasisUsd.toString()).times(share);
        await tx.lpPosition.update({
          where: { id: pos.id },
          data:
            percent >= 100
              ? { status: 'CLOSED' }
              : {
                  costBasisUsd: new Decimal(pos.costBasisUsd.toString())
                    .minus(releasedCost)
                    .toFixed(8),
                },
        });
        const lp = summaries[0]?.lp;
        const parts = [
          lp?.amount0 ? { t: lp.token0, a: lp.amount0 } : null,
          lp?.amount1 ? { t: lp.token1, a: lp.amount1 } : null,
        ].filter((x): x is NonNullable<typeof x> => x !== null && x.a.raw !== '0');
        for (const part of parts)
          await tx.tokenLot.create({
            data: {
              userId: plan.userId,
              tokenAddress: getAddress(part.t.address),
              amountRaw: part.a.raw,
              costUsd: releasedCost.div(parts.length).toFixed(8),
              source: 'LP_EXIT',
            },
          });
      }
    }
    const created =
      stored.call.tool === 'build_lp_position'
        ? summaries[0]
        : stored.next
          ? summaries[1]
          : undefined;
    if (created?.lp) {
      const pm = executionContracts(chainId).positionManager;
      const tokenId = mintedTokenId(receipts, owner, pm);
      if (!tokenId)
        throw new ExecutionFailure(
          'The position was opened but its tokenId was not found in the receipt.',
        );
      for (const [t, a] of [
        [created.lp.token0, created.lp.amount0],
        [created.lp.token1, created.lp.amount1],
      ] as const)
        if (a) await consumeLots(tx, plan.userId, t.address, BigInt(a.raw));
      const openTx = receipts.find((r) => r.execution.kind === 'LP_CREATE')?.execution.txHash ?? '';
      const poolRef = stored.next ? stored.next.args.pool.poolReference : (stored.poolRef ?? '');
      await tx.lpPosition.create({
        data: {
          userId: plan.userId,
          chainId,
          protocol: 'V4',
          tokenId,
          poolId: poolRef,
          token0: getAddress(created.lp.token0.address),
          token1: getAddress(created.lp.token1.address),
          hookAddress: stored.hookAddress,
          tickLower: created.lp.tickLower ?? 0,
          tickUpper: created.lp.tickUpper ?? 0,
          openedTxHash: openTx,
          costBasisUsd: amountUsd.toFixed(8),
        },
      });
    }
    if (stored.recipient && plan.policyOutcome === 'STEP_UP') {
      const address = getAddress(stored.recipient);
      await tx.knownRecipient.upsert({
        where: { userId_address: { userId: plan.userId, address } },
        create: { userId: plan.userId, address },
        update: {},
      });
    }
  });
}

function txViews(deps: ExecutorDeps, rows: Execution[]): ReceiptCard['txs'] {
  const chainId = deps.env.EXECUTION_CHAIN_ID as ExecutionChainId;
  return rows
    .filter((r): r is Execution & { txHash: string } => r.txHash !== null)
    .map((r) => ({
      hash: r.txHash,
      kind: r.kind.toLowerCase() as ReceiptCard['txs'][number]['kind'],
      explorerUrl: explorerTxUrl(chainId, r.txHash),
      status:
        r.status === 'CONFIRMED' ? 'CONFIRMED' : r.status === 'REVERTED' ? 'REVERTED' : 'FAILED',
    }));
}

async function finish(deps: ExecutorDeps, plan: PlanRow, emit: Emit): Promise<void> {
  const rows = await deps.prisma.execution.findMany({
    where: { actionPlanId: plan.id },
    orderBy: { stepIndex: 'asc' },
  });
  await deps.prisma.$transaction([
    deps.prisma.actionPlan.update({ where: { id: plan.id }, data: { status: 'EXECUTED' } }),
    deps.prisma.agentRequest.update({
      where: { id: plan.agentRequestId },
      data: { status: 'DONE' },
    }),
  ]);
  await setPreviewStatus(deps.prisma, plan.id, 'EXECUTED');
  const intent = plan.intent as Parameters<typeof describeIntent>[0];
  const what = describeIntent(intent);
  const card: ReceiptCard = {
    type: 'receipt',
    actionPlanId: plan.id,
    title: `Done: ${what}`,
    summary: `${rows.filter((r) => r.txHash).length} transaction(s) confirmed. The decision record is being written to 0G Storage.`,
    amountUsd: new Decimal(plan.amountUsd.toString()).toFixed(2),
    approvedBy: plan.policyOutcome === 'STEP_UP' ? 'HUMAN' : 'AGENT',
    txs: txViews(deps, rows),
    decisionLog: { status: 'PENDING' },
  };
  await postPlanMessage(deps.prisma, plan.id, `Done: ${what}.`, [card]);
  await emit({
    kind: 'receipt',
    title: `Done: ${what}`,
    data: { actionPlanId: plan.id, txs: card.txs },
  });
  await deps.jobs.enqueueDecisionLog(plan.id);
}

async function fail(deps: ExecutorDeps, plan: PlanRow, message: string, emit: Emit): Promise<void> {
  const rows = await deps.prisma.execution.findMany({
    where: { actionPlanId: plan.id },
    orderBy: { stepIndex: 'asc' },
  });
  await deps.prisma.$transaction([
    deps.prisma.actionPlan.update({ where: { id: plan.id }, data: { status: 'FAILED' } }),
    deps.prisma.agentRequest.update({
      where: { id: plan.agentRequestId },
      data: { status: 'FAILED' },
    }),
  ]);
  await setPreviewStatus(deps.prisma, plan.id, 'FAILED');
  const sent = rows.filter((r) => r.txHash);
  await postPlanMessage(deps.prisma, plan.id, `Execution failed: ${message}`, [
    {
      type: 'failure',
      actionPlanId: plan.id,
      title: 'Execution failed',
      summary: sent.length
        ? `${message} ${sent.length} earlier transaction(s) were sent and are listed below.`
        : `${message} No transaction was sent.`,
      ...(sent.length ? { txs: txViews(deps, rows) } : {}),
      decisionLog: { status: 'PENDING' },
    },
  ]);
  await emit({
    kind: 'error',
    title: 'Execution failed',
    detail: message,
    data: { actionPlanId: plan.id },
  });
  await deps.jobs.enqueueDecisionLog(plan.id);
}

async function priceMoved(
  deps: ExecutorDeps,
  plan: PlanRow,
  moved: PriceMoved,
  emit: Emit,
): Promise<void> {
  await deps.prisma.$transaction([
    deps.prisma.actionPlan.update({ where: { id: plan.id }, data: { status: 'CANCELLED' } }),
    deps.prisma.agentRequest.update({
      where: { id: plan.agentRequestId },
      data: { status: 'CANCELLED' },
    }),
  ]);
  await setPreviewStatus(deps.prisma, plan.id, 'CANCELLED');
  const summary = `The price moved ${moved.worsePct.toFixed(2)}% against you since the preview (more than 1%), so nothing was traded.`;
  await postPlanMessage(deps.prisma, plan.id, summary, [
    {
      type: 'price_moved',
      actionPlanId: plan.id,
      title: 'Price moved — nothing was traded',
      summary,
      previewAmount: moved.preview,
      currentAmount: moved.current,
      symbol: moved.symbol,
      worsePct: Number(moved.worsePct.toFixed(4)),
    },
  ]);
  await emit({
    kind: 'error',
    title: 'Price moved — aborted',
    detail: summary,
    data: { actionPlanId: plan.id },
  });
  await deps.jobs.enqueueDecisionLog(plan.id);
}

/** Last retry used up (lock never freed, receipt never arrived): close the plan with a card. */
export async function abandonPlan(
  deps: ExecutorDeps,
  planId: string,
  reason: string,
): Promise<void> {
  const plan = await loadPlan(deps.prisma, planId).catch(() => null);
  if (!plan || ['EXECUTED', 'FAILED', 'CANCELLED', 'REFUSED', 'EXPIRED'].includes(plan.status))
    return;
  const emit: Emit = (e) =>
    deps.traceBus.emit({
      ...e,
      traceId: plan.agentRequest.traceId,
      userId: plan.userId,
    } as TraceEventInput);
  const pending = plan.executions.find((e) => e.status === 'BROADCAST' && e.txHash);
  const message = pending
    ? `Transaction ${pending.txHash} has no receipt yet (${reason}). It was not re-sent — check the explorer.`
    : `Your agent could not start this action (${reason}). Nothing was traded.`;
  await fail(deps, plan, message, emit);
}
