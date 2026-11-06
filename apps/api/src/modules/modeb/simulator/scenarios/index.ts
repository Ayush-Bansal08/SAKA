/** Scenario registry: adding a scenario is one file and one line here. */
import type { SimulatorScenarioId } from '@warden/shared';
import type { Scenario } from '../types.js';
import { ethCrashGuard } from './ethCrashGuard.js';
import { ethDip } from './ethDip.js';
import { lpMigrationNotWorthIt } from './lpMigrationNotWorthIt.js';

export const SCENARIOS: Readonly<Record<SimulatorScenarioId, Scenario>> = Object.freeze({
  ETH_DIP_STABILIZING: ethDip,
  ETH_CRASH_GUARD: ethCrashGuard,
  LP_MIGRATION_NOT_WORTH_IT: lpMigrationNotWorthIt,
});
