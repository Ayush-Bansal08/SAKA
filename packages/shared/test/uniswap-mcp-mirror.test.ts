import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { UniswapMcp } from '../src/index.js';

const mirror = fileURLToPath(new URL('../src/uniswap-mcp.ts', import.meta.url));
const source = fileURLToPath(new URL('../../uniswap-agent-mcp/src/schemas.ts', import.meta.url));

describe('UniswapMcp schemas mirror', () => {
  it.skipIf(!existsSync(source))('is byte-for-byte identical to the MCP package schemas', () => {
    const a = readFileSync(source, 'utf8').replace(/\r\n/g, '\n');
    const b = readFileSync(mirror, 'utf8').replace(/\r\n/g, '\n');
    // Fix with: pnpm --filter uniswap-agent-mcp sync:shared
    expect(b).toBe(a);
  });

  it('exposes 16 tools with input and output schemas', () => {
    expect(UniswapMcp.TOOL_NAMES).toHaveLength(16);
    for (const name of UniswapMcp.TOOL_NAMES) {
      expect(UniswapMcp.TOOL_INPUT_SCHEMAS[name]).toBeDefined();
      expect(UniswapMcp.TOOL_OUTPUT_SCHEMAS[name]).toBeDefined();
    }
  });

  it('validates a READY build result and rejects a malformed tx', () => {
    const step = {
      kind: 'SWAP',
      description: 'Swap',
      tx: {
        to: '0x7E4f6c5e954Da5c61B3423D81E2277431Ac043f3',
        from: '0xC9bebBA9f481b12cE6f3EA54c4B182c9636ec421',
        data: '0x3593564c',
        value: '0',
        chainId: 11155111,
      },
    };
    const ready = UniswapMcp.BuildResultSchema.parse({
      status: 'READY',
      steps: [step],
      summary: {},
    });
    expect(UniswapMcp.checkBuildResult(ready)).toEqual([]);
    expect(
      UniswapMcp.TxStepSchema.safeParse({ ...step, tx: { ...step.tx, data: 'nothex' } }).success,
    ).toBe(false);
  });
});
