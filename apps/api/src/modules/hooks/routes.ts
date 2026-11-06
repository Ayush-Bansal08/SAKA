/**
 * Hooks explorer API (PHASE 07 §1).
 *   GET /hooks?scope=market|execution&band=&fresh=&q=&sort=new|tvl|score&cursor=&limit=
 *   GET /hooks/:chainId/:address                     detail (breakdown, facts, pools, history)
 *   GET /hooks/:chainId/:address/what-if?pair=ETH-USDC&amountUsd=100
 *       quote through the hook pool (quote_pool) vs the default route (get_quote) — execution
 *       chain only; market hooks answer "Market data only".
 */
import type { Hook, HookPool, HookSnapshot, Inference, Prisma } from '@prisma/client';
import {
  HookListQuerySchema,
  HookWhatIfQuerySchema,
  UniswapMcp,
  type HookDetail,
  type HookListItem,
  type HookListResponse,
  type HookWhatIf,
} from '@warden/shared';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getAddress, isAddress } from 'viem';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { authOf, requireUser } from '../auth/require-user.js';
import { indexedAtKey } from './indexer.js';
import { hookWhatIf } from './what-if.js';

const MAINNET = 1;
const DAY_MS = 86_400_000;

interface StoredSnapshot {
  facts?: UniswapMcp.HookFacts;
  framework?: UniswapMcp.ToolOutput<'score_hook'>['framework'];
}

type Row = Hook & { pools?: HookPool[] };

function listItem(
  h: Row,
  pools: HookPool[],
  explanation: Inference | null,
  executionChainId: number,
): HookListItem {
  const perms = (h.flags ?? []) as { flag: string; risk: string }[];
  return {
    chainId: h.chainId,
    address: getAddress(h.address),
    name: h.contractName,
    score: h.score,
    band: h.band,
    permissions: perms.map((p) => ({ flag: p.flag, risk: p.risk })),
    pairs: pools.slice(0, 6).map((p) => ({
      poolId: p.poolId,
      token0: getAddress(p.token0),
      token1: getAddress(p.token1),
      token0Symbol: p.token0Symbol,
      token1Symbol: p.token1Symbol,
      fee: p.fee,
      tickSpacing: p.tickSpacing,
      tvlUsd: p.tvlUsd?.toString() ?? null,
    })),
    poolCount: Math.max(h.poolCount, pools.length),
    tvlUsd: h.tvlUsd?.toString() ?? null,
    ageDays: h.ageDays,
    firstSeenAt: h.firstSeenAt.toISOString(),
    lastCheckedAt: h.lastCheckedAt.toISOString(),
    explanation: h.explanation
      ? {
          text: h.explanation,
          model: explanation?.model ?? null,
          requestId: explanation?.zgRequestId ?? null,
          trustMode: explanation?.trustMode ?? null,
          teeVerified: explanation?.teeVerified ?? null,
        }
      : null,
    tradeable: h.chainId === executionChainId,
  };
}

async function poolsByHook(
  prisma: Prisma.TransactionClient,
  hooks: Hook[],
): Promise<Map<string, HookPool[]>> {
  const map = new Map<string, HookPool[]>();
  if (!hooks.length) return map;
  const rows = await prisma.hookPool.findMany({
    where: {
      OR: hooks.map((h) => ({
        chainId: h.chainId,
        hookAddress: { equals: h.address, mode: 'insensitive' as const },
      })),
    },
    orderBy: { tvlUsd: { sort: 'desc', nulls: 'last' } },
  });
  for (const r of rows) {
    const key = `${r.chainId}:${r.hookAddress.toLowerCase()}`;
    map.set(key, [...(map.get(key) ?? []), r]);
  }
  return map;
}

async function explanations(prisma: Prisma.TransactionClient, hooks: Hook[]) {
  const ids = hooks.map((h) => h.explanationInferenceId).filter((x): x is string => Boolean(x));
  const rows = ids.length ? await prisma.inference.findMany({ where: { id: { in: ids } } }) : [];
  return new Map(rows.map((r) => [r.id, r]));
}

export const hookRoutes: FastifyPluginAsyncZod = async (app) => {
  const { prisma, env, redis } = app.deps;
  const execChain = env.EXECUTION_CHAIN_ID;

  app.get(
    '/hooks',
    { preHandler: requireUser, schema: { querystring: HookListQuerySchema } },
    async (request): Promise<HookListResponse> => {
      const q = request.query;
      const chainId = q.scope === 'market' ? MAINNET : execChain;
      const and: Prisma.HookWhereInput[] = [{ chainId }];
      if (q.band) and.push({ band: q.band });
      if (q.fresh === 'true') and.push({ firstSeenAt: { gte: new Date(Date.now() - 7 * DAY_MS) } });
      if (q.q) {
        const term = q.q.trim();
        if (/^0x[0-9a-fA-F]{1,40}$/.test(term))
          and.push({ address: { startsWith: term, mode: 'insensitive' } });
        else {
          const pools = await prisma.hookPool.findMany({
            where: {
              chainId,
              OR: [
                { token0Symbol: { equals: term, mode: 'insensitive' } },
                { token1Symbol: { equals: term, mode: 'insensitive' } },
              ],
            },
            select: { hookAddress: true },
            take: 500,
          });
          and.push({
            OR: [
              { contractName: { contains: term, mode: 'insensitive' } },
              { address: { in: [...new Set(pools.map((p) => getAddress(p.hookAddress)))] } },
            ],
          });
        }
      }
      const orderBy: Prisma.HookOrderByWithRelationInput[] =
        q.sort === 'tvl'
          ? [{ tvlUsd: { sort: 'desc', nulls: 'last' } }, { firstSeenAt: 'desc' }]
          : q.sort === 'score'
            ? [{ score: 'desc' }, { firstSeenAt: 'desc' }]
            : [{ firstSeenAt: 'desc' }, { address: 'asc' }];
      const where = { AND: and };
      const offset = q.cursor ?? 0;
      const [total, hooks, indexedAt] = await Promise.all([
        prisma.hook.count({ where }),
        prisma.hook.findMany({ where, orderBy, skip: offset, take: q.limit }),
        redis.get(indexedAtKey(q.scope)),
      ]);
      const [pools, infs] = await Promise.all([
        poolsByHook(prisma, hooks),
        explanations(prisma, hooks),
      ]);
      return {
        scope: q.scope,
        chainId,
        hooks: hooks.map((h) =>
          listItem(
            h,
            pools.get(`${h.chainId}:${h.address.toLowerCase()}`) ?? [],
            h.explanationInferenceId ? (infs.get(h.explanationInferenceId) ?? null) : null,
            execChain,
          ),
        ),
        total,
        nextCursor: offset + hooks.length < total ? offset + hooks.length : null,
        indexedAt,
      };
    },
  );

  const Params = z.object({
    chainId: z.coerce.number().int().positive(),
    address: z.string().refine((a) => isAddress(a), 'Not an address'),
  });

  const loadHook = async (chainId: number, address: string) => {
    const hook = await prisma.hook.findUnique({
      where: { chainId_address: { chainId, address: getAddress(address) } },
      include: { snapshots: { orderBy: { takenAt: 'desc' }, take: 20 } },
    });
    if (!hook) throw AppError.notFound('This hook has not been indexed yet.');
    return hook;
  };

  app.get(
    '/hooks/:chainId/:address',
    { preHandler: requireUser, schema: { params: Params } },
    async (request): Promise<HookDetail> => {
      authOf(request);
      const hook = await loadHook(request.params.chainId, request.params.address);
      const [pools, infs] = await Promise.all([
        poolsByHook(prisma, [hook]),
        explanations(prisma, [hook]),
      ]);
      const base = listItem(
        hook,
        pools.get(`${hook.chainId}:${hook.address.toLowerCase()}`) ?? [],
        hook.explanationInferenceId ? (infs.get(hook.explanationInferenceId) ?? null) : null,
        execChain,
      );
      const snap = (hook.lastSnapshot ?? {}) as StoredSnapshot;
      const facts = snap.facts;
      const enabled = new Map(base.permissions.map((p) => [p.flag, p.risk]));
      const breakdown = (hook.scoreBreakdown ?? []) as HookDetail['breakdown'];
      return {
        ...base,
        // Full pool list on the detail page.
        pairs: (pools.get(`${hook.chainId}:${hook.address.toLowerCase()}`) ?? [])
          .slice(0, 50)
          .map((p) => ({
            poolId: p.poolId,
            token0: getAddress(p.token0),
            token1: getAddress(p.token1),
            token0Symbol: p.token0Symbol,
            token1Symbol: p.token1Symbol,
            fee: p.fee,
            tickSpacing: p.tickSpacing,
            tvlUsd: p.tvlUsd?.toString() ?? null,
          })),
        breakdown: breakdown.map((b) => ({
          rule: b.rule,
          // score_hook reports points deducted (positive); show penalties as negatives.
          penalty: -Math.abs(b.penalty),
          evidence: b.evidence,
          source: b.source ?? '',
        })),
        permissionGrid: UniswapMcp.HOOK_PERMISSION_FLAGS.map((flag) => ({
          flag,
          enabled: enabled.has(flag),
          risk: enabled.get(flag) ?? null,
        })),
        facts: {
          proxyKind: facts?.proxy.kind ?? null,
          upgradeable: facts?.proxy.upgradeable ?? hook.isProxy,
          implementation: hook.implementation,
          owner: hook.owner,
          verifiedSource: hook.verifiedSource,
          codeHash: hook.codeHash || null,
          contractName: hook.contractName,
          adminSelectors: facts?.adminSelectors ?? [],
        },
        frameworkTier: snap.framework?.riskScore.tierAtLeast ?? null,
        snapshots: hook.snapshots.map((s: HookSnapshot) => ({
          takenAt: s.takenAt.toISOString(),
          score: s.score,
          band: s.band,
          codeHash: s.codeHash,
          implementation: s.implementation,
          owner: s.owner,
          changes: (s.changes ?? []) as string[],
        })),
      };
    },
  );

  app.get(
    '/hooks/:chainId/:address/what-if',
    { preHandler: requireUser, schema: { params: Params, querystring: HookWhatIfQuerySchema } },
    async (request): Promise<HookWhatIf> => {
      return hookWhatIf(
        { prisma, mcp: app.deps.mcp, prices: app.deps.prices, executionChainId: execChain },
        {
          chainId: request.params.chainId,
          address: request.params.address,
          pair: request.query.pair,
          amountUsd: request.query.amountUsd,
          userId: authOf(request).user.id,
        },
      );
    },
  );
};
