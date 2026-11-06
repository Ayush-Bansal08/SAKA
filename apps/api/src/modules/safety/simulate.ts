/**
 * Simulation (PHASE 05 §2): eth_call of every READY step, in order, against the latest block,
 * from the agent wallet. A step that runs after an APPROVAL in the same sequence depends on
 * the allowance that approval creates, so it cannot be simulated in isolation: it is marked
 * `deferred` and simulated again at execution time, right before broadcast. Steps that need a
 * signature are not built yet and are always simulated at execution time.
 * No RPC configured → `unavailable` (the policy engine refuses: fail closed).
 */
import type { SimulationView } from '@warden/shared';
import type { ChainClient } from '../execution/chain.js';

export interface SimStep {
  kind: string;
  tx: { to: string; data: string; value: string; gasLimit?: string | undefined };
}

export async function simulateSteps(
  chain: ChainClient | null,
  account: `0x${string}`,
  steps: readonly SimStep[],
  opts: { deferAfterApproval?: boolean } = {},
): Promise<SimulationView> {
  if (!chain)
    return {
      ok: false,
      unavailable: true,
      error: 'No execution RPC is configured (EXECUTION_RPC_URL)',
      steps: [],
    };
  const out: SimulationView['steps'] = [];
  let approvalSeen = false;
  for (const [index, step] of steps.entries()) {
    if (approvalSeen && step.kind !== 'APPROVAL' && opts.deferAfterApproval !== false) {
      out.push({ index, ok: true, deferred: true });
      continue;
    }
    const req = {
      account,
      to: step.tx.to as `0x${string}`,
      data: (step.tx.data || '0x') as `0x${string}`,
      value: BigInt(step.tx.value),
      ...(step.tx.gasLimit ? { gas: BigInt(step.tx.gasLimit) } : {}),
    };
    try {
      await chain.call(req);
      const gas = await chain.estimateGas(req).catch(() => null);
      out.push({ index, ok: true, ...(gas !== null ? { gasEstimate: gas.toString() } : {}) });
    } catch (err) {
      const revertReason = err instanceof Error ? err.message : String(err);
      out.push({ index, ok: false, revertReason });
      return {
        ok: false,
        error: `step ${index + 1} (${step.kind.toLowerCase()}) reverted: ${revertReason}`,
        steps: out,
      };
    }
    if (step.kind === 'APPROVAL') approvalSeen = true;
  }
  return { ok: true, steps: out };
}
