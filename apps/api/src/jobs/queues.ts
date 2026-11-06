/** BullMQ queue names and repeatable job schedules shared by producers and the worker. */
export const QUEUES = {
  system: 'system',
  wallet: 'wallet',
  /** PHASE 05: one job per approved/AUTO plan (per-user Redis lock inside the job). */
  execute: 'execute',
  /** PHASE 05: decision-log uploads to 0G Storage. */
  decisionLog: 'decisionlog',
} as const;

export const JOBS = {
  heartbeat: 'heartbeat',
  /** PHASE 03: deposit detection + funding (every BALANCE_POLL_MS). */
  balanceWatch: 'balance-watch',
  /** PHASE 05: PENDING approvals past expiresAt → EXPIRED (every 15 s). */
  approvalSweep: 'approval-sweep',
  execute: 'execute',
  decisionLogUpload: 'decisionlog.upload',
} as const;

export const HEARTBEAT_EVERY_MS = 60_000;
export const APPROVAL_SWEEP_EVERY_MS = 15_000;
