#!/usr/bin/env node
/**
 * Live smoke test: can the Uniswap Trading API + LP API serve every flow Warden needs on the
 * execution chain? Run manually (hits real APIs):  pnpm smoke:uniswap
 * Reads UNISWAP_API_KEY and EXECUTION_CHAIN_ID from the environment (.env via --env-file).
 * Exits 1 if any check fails or a route breaches the 5% price-impact refuse limit.
 */
const KEY = process.env.UNISWAP_API_KEY;
const CHAIN = Number(process.env.EXECUTION_CHAIN_ID ?? 11155111);
if (!KEY) {
  console.error('UNISWAP_API_KEY is not set');
  process.exit(1);
}

// Circle USDC per execution testnet; WETH is needed for v3 LP pools (v4 uses native ETH).
const TOKENS = {
  11155111: {
    usdc: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238',
    weth: '0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14',
  },
  1301: {
    usdc: '0x31d0220469e10c4E71834a79b1f276d740d3768F',
    weth: '0x4200000000000000000000000000000000000006',
  },
  84532: {
    usdc: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    weth: '0x4200000000000000000000000000000000000006',
  },
};
const t = TOKENS[CHAIN];
if (!t) {
  console.error(`No token config for chain ${CHAIN}`);
  process.exit(1);
}
const ETH = '0x0000000000000000000000000000000000000000';
const SWAPPER = '0x000000000000000000000000000000000000dEaD';
const TRADE = 'https://trade-api.gateway.uniswap.org/v1';
const LP = 'https://liquidity.api.uniswap.org';
const REFUSE_IMPACT_PCT = 5;

async function post(base, path, body) {
  try {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'x-api-key': KEY, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(40_000),
    });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  } catch (err) {
    return { status: 0, json: { errorCode: String(err) } };
  }
}

const quote = (o) =>
  post(TRADE, '/quote', {
    tokenInChainId: CHAIN,
    tokenOutChainId: CHAIN,
    swapper: SWAPPER,
    slippageTolerance: 0.5,
    ...o,
  });

const results = [];
function record(name, ok, info) {
  results.push({ name, ok, info });
}
function recordQuote(name, r) {
  const q = r.json.quote;
  if (!q)
    return record(name, false, `${r.status} ${r.json.errorCode ?? ''} ${r.json.detail ?? ''}`);
  const impact = Number(q.priceImpact);
  const route = (q.route ?? [])
    .flat()
    .map((p) => `${p.type}/${p.fee}`)
    .join('>');
  record(name, impact <= REFUSE_IMPACT_PCT, `impact ${impact}% via ${route}`);
  return q;
}

const ethIn = recordQuote(
  'Swap 0.001 ETH -> USDC (exact in)',
  await quote({ type: 'EXACT_INPUT', amount: '1000000000000000', tokenIn: ETH, tokenOut: t.usdc }),
);
recordQuote(
  'Swap ETH -> exactly 1 USDC (exact out)',
  await quote({ type: 'EXACT_OUTPUT', amount: '1000000', tokenIn: ETH, tokenOut: t.usdc }),
);
recordQuote(
  'Swap 0.1 ETH -> USDC (large)',
  await quote({
    type: 'EXACT_INPUT',
    amount: '100000000000000000',
    tokenIn: ETH,
    tokenOut: t.usdc,
  }),
);
for (const usd of ['1', '20', '100']) {
  recordQuote(
    `Swap ${usd} USDC -> ETH`,
    await quote({
      type: 'EXACT_INPUT',
      amount: String(BigInt(usd) * 1_000_000n),
      tokenIn: t.usdc,
      tokenOut: ETH,
    }),
  );
}
recordQuote(
  'Swap 0.001 ETH -> USDC (V4 pools only)',
  await quote({
    type: 'EXACT_INPUT',
    amount: '1000000000000000',
    tokenIn: ETH,
    tokenOut: t.usdc,
    protocols: ['V4'],
  }),
);

const approval = await post(TRADE, '/check_approval', {
  walletAddress: SWAPPER,
  token: t.usdc,
  amount: '1000000',
  chainId: CHAIN,
});
record('/check_approval (USDC)', approval.status === 200, `HTTP ${approval.status}`);

if (ethIn) {
  const swap = await post(TRADE, '/swap', { quote: ethIn, simulateTransaction: false });
  const data = swap.json.swap?.data ?? '';
  record(
    '/swap builds a transaction',
    swap.status === 200 && data.length > 2,
    `to ${swap.json.swap?.to ?? '-'}`,
  );
}

for (const [proto, a, fee, tickSpacing] of [
  ['V3', t.weth, 3000, undefined],
  ['V4', ETH, 3000, 60],
  ['V4', ETH, 500, 10],
]) {
  const r = await post(LP, '/lp/pool_info', {
    protocol: proto,
    chainId: CHAIN,
    poolParameters: {
      tokenAddressA: a,
      tokenAddressB: t.usdc,
      fee,
      ...(tickSpacing ? { tickSpacing } : {}),
    },
  });
  const pools = r.json.pools;
  record(
    `/lp/pool_info ${proto} ETH/USDC fee ${fee}`,
    r.status === 200,
    Array.isArray(pools) ? `${pools.length} pool(s)` : `HTTP ${r.status}`,
  );
}

console.log(`Uniswap route smoke test — chain ${CHAIN}\n`);
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name.padEnd(40)} ${r.info}`);
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
