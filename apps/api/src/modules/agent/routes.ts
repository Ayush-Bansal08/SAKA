/**
 * Agent request entry (PHASE 04 §5) — planning only, nothing executes here.
 *   POST /agent/messages { text } → 202 { agentRequestId, traceId }; the planner runs async and
 *     its result is persisted as an AGENT ChatMessage (info answer or provisional IntentCard).
 *   GET  /agent/messages?cursor  → newest-first history, 30 per page.
 * Rate limit: 10 messages/min/user (Redis, shared by all API instances).
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  AgentMessageRequestSchema,
  CHAINS,
  Decimal,
  riskProfileSettings,
  UniswapMcp,
  type AgentMessageView,
  type Card,
} from '@warden/shared';
import { authOf, requireUser } from '../auth/require-user.js';
import { AppError } from '../../lib/errors.js';
import { ZgError } from '../ai0g/client.js';
import { plan, PlannerError } from './planner.js';
import {
  allowlistForPlanner,
  compactPortfolio,
  pendingIntentFrom,
  referencePrices,
  type PlannerContext,
} from './context.js';
import { describeIntent } from './describe.js';
import { factCards } from './fact-cards.js';
import { Explainer } from '../ai0g/explainer.js';
import { buildPortfolio } from '../portfolio/service.js';
import { REFERENCE_SWAPPER } from '../portfolio/market.js';
import { executionTokens } from '../wallet/tokens.js';
import { runPipeline } from './pipeline.js';
import { pipelineDepsFrom } from './plan-routes.js';

export const AGENT_RATE_LIMIT_PER_MIN = 10;
const HISTORY_MESSAGES = 12;
const PAGE_SIZE = 30;
const PLANNING_LOCK_SECONDS = 600;
const GENERIC_FAILURE =
  'Your agent could not complete this plan. Please try again or clarify the amount and tokens.';

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

export const agentRoutes: FastifyPluginAsyncZod = async (app) => {
  const { env, prisma, redis, traceBus, mcp, prices, balances } = app.deps;
  const client = app.deps.zg;
  const pending = new Set<Promise<void>>();
  app.addHook('onClose', async () => {
    await Promise.allSettled(pending);
  });

  app.post(
    '/agent/messages',
    { preHandler: requireUser, schema: { body: AgentMessageRequestSchema.strict() } },
    async (request, reply) => {
      const { user } = authOf(request);
      if (!client || !mcp)
        throw new AppError('SERVICE_UNAVAILABLE', 503, 'The agent is not configured yet.');
      const count = Number(
        await redis.eval(
          "local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],60) end; return n",
          1,
          `agent:rate:${user.id}`,
        ),
      );
      if (count > AGENT_RATE_LIMIT_PER_MIN)
        throw new AppError(
          'RATE_LIMITED',
          429,
          'Please wait a minute before sending another message.',
        );
      const traceId = randomUUID();
      const lockKey = `agent:planning:${user.id}`;
      if (!(await redis.set(lockKey, traceId, 'EX', PLANNING_LOCK_SECONDS, 'NX')))
        throw new AppError('CONFLICT', 409, 'Your agent is still planning. Please wait.');

      let agentRequest;
      try {
        agentRequest = await prisma.$transaction(async (tx) => {
          const row = await tx.agentRequest.create({
            data: {
              userId: user.id,
              channel: 'WEB',
              input: { text: request.body.text },
              traceId,
              status: 'PLANNING',
            },
          });
          await tx.chatMessage.create({
            data: {
              userId: user.id,
              role: 'USER',
              text: request.body.text,
              traceId,
              requestId: row.id,
            },
          });
          return row;
        });
      } catch (err) {
        await redis.del(lockKey);
        throw err;
      }
      const ctx = { userId: user.id, traceId, agentRequestId: agentRequest.id };
      // Release as soon as the reply is stored, so the next message is accepted right away.
      // Compare-and-delete: idempotent and never frees a lock held by a newer request.
      const releaseLock = () =>
        redis.eval(
          "if redis.call('GET',KEYS[1])==ARGV[1] then return redis.call('DEL',KEYS[1]) end return 0",
          1,
          lockKey,
          traceId,
        );

      const work = async () => {
        let persisted = false;
        try {
          await traceBus.emit({ ...ctx, kind: 'plan', title: 'Planning on 0G' });
          const [history, wallet, knownRecipients, triggers] = await Promise.all([
            prisma.chatMessage.findMany({
              where: { userId: user.id },
              orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
              take: HISTORY_MESSAGES,
            }),
            prisma.agentWallet.findUnique({ where: { userId: user.id } }),
            prisma.knownRecipient.findMany({ where: { userId: user.id }, take: 30 }),
            prisma.trigger.findMany({ where: { userId: user.id, status: 'ACTIVE' }, take: 20 }),
          ]);
          const tokens = executionTokens(env.EXECUTION_CHAIN_ID, env.TOKEN_ALLOWLIST_JSON);
          const [portfolio, referencePricesUsd] = await Promise.all([
            buildPortfolio(
              {
                prisma,
                prices,
                balances,
                chainId: env.EXECUTION_CHAIN_ID,
                allowlist: env.TOKEN_ALLOWLIST_JSON,
                mcp: mcp,
              },
              user,
              wallet,
            ),
            referencePrices(tokens, (symbol) => prices.usd(symbol)),
          ]);
          // An edit ("make it $30") refers to the plan in the latest agent reply.
          const lastAgent = history.find((m) => m.role === 'AGENT');
          const pendingIntent = pendingIntentFrom(lastAgent?.cards);
          const context: PlannerContext = {
            chainId: env.EXECUTION_CHAIN_ID,
            chainName: CHAINS[env.EXECUTION_CHAIN_ID].name,
            wallet: wallet?.address ?? null,
            quoteSwapper: wallet?.address ?? REFERENCE_SWAPPER,
            riskProfile: user.riskProfile,
            limits: {
              perActionUsd: portfolio.limits.perActionUsd,
              perDayUsd: portfolio.limits.perDayUsd,
              usedTodayUsd: portfolio.limits.usedTodayUsd,
              remainingTodayUsd: portfolio.limits.remainingTodayUsd,
              maxSlippagePct: riskProfileSettings(user.riskProfile).maxSlippagePct,
            },
            portfolio: compactPortfolio(portfolio),
            referencePricesUsd,
            knownRecipients: knownRecipients.map((r) => r.address),
            activeTriggers: triggers.map((t) => ({ id: t.id, kind: t.kind, spec: t.spec })),
            tokenAllowlist: allowlistForPlanner(tokens),
            ...(pendingIntent ? { pendingIntent } : {}),
          };
          const result = await plan(
            client,
            mcp,
            ctx,
            context,
            history
              .slice()
              .reverse()
              .filter((m) => m.role !== 'SYSTEM')
              .map((m) => ({
                role: m.role === 'USER' ? ('user' as const) : ('assistant' as const),
                content: m.text,
              })),
          );
          // PHASE 05: money-moving intents and triggers go through the one pipeline.
          let text: string;
          let cards: unknown[];
          let requestStatus: 'DONE' | null = 'DONE';
          let afterReply: () => Promise<void> = async () => undefined;
          if (result.kind === 'intent') {
            const intentCard = { type: 'intent', intent: result.intent, zg: result.zg };
            const deps = pipelineDepsFrom(app.deps);
            if (!wallet || !deps) {
              text = `Planned: ${describeIntent(result.intent)}. Create your agent wallet (onboarding) before it can run.`;
              cards = [intentCard, { type: 'info', title: 'Agent wallet needed', body: text }];
            } else {
              const pipeline = await runPipeline(deps, {
                ctx,
                user,
                wallet,
                intent: result.intent,
                origin: 'user',
                channel: 'WEB',
                portfolioUsd: new Decimal(portfolio.totalUsd),
                zg: result.zg,
              });
              text = pipeline.text;
              cards = [intentCard, ...(pipeline.cards as Card[])];
              afterReply = pipeline.afterReply;
              // The pipeline already set the request status (QUEUED, AWAITING_APPROVAL, REFUSED…).
              if (pipeline.planId) requestStatus = null;
            }
          } else {
            text = result.text;
            const facts = factCards(result.facts, { userText: request.body.text, portfolio });
            // The pool pick is explained by 0G (template fallback when the explainer is down).
            const poolFact = result.facts.find((f) => f.tool === 'compare_pools');
            const pools = poolFact
              ? UniswapMcp.TOOL_OUTPUT_SCHEMAS.compare_pools.safeParse(poolFact.output)
              : null;
            if (pools?.success) {
              const pick = await new Explainer(client, ctx).explainPoolPick(pools.data);
              for (const card of facts)
                if ((card.data as { kind?: string } | undefined)?.kind === 'pool_compare')
                  card.body = pick;
            }
            cards = [
              { type: 'info', title: 'Agent reply', body: result.text, zg: result.zg },
              // Deterministic facts from the tools the planner used (PHASE 06 InfoCard).
              ...facts,
              // Tool facts supersede the model's own summary cards (no duplicate answers).
              ...(facts.length ? [] : (result.cards ?? [])),
            ];
          }
          await prisma.$transaction([
            prisma.chatMessage.create({
              data: {
                userId: user.id,
                role: 'AGENT',
                text,
                cards: json(cards),
                traceId,
                requestId: agentRequest.id,
              },
            }),
            ...(requestStatus
              ? [
                  prisma.agentRequest.update({
                    where: { id: agentRequest.id },
                    data: { status: requestStatus },
                  }),
                ]
              : []),
          ]);
          persisted = true;
          await releaseLock();
          await afterReply();
          await traceBus.emit({
            ...ctx,
            kind: 'plan',
            title: result.kind === 'intent' ? 'Proposed intent' : 'Agent reply',
            detail: text,
            zg: result.zg,
            data: result.kind === 'intent' ? { intent: result.intent } : { answer: result.text },
          });
        } catch (err) {
          // The reply is already stored: a late trace failure must not rewrite it as FAILED.
          if (persisted) {
            app.log.warn({ traceId }, 'agent reply stored; trace emit failed');
            return;
          }
          const text =
            err instanceof PlannerError || err instanceof ZgError ? err.message : GENERIC_FAILURE;
          app.log.warn(
            { traceId, err: err instanceof Error ? err.name : 'unknown' },
            'agent planning failed',
          );
          await prisma.$transaction([
            prisma.agentRequest.update({
              where: { id: agentRequest.id },
              data: { status: 'FAILED' },
            }),
            prisma.chatMessage.create({
              data: {
                userId: user.id,
                role: 'AGENT',
                text,
                cards: json([{ type: 'info', title: 'Planning failed', body: text }]),
                traceId,
                requestId: agentRequest.id,
              },
            }),
          ]);
          await releaseLock();
          await traceBus.emit({
            ...ctx,
            kind: 'error',
            title: 'Planning unavailable',
            detail: text,
          });
        } finally {
          await releaseLock();
        }
      };
      const task = work().catch(() => {
        app.log.error({ traceId }, 'Agent request failed');
      });
      pending.add(task);
      void task.finally(() => pending.delete(task));
      return reply.code(202).send({ agentRequestId: agentRequest.id, traceId });
    },
  );

  app.get(
    '/agent/messages',
    {
      preHandler: requireUser,
      schema: { querystring: z.object({ cursor: z.string().max(100).optional() }) },
    },
    async (request) => {
      const userId = authOf(request).user.id;
      const cursor = request.query.cursor
        ? await prisma.chatMessage.findFirst({ where: { id: request.query.cursor, userId } })
        : null;
      if (request.query.cursor && !cursor)
        throw new AppError('BAD_REQUEST', 400, 'Message cursor is invalid.');
      const rows = await prisma.chatMessage.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: PAGE_SIZE + 1,
        ...(cursor ? { cursor: { id: cursor.id }, skip: 1 } : {}),
      });
      const page = rows.slice(0, PAGE_SIZE);
      const messages: AgentMessageView[] = page.map((m) => ({
        id: m.id,
        role: m.role,
        text: m.text,
        cards: Array.isArray(m.cards) ? (m.cards as unknown[]) : null,
        traceId: m.traceId,
        createdAt: m.createdAt.toISOString(),
      }));
      return { messages, nextCursor: rows.length > PAGE_SIZE ? page.at(-1)!.id : null };
    },
  );
};
