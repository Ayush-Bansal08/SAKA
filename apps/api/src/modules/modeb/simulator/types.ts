/**
 * Simulator event model. A scenario is conditions only: nothing here may name a decision, and
 * nothing the pipeline reads can carry an expected outcome.
 */
import type { SimulatorScenarioId, SuggestionDetector, SuggestionSeverity } from '@warden/shared';

export type EventSource = 'LIVE' | 'SIMULATED';

export interface AgentEvent {
  eventId: string;
  eventType: 'MARKET_PRICE_CHANGE' | 'LP_OPPORTUNITY_DETECTED';
  timestamp: string;
  source: EventSource;
  subject: { asset?: string; positionId?: string; poolAddress?: string };
  payload: Record<string, unknown>;
  scenario: { id: SimulatorScenarioId; label: string; runId: string };
}

/** Oldest first, as multiples of the real ETH price; the last point is the scenario price. */
export type PricePath = Readonly<Record<'1h' | '24h' | '7d', readonly string[]>>;

export interface LpConditions {
  /** Used only when the user has no open position; labeled as an assumption. */
  assumedPositionUsd: string;
  currentAprPct: string;
  candidateAprPct: string;
  candidatePoolId: string;
  candidateTvlUsd: string;
  candidateAgeHours: number;
  candidateVolume: string;
  migrationGasUsd: string;
  /** Slippage of the swap back to the pool's ratio, as a percent of the position. */
  migrationSlippagePct: string;
  hook: {
    address: string;
    score: number;
    band: 'CAUTION';
    owner: string;
    implementation: string;
    findings: readonly string[];
  };
}

export interface Scenario {
  id: SimulatorScenarioId;
  label: string;
  /** The conditions, as the panel shows them. */
  description: string;
  /** The live rule this event stands in for: its auto-act switch and its inbox category. */
  detector: Extract<SuggestionDetector, 'DIP' | 'BIG_MOVE' | 'BETTER_POOL'>;
  severity: SuggestionSeverity;
  eventType: AgentEvent['eventType'];
  subject: AgentEvent['subject'];
  /** What changed, in one line. */
  eventLine: string;
  prices: PricePath | null;
  /** Where ETH exposure sits against the labeled target. */
  allocation: 'BELOW_TARGET' | 'AT_OR_ABOVE_TARGET' | null;
  signals: Readonly<Record<string, string | number | boolean>>;
  lp: LpConditions | null;
}
