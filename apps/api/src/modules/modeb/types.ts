/**
 * Mode B detector contract (PHASE 08 §1). A detector is a pure function of this context: no I/O,
 * no clock, so every rule is table-testable. All reads happen once in context.ts.
 */
import type {
  ActionIntent,
  Decimal,
  HookBand,
  PortfolioResponse,
  RiskProfileSettings,
  SuggestionDetector,
  SuggestionSeverity,
  UniswapMcp,
} from '@warden/shared';

export interface MarketFacts {
  /** Reference ETH price: the demo override first, else the live mainnet quote. */
  ethPriceUsd: Decimal | null;
  ethHigh7dUsd: Decimal | null;
  /** Signed percent move of the reference price against one hour ago. */
  ethChange1hPct: Decimal | null;
}

/** Observable hook state compared between two points in time. */
export interface HookStateFacts {
  codeHash: string | null;
  implementation: string | null;
  owner: string | null;
  /** lpFee per poolId. */
  fees: Record<string, number>;
}

/** A hook the user has money in or has traded through, with the two states to compare. */
export interface HookExposure {
  hookAddress: string;
  /** Open positions in pools of this hook (LpPosition.id); empty = exposure by past trades. */
  positionIds: string[];
  previous: HookStateFacts;
  current: HookStateFacts;
}

/** A hook new to the user's pairs, with its what-if result. */
export interface NewHookFact {
  hookAddress: string;
  pair: string;
  band: HookBand;
  score: number;
  /** Quote through the hook vs the usual route, in percent (null = could not be quoted). */
  betterPct: Decimal | null;
  /** What it would be like to try it, as a chat request. */
  tryRequest: string;
}

export interface DetectorContext {
  now: Date;
  /** User's calendar day (YYYY-MM-DD) and wall clock. */
  localDay: string;
  localHour: number;
  localMinute: number;
  profile: Pick<RiskProfileSettings, 'dipBuyUsd'>;
  perActionUsd: Decimal;
  portfolio: Pick<PortfolioResponse, 'tokens' | 'lpPositions' | 'totalUsd'>;
  market: MarketFacts;
  usdc: {
    balance: Decimal;
    /** Last time USDC left the wallet (null = not since we started watching). */
    lastOutflowAt: Date | null;
    /** When we first saw USDC in the wallet. */
    heldSince: Date | null;
  };
  /** Consecutive checks out of range, by position tokenId. */
  outOfRangeChecks: Record<string, number>;
  /** compare_pools results by pairKey(). */
  pools: Record<string, UniswapMcp.ToolOutput<'compare_pools'>>;
  /** Estimated cost of moving a position, for the payback rule (null = unknown: never fires). */
  moveGasUsd: Decimal | null;
  newHooks: NewHookFact[];
  hookExposures: HookExposure[];
  /** Dedupe keys already used: a detector skips them and moves on to the next candidate. */
  seen: ReadonlySet<string>;
}

export interface DetectorEvent {
  detector: SuggestionDetector;
  /** One per window (PHASE 08 §1 table). */
  dedupeKey: string;
  severity: SuggestionSeverity;
  title: string;
  /** Deterministic one-liner: the template the explainer falls back to. */
  summary: string;
  /** Computed facts the explainer may cite. */
  facts: Record<string, string | number | boolean | null>;
  /** Null = information only. */
  intent: ActionIntent | null;
  /** Chat text for "Change"; defaults to the intent's request form. */
  prefill?: string;
}

export type Detector = (ctx: DetectorContext) => DetectorEvent | null;
